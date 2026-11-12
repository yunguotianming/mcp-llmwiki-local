import { randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { DatabaseSync } from 'node:sqlite'
import type { BigIntStats } from 'node:fs'
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { actualPath, safePath, within, withStateLayout } from '../storage/paths.js'
import { signature } from '../storage/files.js'
import { storageJson } from './vectors.js'
import { localDevice } from './devices.js'
import { resolveLibraryRoot } from '../storage/library-root.js'

export const hash = (value: string | Uint8Array): string => 'sha256:' + signature(value)
export const hashName = (value: string): string => value.replace(/^sha256:/, '')
const verified = new Map<string, { stamp: string; value: unknown; size: number }>()
let verifiedBytes = 0
const objectStamp = (metadata: BigIntStats) => `${metadata.dev}:${metadata.ino}:${metadata.size}:${metadata.mtimeNs}:${metadata.ctimeNs}`
// 缓存只复用已校验字节；每次仍解析路径并检查元数据，缺件或外部改写不能命中。
export async function readVerifiedObject<T>(root: string, relative: string, requirement: string, verify: (bytes: Buffer) => T): Promise<T> {
  return readVerifiedFile(await safePath(root, relative), requirement, verify)
}
async function readVerifiedFile<T>(file: string, requirement: string, verify: (bytes: Buffer) => T): Promise<T> {
  const key = `${file}\0${requirement}`
  const stamp = objectStamp(await stat(file, { bigint: true })), cached = verified.get(key)
  if (cached?.stamp === stamp) return cached.value as T
  if (cached) { verifiedBytes -= cached.size; verified.delete(key) }
  const bytes = await readFile(file)
  const value = verify(bytes)
  // 读取期间发生变化时不缓存，下一次读取仍重新校验。
  if (bytes.length <= 16 * 1024 * 1024 && objectStamp(await stat(file, { bigint: true })) === stamp) {
    const previous = verified.get(key)
    if (previous) { verifiedBytes -= previous.size; verified.delete(key) }
    while (verified.size >= 1024 || verifiedBytes + bytes.length > 16 * 1024 * 1024) {
      const oldest = verified.keys().next().value!
      verifiedBytes -= verified.get(oldest)!.size; verified.delete(oldest)
    }
    verifiedBytes += bytes.length
    verified.set(key, { stamp, value, size: bytes.length })
  }
  return value
}
export async function libraryRoot(knowledgeRoot: string): Promise<string> {
  const root = await resolveLibraryRoot(knowledgeRoot)
  if (!within(knowledgeRoot, root)) throw new Error('Wiki 目录越出资料范围。')
  return root
}
const writes = new Map<string, Promise<void>>()
interface StorageGeneration { root: string; generation: number; active: boolean; database?: DatabaseSync }
const generations = new AsyncLocalStorage<StorageGeneration | undefined>()
const locks = new AsyncLocalStorage<Map<string, { active: boolean; generation?: number }>>()
const lockQueue = new Map<string, Promise<unknown>>()
export async function withStorageGeneration<T>(root: string, action: () => Promise<T>): Promise<T> {
  return withStateLayout(root, async () => {
    const generation = JSON.parse(await readFile(await safePath(root, 'state/revocations.json'), 'utf8')).generation as number
    const context: StorageGeneration = { root: path.resolve(root), generation, active: true }
    try { return await generations.run(context, action) }
    finally { context.active = false; context.database?.close() }
  })
}
export function advanceStorageGeneration(root: string, generation: number): void {
  const context = generations.getStore()
  if (context?.root === path.resolve(root) && context.generation !== generation) {
    context.generation = generation
    savedDrafts = new WeakMap()
  }
}
export function withoutStorageGeneration<T>(action: () => Promise<T>): Promise<T> { return generations.run(undefined, action) }
async function guardedWrite<T>(root: string, action: () => Promise<T>): Promise<T> {
  const context = generations.getStore()
  if (context?.root !== path.resolve(root)) return action()
  return withRevocationLock(root, async () => {
    const lock = locks.getStore()!.get(path.resolve(root))!
    // 同一次互斥内撤权代次不会被其他进程改变；嵌套写入共用已核验的代次。
    lock.generation ??= JSON.parse(await readFile(await safePath(root, 'state/revocations.json'), 'utf8')).generation as number
    if (lock.generation !== context.generation) throw new Error('撤权代次变化，停止写入并等待重建。')
    return action()
  })
}
// 同一作业已封存的草稿对象不反复打开；恢复后由检查点引用重新校验。
let savedDrafts = new WeakMap<object, Set<string>>()
interface PendingSnapshot { serialized: string; drafts: Map<string, string>; generation: StorageGeneration | undefined; lock: object | undefined; promise: Promise<void> }
const pendingSnapshots = new WeakMap<object, Map<string, PendingSnapshot>>()
function pendingContent(value: unknown): Pick<PendingSnapshot, 'serialized' | 'drafts'> {
  const plain = { ...value as Record<string, unknown> }, drafts = new Map<string, string>()
  for (const name of ['topics', 'terms']) {
    const build = plain[name] as { pages?: Record<string, { content?: string; content_id?: string }> } | undefined
    if (!build?.pages) continue
    const pages = { ...build.pages }
    for (const [key, page] of Object.entries(pages)) if (page.content !== undefined) {
      const id = hash(page.content), reference = { ...page }
      drafts.set(id, page.content)
      reference.content_id = id; delete reference.content
      pages[key] = reference
    }
    plain[name] = { ...build, pages }
  }
  // 浅复制仅用于替换草稿字段；首次 await 前同步编码全部嵌套状态，异步阶段只保留不可变字符串。
  return { serialized: storageJson(plain), drafts }
}
async function serializeWrite(root: string, relative: string, work: () => Promise<void>): Promise<void> {
  const serialize = async () => {
    const key = path.resolve(root, relative), previous = writes.get(key) ?? Promise.resolve()
    const current = previous.catch(() => {}).then(work)
    writes.set(key, current)
    try { await current } finally { if (writes.get(key) === current) writes.delete(key) }
  }
  return /^(objects\/|versions\/|wiki\/|work\/|logs\/|state\/(?:topics|embeddings|current|reading-copy)\.json|library\.yaml)/.test(relative) ? guardedWrite(root, serialize) : serialize()
}
export async function atomicWrite(root: string, relative: string, value: string): Promise<void> {
  await serializeWrite(root, relative, () => writeAtomic(root, relative, value))
}
export async function appendLog(root: string, value: string): Promise<void> {
  await serializeWrite(root, 'logs/build.md', async () => {
    const previous = await readFile(await safePath(root, 'logs/build.md'), 'utf8').catch(error => error.code === 'ENOENT' ? '# 建库历史\n' : Promise.reject(error))
    await writeAtomic(root, 'logs/build.md', previous + value)
  })
}
async function writeAtomic(root: string, relative: string, value: string): Promise<void> {
  const target = await safePath(root, relative)
  // 目标已解析到库内真实路径；同目录随机临时文件以 wx 独占创建，无需再解析不存在的路径。
  const temporary = target + '.' + randomUUID() + '.tmp'
  let renamed = false
  try {
    const handle = await openTemporary(temporary)
    try { await handle.writeFile(value, 'utf8'); await handle.sync() } finally { await handle.close() }
    for (let attempt = 0; ; attempt++) {
      try { await rename(temporary, target); break }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && ['EPERM', 'EACCES', 'EBUSY'].includes(String(error.code)))) throw error
        const windowsReader = process.platform === 'win32' && error.code !== 'EBUSY'
        if (attempt >= (windowsReader ? 9 : 2)) throw error
        // Windows 读者短暂占用目标时保留旧文件，仅失败后退避；成功路径不等待、不重写字节。
        await new Promise(resolve => setTimeout(resolve, windowsReader ? Math.min(2 ** (attempt + 1), 64) : 20 * (attempt + 1)))
      }
    }
    renamed = true
  } finally { if (!renamed) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}
async function openTemporary(file: string): Promise<Awaited<ReturnType<typeof open>>> {
  // 检查点通常复用已有目录；只在首次创建或目录被删除时补建，省去每次写入的目录操作。
  try { return await open(file, 'wx') }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    await mkdir(path.dirname(file), { recursive: true })
    return open(file, 'wx')
  }
}
export async function writeJson(root: string, relative: string, value: unknown): Promise<void> {
  if (relative !== 'work/pending.json') {
    const content = storageJson(value)
    await serializeWrite(root, relative, () => writeAtomic(root, relative, content))
    if (relative === 'state/revocations.json') {
      const lock = locks.getStore()?.get(path.resolve(root))
      if (lock) delete lock.generation
    }
    return
  }
  const content = pendingContent(value)
  const key = path.resolve(root), generation = generations.getStore(), lock = locks.getStore()?.get(key)
  const queued = pendingSnapshots.get(value as object) ?? new Map<string, PendingSnapshot>()
  pendingSnapshots.set(value as object, queued)
  const previous = queued.get(key)
  // 同一作业对象的完整快照在等锁时可由更新快照替代；所有等待者仍在实际落盘后才返回。
  if (previous && previous.generation === generation && previous.lock === lock) { Object.assign(previous, content); return previous.promise }
  const snapshot: PendingSnapshot = { ...content, generation, lock, promise: Promise.resolve() }
  queued.set(key, snapshot)
  snapshot.promise = withRevocationLock(root, () => serializeWrite(root, relative, async () => {
    if (queued.get(key) === snapshot) queued.delete(key)
    {
      const { putPage } = await import('./objects.js')
      const saved = savedDrafts.get(value as object) ?? new Set<string>()
      savedDrafts.set(value as object, saved)
      for (const [id, content] of snapshot.drafts) if (!saved.has(id)) { await putPage(root, content); saved.add(id) }
    }
    await writeAtomic(root, relative, snapshot.serialized)
  })).finally(() => { if (queued.get(key) === snapshot) queued.delete(key) })
  return snapshot.promise
}
export async function immutableWrite(root: string, relative: string, bytes: Uint8Array): Promise<void> {
  // 命中已有且校验通过的对象没有写入，不进入撤权写锁；缺件仍在锁内再次检查。
  if (await immutablePresent(await safePath(root, relative), hash(bytes), relative)) return
  return guardedWrite(root, () => writeImmutable(root, relative, bytes))
}
async function immutablePresent(target: string, expected: string, relative: string): Promise<boolean> {
  try {
    await readVerifiedFile(target, `immutable:${expected}`, existing => {
      if (hash(existing) !== expected) throw new Error('不可变文件校验失败：' + relative)
    })
    return true
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; return false }
}
async function writeImmutable(root: string, relative: string, bytes: Uint8Array): Promise<void> {
  const target = await safePath(root, relative)
  if (await immutablePresent(target, hash(bytes), relative)) return
  const temporary = target + '.' + randomUUID() + '.tmp'
  let renamed = false
  try {
    const handle = await openTemporary(temporary)
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    await rename(temporary, target)
    renamed = true
  } finally { if (!renamed) await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error }) }
}
// 撤权不等待建库模型；与短时存储写入、读者登记和清理互斥。
export async function withRevocationLock<T>(root: string, action: () => Promise<T>): Promise<T> {
  const key = path.resolve(root)
  if (locks.getStore()?.get(key)?.active) return action()
  const previous = lockQueue.get(key) ?? Promise.resolve()
  const work = previous.catch(() => {}).then(async () => acquireRevocationLock(root, await safePath(root, 'state/inventory-lock.sqlite'), action))
  lockQueue.set(key, work)
  try { return await work } finally { if (lockQueue.get(key) === work) lockQueue.delete(key) }
}
async function acquireRevocationLock<T>(root: string, file: string, action: () => Promise<T>): Promise<T> {
  await mkdir(path.dirname(file), { recursive: true })
  // 数据库只承载 OS 事务锁和格式标记；崩溃自动解锁，Windows 无须删除被占用的锁文件。
  const context = generations.getStore()
  const session = context?.active && context.root === path.resolve(root) ? context : undefined
  // 一次建库复用连接；每个短操作独立加锁，等待模型期间不持有事务锁。
  const db = session ? session.database ??= new DatabaseSync(file) : new DatabaseSync(file)
  const deadline = Date.now() + 10000
  let acquired = false, initialized = false
  try {
    db.exec('PRAGMA busy_timeout=0')
    for (let attempt = 0; ; attempt++) {
      try { db.exec('BEGIN IMMEDIATE'); acquired = true; break }
      catch (error) {
        if (!(error instanceof Error && 'errcode' in error && [5, 6].includes(Number(error.errcode)))) throw error
        if (Date.now() >= deadline) throw new Error('撤权状态锁等待超时。')
        await new Promise(resolve => setTimeout(resolve, Math.min(2 ** attempt, 16)))
      }
    }
    // 零字节库的 BEGIN 会反复创建页和日志，ROLLBACK 又将其清空；首次提交格式标记避免每次加锁都写盘。
    if (db.prepare('PRAGMA user_version').get()!.user_version === 0) {
      db.exec('PRAGMA user_version=1'); initialized = true
    }
    // 升级时尊重旧实现遗留的 JSON 锁；只回收本机已经退出的所有者。
    const legacy = await safePath(root, 'state/revocations.lock')
    const previous = await readFile(legacy, 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (previous !== undefined) {
      const owner = JSON.parse(previous) as { pid: number; device?: string; token: string }
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || !owner.token || owner.device && owner.device !== (await localDevice()).id) throw new Error('旧撤权锁需要在原设备完成恢复。')
      try { process.kill(owner.pid, 0); throw new Error('旧实现仍持有撤权锁，请等待原操作结束。') }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error }
      await unlink(legacy)
    }
    const ownership = { active: true }
    try { return await locks.run(new Map([...(locks.getStore() ?? []), [path.resolve(root), ownership]]), action) }
    finally { ownership.active = false }
  } finally { try { if (acquired) db.exec(initialized ? 'COMMIT' : 'ROLLBACK') } finally { if (!session) db.close() } }
}
export async function withBuildLock<T>(knowledgeRoot: string, action: () => Promise<T>, takeover = false): Promise<T> {
  const file = await safePath(knowledgeRoot, '.llmwiki-build.lock')
  const owner = { pid: process.pid, token: randomUUID(), device: (await localDevice()).id }
  let handle
  try { handle = await open(file, 'wx') }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    const previous = JSON.parse(await readFile(file, 'utf8')) as typeof owner
    if (previous.device && previous.device !== owner.device) {
      if (!takeover) throw new Error('发现其他设备的建库锁，请停止原设备后在高级设置接管建库设备。')
      if (JSON.parse(await readFile(file, 'utf8')).token !== previous.token) throw new Error('建库锁已变化。')
      await unlink(file)
      return withBuildLock(knowledgeRoot, action, takeover)
    }
    if (!Number.isInteger(previous.pid) || previous.pid < 1) throw new Error('建库锁无效，请先核对。')
    try { process.kill(previous.pid, 0); throw new Error('已有分层建库正在运行。') }
    catch (cause) { if (!(cause instanceof Error && 'code' in cause && cause.code === 'ESRCH')) throw cause }
    if (JSON.parse(await readFile(file, 'utf8')).token !== previous.token) throw new Error('建库锁已变化。')
    await unlink(file)
    return await withBuildLock(knowledgeRoot, action, takeover)
  }
  try { await handle.writeFile(JSON.stringify(owner)); await handle.sync(); return await action() }
  finally {
    await handle.close()
    if (JSON.parse(await readFile(file, 'utf8')).token !== owner.token) throw new Error('建库锁身份已变化。')
    await unlink(file)
  }
}
