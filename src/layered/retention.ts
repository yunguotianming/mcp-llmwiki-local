import { readdir, readFile, stat, unlink } from 'node:fs/promises'
import { watch, type FSWatcher } from 'node:fs'
import { setImmediate as nextTurn } from 'node:timers/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { safePath } from '../storage/paths.js'
import { readOptional } from '../storage/files.js'
import { hash, withRevocationLock, writeJson } from './files.js'
import { localDevice } from './devices.js'
import { resumeRevocationCleanup } from './revocation-cleanup.js'
import { pageObjectPath, readVersion, versionPage } from './objects.js'
import { readVectorRecord, storageJson, vectorPath, vectorUnavailable } from './vectors.js'
import { hasVectorMode, recordIdentity, sameIdentity } from './vector-identity.js'
import type { CurrentVersion, SnapshotManifest, SourceEntry } from './schema.js'

export const readerLeaseMs = 30000
export const readerRenewMs = 10000
interface ReaderLease { pid: number; device: string; version: string; expires_at: number }
const pins = new Map<string, Map<string, number>>()
function pinLocal(root: string, version: string) {
  const key = path.resolve(root), versions = pins.get(key) ?? new Map<string, number>()
  pins.set(key, versions); versions.set(version, (versions.get(version) ?? 0) + 1)
  let released = false, expiresAt = Date.now() + readerLeaseMs, failure: unknown
  let reader: Awaited<ReturnType<typeof registerReader>> | undefined, renewing: Promise<void> | undefined
  const assert = async () => {
    if (released || failure || Date.now() >= expiresAt) throw new Error('读者租约已失效，请重新读取。', { cause: failure })
    await reader?.assert()
  }
  // 短查询只固定内存。跨越发布的长读者在宽限期内补登记，模型等待期间不持锁。
  const timer = setInterval(() => {
    if (released || renewing) return
    renewing = (async () => {
      await assert()
      if (!reader && (await readOptional<CurrentVersion>(await safePath(root, 'state/current.json')))?.version !== version) {
        await withInventoryLock(root, async () => {
          if (released) return
          await assert()
          await readVersion(root, version)
          reader = await registerReader(root, version)
        })
      }
      expiresAt = Date.now() + readerLeaseMs
    })().catch(error => { failure = error }).finally(() => { renewing = undefined })
  }, readerRenewMs)
  timer.unref()
  return {
    assert,
    release: async () => {
      if (released) return
      released = true; clearInterval(timer)
      await renewing
      await reader?.release()
      const count = versions.get(version)! - 1
      if (count) versions.set(version, count); else versions.delete(version)
      if (!versions.size) pins.delete(key)
    },
  }
}
const verifiedObjects = new Map<string, string>()
// 已发现损坏的版本不能通过读取另一张完好页面绕过；修复后完整校验可解除标记。
const incompleteVersions = new Set<string>()
const versionKey = (root: string, version: string) => `${path.resolve(root)}\0${version}`
interface ValidationCache {
  watcher: FSWatcher; identity: string; revision: number; failed: boolean
  versions: Map<string, { signature: string; files: Set<string> }>
}
const validations = new Map<string, ValidationCache>()
async function ensureCompleteVersion(root: string, manifest: SnapshotManifest, force: boolean): Promise<void> {
  const key = path.resolve(root)
  const metadata = await stat(key, { bigint: true }), identity = `${metadata.dev}:${metadata.ino}:${metadata.birthtimeNs}`
  let cache = validations.get(key)
  if (!cache || cache.failed || cache.identity !== identity) {
    cache?.watcher.close()
    const versions: ValidationCache['versions'] = new Map()
    const objectDirectory = path.relative(key, await safePath(root, 'objects')).replaceAll('\\', '/')
    const prefix = objectDirectory.slice(0, -'objects'.length)
    const watcher = watch(key, { recursive: true, persistent: false }, (_event, name) => {
      const physical = name?.replaceAll('\\', '/')
      const file = physical?.startsWith(prefix) ? physical.slice(prefix.length) : physical
      if (file && !/^(objects|versions)(\/|$)/.test(file)) return
      cache!.revision++
      for (const [version, value] of versions) if (!file || [...value.files].some(item => item === file || item.startsWith(file + '/'))) versions.delete(version)
    })
    cache = { watcher, identity, revision: 0, failed: false, versions }
    watcher.on('error', () => { cache!.failed = true; versions.clear() })
    if (validations.size >= 64) {
      const oldest = validations.keys().next().value!
      validations.get(oldest)!.watcher.close(); validations.delete(oldest)
    }
    validations.set(key, cache)
  }
  // 先让文件系统变更通知进入事件循环，避免同步落盘后仍沿用旧的验齐凭据。
  await nextTurn(); await nextTurn()
  // 内存中的清单已回填原始向量（护士库 3 万余条 4096 维），直接序列化会超过单个字符串上限；签名只需持久化形态。
  const signature = hash(storageJson(manifest)), version = manifest.version!
  if (!force && !cache.failed && cache.versions.get(version)?.signature === signature) return
  for (;;) {
    const revision = cache.revision
    await scanCompleteVersion(root, manifest)
    await nextTurn(); await nextTurn()
    if (cache.failed) throw new Error('版本文件监测失效，请重新读取。')
    if (revision !== cache.revision) continue
    const files = new Set<string>([`versions/${version}.json`])
    references(manifest, files, new Set())
    cache.versions.set(version, { signature, files })
    return
  }
}
async function verifyFile(root: string, relative: string, requirement: string, verify: () => Promise<unknown>): Promise<void> {
  const file = await safePath(root, relative), metadata = await stat(file, { bigint: true })
  const key = `${file}\0${requirement}`
  const stamp = `${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`
  if (verifiedObjects.get(key) === stamp) return
  await verify()
  if (verifiedObjects.size >= 100000) verifiedObjects.delete(verifiedObjects.keys().next().value!)
  verifiedObjects.set(key, stamp)
}
export async function withInventoryLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  return withRevocationLock(root, action)
}
export function references(value: unknown, files: Set<string>, vectors: Set<string>): void {
  if (!value || typeof value !== 'object') return
  for (const [key, item] of Object.entries(value)) {
    // 运行时数值数组不是对象引用；向量仍按 vector_id 读取并核验身份与载荷哈希。
    if (key === 'vector' && Array.isArray(item) && typeof (value as { vector_id?: unknown }).vector_id === 'string'
      || key === 'centroid' && Array.isArray(item) && 'point_ids' in value && 'parent_id' in value) continue
    if (typeof item === 'string') {
      if (key === 'vector_id') { vectors.add(item); files.add(vectorPath(item)) }
      else if (['content_id', 'new_object', 'previous_object'].includes(key) && /^sha256:[a-f0-9]{64}$/.test(item)) files.add(pageObjectPath(item))
      else if (/^(objects\/snapshots\/|objects\/assets\/)/.test(item)) files.add(item)
    } else references(item, files, vectors)
  }
  const record = value as { pages?: Record<string, unknown>; materialized?: Record<string, string>; desired?: Record<string, string> }
  for (const mapping of [record.pages, record.materialized, record.desired]) for (const id of Object.values(mapping ?? {})) if (typeof id === 'string' && /^sha256:[a-f0-9]{64}$/.test(id)) files.add(pageObjectPath(id))
}
export async function validateCompleteVersion(root: string, manifest: SnapshotManifest, requireVectors = false): Promise<void> {
  if (requireVectors && manifest.vector_state && hasVectorMode(manifest.vector_state.mode)) {
    const ids = new Set<string>()
    references(manifest, new Set(), ids)
    for (const id of ids) if (!sameIdentity(manifest.vector_state.identity, recordIdentity(await readVectorRecord(root, id), manifest.topics?.embedding.url))) throw new Error('待发布向量与本库身份不符。')
  }
  await ensureCompleteVersion(root, manifest, true)
}
async function scanCompleteVersion(root: string, manifest: SnapshotManifest): Promise<void> {
  const key = versionKey(root, manifest.version!)
  try { await validateVersionObjects(root, manifest); incompleteVersions.delete(key) }
  catch (error) {
    if (incompleteVersions.size >= 1024) incompleteVersions.delete(incompleteVersions.values().next().value!)
    incompleteVersions.add(key)
    throw error
  }
}
async function validateVersionObjects(root: string, manifest: SnapshotManifest): Promise<void> {
  const files = new Set<string>(), vectors = new Set<string>()
  references(manifest, files, vectors)
  const tasks: (() => Promise<unknown>)[] = [
    ...Object.keys(manifest.pages ?? {}).map(page => () => versionPage(root, manifest, page)),
    ...[...vectors].map(id => () => readVectorRecord(root, id).catch(error => { if (!vectorUnavailable(error)) throw error })),
  ]
  for (const source of manifest.sources) tasks.push(() => validateSourceSnapshot(root, source))
  for (let i = 0; i < tasks.length; i += 8) {
    const results = await Promise.allSettled(tasks.slice(i, i + 8).map(task => task()))
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }
}
// 来源页只核验本来源的证据对象，不遍历其余来源、页面和向量。
export async function validateSourceSnapshot(root: string, source: SourceEntry): Promise<void> {
  await verifyFile(root, source.files.source, `source:${source.origin_type}:${source.content_hash}`, async () => {
    const bytes = await readFile(await safePath(root, source.files.source))
    if (source.origin_type === 'local' && hash(bytes) !== source.content_hash) throw new Error('快照校验失败。')
  })
  await verifyFile(root, source.extract.path, 'extraction-json', async () => JSON.parse(await readFile(await safePath(root, source.extract.path), 'utf8')))
  for (const asset of source.files.assets) await verifyFile(root, asset.path, `asset:${asset.hash}`, async () => {
    if (hash(await readFile(await safePath(root, asset.path))) !== asset.hash) throw new Error('附件校验失败。')
  })
  for (const object of source.siyuan?.objects ?? []) await verifyFile(root, object.path, `siyuan:${object.hash}`, async () => {
    if (hash(await readFile(await safePath(root, object.path))) !== object.hash) throw new Error('思源对象校验失败。')
  })
}
async function registerReader(root: string, version: string) {
  const relative = `state/readers/${randomUUID()}.json`
  const lease: ReaderLease = { pid: process.pid, device: (await localDevice()).id, version, expires_at: Date.now() + readerLeaseMs }
  await writeJson(root, relative, lease)
  let released = false, failure: unknown, renewing: Promise<void> | undefined
  const assert = async () => {
    const saved = await readOptional<ReaderLease>(await safePath(root, relative))
    if (released || failure || Date.now() >= lease.expires_at || !saved || saved.expires_at <= Date.now()) throw new Error('读者租约已失效，请重新读取。', { cause: failure })
  }
  const timer = setInterval(() => {
    if (released || renewing) return
    renewing = withInventoryLock(root, async () => {
      if (released) return
      await assert()
      lease.expires_at = Date.now() + readerLeaseMs
      await writeJson(root, relative, lease)
    }).catch(error => { failure = error }).finally(() => { renewing = undefined })
  }, readerRenewMs)
  timer.unref()
  return { assert, release: async () => {
    if (released) return
    released = true; clearInterval(timer)
    await renewing
    await unlink(await safePath(root, relative)).catch(error => { if (error.code !== 'ENOENT') throw error })
  } }
}
export async function pinVersion(root: string, requested?: string, validate = true): Promise<{ current: CurrentVersion; manifest: SnapshotManifest; warning?: string; assert: () => Promise<void>; release: () => Promise<void> }> {
  await resumeRevocationCleanup(root)
  for (;;) {
    const before = await readOptional<{ generation: number }>(await safePath(root, 'state/revocations.json'))
    const current = await readOptional<CurrentVersion>(await safePath(root, 'state/current.json'))
    if (!current) throw new Error('尚无已发布版本。')
    if (requested && requested !== current.version && !current.history?.includes(requested)) throw new Error('指定版本尚未发布或不在保留版本中。')
    for (const version of requested ? [requested] : [current.version, ...(current.history ?? []).slice(-1)]) {
      let reader: Awaited<ReturnType<typeof registerReader>> | undefined
      try {
        const manifest = requested || version !== current.version
          ? await withInventoryLock(root, async () => {
            const value = await readVersion(root, version)
            reader = await registerReader(root, version)
            return value
          })
          : await (async () => {
            // 当前指针与退役宽限期共同保留版本；长读者跨发布时补磁盘租约。
            reader = pinLocal(root, version)
            return readVersion(root, version)
          })()
        // 校验可读取大对象；不能持有全库锁等待正文 IO。
        await ensureCompleteVersion(root, manifest, validate || incompleteVersions.has(versionKey(root, version)))
        await reader!.assert()
        return { current, manifest, ...reader!, ...(version !== current.version && !requested ? { warning: '更新未完整，使用上一完整版本。' } : {}) }
      } catch (error) {
        await reader?.release()
        if ((await readOptional<{ generation: number }>(await safePath(root, 'state/revocations.json')))?.generation !== before?.generation) break
        if (!requested && (await readOptional<CurrentVersion>(await safePath(root, 'state/current.json')))?.version !== current.version) break
        if (requested || version !== current.version || !current.history?.length) throw new Error('更新未完整：版本引用的对象缺失或校验失败，请等待同步完成。', { cause: error })
      }
    }
    if ((await readOptional<{ generation: number }>(await safePath(root, 'state/revocations.json')))?.generation === before?.generation
      && (await readOptional<CurrentVersion>(await safePath(root, 'state/current.json')))?.version === current.version) throw new Error('更新未完整。')
    await resumeRevocationCleanup(root)
  }
}
export async function listFiles(root: string, relative: string): Promise<string[]> {
  const target = await safePath(root, relative)
  const entries = await readdir(target, { recursive: true, withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  return entries.filter(entry => entry.isFile()).map(entry => path.posix.join(relative.replaceAll('\\', '/'), path.relative(target, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/')))
}
export async function collectGarbage(root: string, graceMs = readerLeaseMs): Promise<void> {
  await resumeRevocationCleanup(root)
  await withInventoryLock(root, async () => {
    const current = await readOptional<CurrentVersion>(await safePath(root, 'state/current.json'))
    const retained = new Set([...(current ? [current.version, ...(current.history ?? []).slice(-1)] : []), ...(pins.get(path.resolve(root))?.keys() ?? [])])
    const versions = (await listFiles(root, 'versions')).filter(file => /^versions\/v\d{6,}\.json$/.test(file))
    if (graceMs > 0) {
    const retired = await readOptional<Record<string, number>>(await safePath(root, 'state/retired-versions.json')) ?? {}
    const nextRetired: Record<string, number> = {}, now = Date.now()
    // 首次观察到版本被替换才开始计时，不能用其创建时间代替退役时间。
    for (const file of versions) {
      const version = path.posix.basename(file, '.json')
      if (version === current?.version) continue
      const since = Number.isFinite(retired[version]) ? retired[version]! : now
      nextRetired[version] = since
      if (now - since < graceMs) retained.add(version)
    }
    if (JSON.stringify(retired) !== JSON.stringify(nextRetired)) await writeJson(root, 'state/retired-versions.json', nextRetired)
    }
    for (const file of await listFiles(root, 'state/readers')) {
      if (!file.endsWith('.json')) continue
      const lease = await readOptional<ReaderLease>(await safePath(root, file))
      if (lease && Number.isSafeInteger(lease.pid) && lease.pid > 0 && lease.device && /^v\d{6,}$/.test(lease.version) && Number.isFinite(lease.expires_at) && lease.expires_at > Date.now()) retained.add(lease.version)
      else await unlink(await safePath(root, file)).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
    const files = new Set<string>(), vectors = new Set<string>()
    references(await readOptional(await safePath(root, 'state/topics.json')), files, vectors)
    for (const file of [...await listFiles(root, 'work'), ...await listFiles(root, 'conflicts'), 'state/reading-copy.json']) {
      if (!file.endsWith('.json')) continue
      const value = await readOptional<Record<string, unknown>>(await safePath(root, file))
      references(value, files, vectors)
      if (!file.startsWith('conflicts/')) for (const key of ['version', 'base_version', 'target']) if (typeof value?.[key] === 'string' && /^v\d{6,}$/.test(value[key] as string)) {
        const version = value[key] as string
        if (await readOptional(await safePath(root, `versions/${version}.json`))) retained.add(version)
      }
    }
    for (const version of retained) {
      const manifest = await readVersion(root, version)
      references(manifest, files, vectors)
    }
    const cache = await readOptional<{ vectors: Record<string, { vector_id: string }> }>(await safePath(root, 'state/embeddings.json'))
    const building = await readOptional(await safePath(root, 'work/pending.json'))
    if (building) references(cache, files, vectors)
    // 先取消历史登记，再删对象；中断后的下次清理可重复执行。
    for (const file of versions) if (!retained.has(path.posix.basename(file, '.json'))) await unlink(await safePath(root, file))
    // 未发布对象由作业整体固定，避免正文封存与检查点引用之间的可见窗口。
    // 撤权清除独立于此宽限，仍立即删除被撤内容。
    if (!building) for (const file of await listFiles(root, 'objects')) if (!files.has(file)) await unlink(await safePath(root, file))
    if (cache) {
      const kept = Object.fromEntries(Object.entries(cache.vectors).filter(([, value]) => files.has(vectorPath(value.vector_id))))
      if (Object.keys(kept).length !== Object.keys(cache.vectors).length) await writeJson(root, 'state/embeddings.json', { ...cache, vectors: kept })
    }
    for (const file of await listFiles(root, 'cache')) {
      const version = /\/(v\d{6,})(?:\.sqlite)/.exec(file)?.[1]
      if (version && !retained.has(version)) await unlink(await safePath(root, file)).catch(error => { if (!['ENOENT', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error })
    }
    await unlink(await safePath(root, 'state/gc-pending.json')).catch(error => { if (error.code !== 'ENOENT') throw error })
  })
}
