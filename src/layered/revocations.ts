import { readBlock } from './anchors.js'
import { pinVersion, validateCompleteVersion, validateSourceSnapshot } from './retention.js'
import { readCurrent, readManifest, readVersion, versionPage } from './objects.js'
import { readFile } from 'node:fs/promises'
import { directory, safePath } from '../storage/paths.js'
import { readOptional } from '../storage/files.js'
import { decodeSourceText } from '../ingest/text.js'
import { atomicWrite, hash, libraryRoot, withRevocationLock, withoutStorageGeneration, writeJson } from './files.js'
import { beginRevocationCleanup, resumeRevocationCleanup } from './revocation-cleanup.js'
import { checkWriter } from './devices.js'
import { formatVersion, locatorRange, topicPath } from './schema.js'
import type { CurrentVersion, Dependencies, PendingBuild, Revocations, SnapshotManifest } from './schema.js'
import type { ReadingCopyState } from './reading-copy.js'

export const validSourceId = (id: string): boolean => /^(?:S-\d{4,}|\d{14}-[a-z0-9]{7})$/.test(id)

export async function readRevocations(root: string): Promise<Revocations> {
  const value = await readOptional<Revocations>(await safePath(root, 'state/revocations.json'))
  if (!value || !Number.isSafeInteger(value.generation) || value.generation < 0 || !Array.isArray(value.sources)
    || value.sources.some(item => !validSourceId(item.source_id) || !Number.isSafeInteger(item.generation) || item.generation <= 0 || item.generation > value.generation
      || !item.current_path || !item.reason || !item.revoked_at || item.alias_paths !== undefined && (!Array.isArray(item.alias_paths) || item.alias_paths.some(file => typeof file !== 'string' || !file)))
    || Math.max(0, ...value.sources.map(item => item.generation)) !== value.generation
    || new Set(value.sources.map(item => item.source_id)).size !== value.sources.length) throw new Error('撤权表缺失或无效，拒绝读取和发布。')
  return value
}
export async function checkGeneration(root: string, generation: number): Promise<void> {
  if ((await readRevocations(root)).generation !== generation) throw new Error('撤权代次变化，停止发布并等待重建。')
}
export function indexDependencies(deps: Dependencies): Dependencies {
  deps.reverse = {}; deps.reverse_sources = {}
  const visiting = new Set<string>(), done = new Set<string>()
  const visit = (page: string): string[] => {
    if (visiting.has(page)) throw new Error('页面依赖存在循环。')
    const entry = deps.pages[page]
    if (!entry) throw new Error('子页依赖不存在：' + page)
    if (done.has(page)) return entry.sources
    visiting.add(page)
    const sources = new Set(entry.sources)
    for (const child of entry.children ?? []) for (const source of visit(child.page)) sources.add(source)
    entry.sources = [...sources].sort()
    const inherited = new Set(entry.points.map(point => point.point_id))
    const collect = (child: string) => { for (const point of deps.pages[child]!.points) inherited.add(point.point_id); for (const next of deps.pages[child]!.children ?? []) collect(next.page) }
    for (const child of entry.children ?? []) collect(child.page)
    for (const point of inherited) (deps.reverse[point] ??= []).push(page)
    for (const source of entry.sources) (deps.reverse_sources![source] ??= []).push(page)
    visiting.delete(page); done.add(page); return entry.sources
  }
  for (const page of Object.keys(deps.pages).sort()) visit(page)
  return deps
}
export function revocationLog(revocations: Revocations, since: number): string {
  return revocations.sources.filter(item => item.generation > since).map(item =>
    `\n## [${item.revoked_at}] revoke | ${item.source_id} | 代次 ${item.generation}\n- 撤权原因哈希：${hash(item.reason)}\n`).join('')
}
export async function revokeLayeredSources(knowledgeRoot: string, sourceIds: string[], reason: string, deleted = false): Promise<Revocations> {
  const root = await libraryRoot(await directory(knowledgeRoot))
  return revokeSourcesAtRoot(root, sourceIds, reason, deleted)
}
export async function revokeSourcesAtRoot(root: string, sourceIds: string[], reason: string, deleted = false): Promise<Revocations> {
  if (!sourceIds.length || sourceIds.some(id => !validSourceId(id)) || !reason.trim()) throw new Error('请提供有效来源编号和撤权原因。')
  await resumeRevocationCleanup(root)
  return await withoutStorageGeneration(() => withRevocationLock(root, async () => {
    await checkWriter(root)
    const revocations = await readRevocations(root), current = await readCurrent(root), manifest = await readManifest(root, current)
    const pending = await readOptional<PendingBuild>(await safePath(root, 'work/pending.json'))
    const entries = [...manifest.sources, ...pending?.manifest.sources ?? []], previousGeneration = revocations.generation
    // 预览提交后，删除来源已退出当前清单；仍从保留的上一版核验身份并物理撤权。
    if (deleted && manifest.card?.origin_type === 'local' && sourceIds.some(id => !entries.some(source => source.source_id === id) && !revocations.sources.some(source => source.source_id === id))) {
      for (const version of current?.history ?? []) entries.push(...(await readVersion(root, version)).sources)
    }
    for (const sourceId of new Set(sourceIds)) {
      const source = entries.filter(item => item.source_id === sourceId).sort((a, b) => b.revocation_generation - a.revocation_generation)[0]
      const old = revocations.sources.find(item => item.source_id === sourceId)
      if (!source && old) continue
      if (!source) throw new Error('撤权来源不存在：' + sourceId)
      if (old && source.revocation_generation < old.generation) continue
      revocations.sources = revocations.sources.filter(item => item.source_id !== sourceId)
      revocations.generation++
      revocations.sources.push({ source_id: sourceId, current_path: source.current_path, ...(source.alias_paths?.length ? { alias_paths: source.alias_paths } : {}), reason: reason.trim(), revoked_at: new Date().toISOString(), generation: revocations.generation, ...(deleted ? { deleted } : {}) })
    }
    if (previousGeneration === revocations.generation) return revocations
    await beginRevocationCleanup(root, revocations)
    // 原子落表即屏蔽；物理清除完成后才能报告成功。
    await writeJson(root, 'state/revocations.json', revocations)
    await resumeRevocationCleanup(root)
    let log = '# 建库历史\n'
    try { log = await readFile(await safePath(root, 'logs/build.md'), 'utf8') }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    await atomicWrite(root, 'logs/build.md', log + revocationLog(revocations, previousGeneration))
    return revocations
  }))
}
export interface LayeredReadResult {
  status: 'ok' | 'updating' | 'updated' | 'external'; content: string; version: string; sourceVersion?: string; warning?: string; path?: string
}
function blocked(page: string, manifest: SnapshotManifest, deps: Dependencies, revocations: Revocations): boolean {
  if (manifest.rebuild_pages?.includes(page.split('#')[0]!)) return true
  return revocations.sources.some(item => (manifest.sources.find(source => source.source_id === item.source_id)?.revocation_generation ?? -1) < item.generation && (page === `sources/${item.source_id}.md`
    || (deps.reverse_sources?.[item.source_id] ?? []).includes(page)
    || deps.pages[page]?.sources.includes(item.source_id)
    || manifest.revocation_generation < item.generation && deps.pages[page]?.points.some(point => point.point_id.startsWith(item.source_id + ':'))))
}
export interface LayeredReadOptions { version?: string | undefined; signal?: AbortSignal | undefined; checkAdmission?: (() => Promise<void>) | undefined; filterConflicts?: boolean }
export interface LayeredReadView {
  root: string; current: CurrentVersion; version: string; generation: number; manifest: SnapshotManifest; deps: Dependencies
  conflicts: Set<string>
  warning?: string
  resolve(relative: string): string
  document(relative: string): Promise<LayeredReadResult>
  source(sourceId: string, options?: { sourceVersion?: string | undefined; locator?: string | undefined }): Promise<LayeredReadResult>
  unchanged(): Promise<boolean>
}
// 单次查询共享同一版本和依赖图；索引、正文与原文都使用这里的屏蔽判定。
export async function withLayeredRead<T>(root: string, action: (view: LayeredReadView) => Promise<T>, options: LayeredReadOptions = {}): Promise<T> {
  let verifyComplete = false
  for (;;) {
    options.signal?.throwIfAborted()
    const pinned = await pinVersion(root, options.version, verifyComplete)
    try {
    const revocations = await readRevocations(root), current = pinned.current, manifest = pinned.manifest, version = manifest.version!
    if (manifest.format_version !== formatVersion || !Number.isSafeInteger(manifest.revocation_generation) || manifest.revocation_generation > revocations.generation) throw new Error('发布版本 manifest 无效。')
    if (manifest.sources.some(source => source.origin_type === 'siyuan') && !options.checkAdmission) throw new Error('思源库必须通过已登记查询入口核对准入；请走 keeper_notes 回源。')
    if (options.checkAdmission) {
      await options.checkAdmission()
      if ((await readRevocations(root)).generation !== revocations.generation) continue
    }
    const deps = manifest.deps
    if (!deps) throw new Error('发布版本依赖表缺失。')
    const reading = options.filterConflicts ? await readOptional<ReadingCopyState>(await safePath(root, 'state/reading-copy.json')) : undefined
    indexDependencies(deps)
    const aliases = manifest.aliases
    const resolve = (relative: string): string => {
      if (/^T-\d{4,}(?:-\d{2,})*$/.test(relative)) relative = topicPath(relative)
      if (validSourceId(relative)) relative = `sources/${relative}.md`
      if (/^TM-\d{4,}$/.test(relative)) relative = `terms/${relative}.md`
      if (/^TI-\d{2,}$/.test(relative)) relative = `terms/index-${relative.slice(3)}.md`
      if (relative !== 'index.md' && !/^(?:sources\/(?:S-\d{4,}|\d{14}-[a-z0-9]{7})|topics\/(?:T-\d{4,}(?:-\d{2,})*\/)*T-\d{4,}(?:-\d{2,})*|terms\/(?:TM-\d{4,}|index-\d{2,}))\.md(?:#\^?[a-zA-Z0-9-]+)?$/.test(relative)) throw new Error('只能读取当前版本或指定保留版本的导航、来源、主题或术语页。')
      if (relative.startsWith('topics/')) {
        if (!aliases) throw new Error('发布版本别名表缺失。')
        const id = relative.split('/').at(-1)!.replace(/\.md$/, ''), seen = new Set<string>()
        let target = id
        while (aliases[target]) {
          if (seen.has(target)) throw new Error('主题别名存在循环。')
          seen.add(target); target = aliases[target]!
          if (!/^T-\d{4,}(?:-\d{2,})*$/.test(target)) throw new Error('主题别名目标无效。')
        }
        if (target !== id) relative = topicPath(target)
      }
      return relative
    }
    const view: LayeredReadView = {
      root, current, version, generation: revocations.generation, manifest, deps, resolve, conflicts: new Set(), ...(pinned.warning ? { warning: pinned.warning } : {}),
      unchanged: async () => JSON.stringify(await readCurrent(root)) === JSON.stringify(current) && (await readRevocations(root)).generation === revocations.generation,
      document: async relative => {
        options.signal?.throwIfAborted()
        await pinned.assert()
        const page = resolve(relative)
        const fresh = await readRevocations(root)
        if (blocked(page, manifest, deps, fresh) || page.startsWith('sources/') && blocked(page.split('#')[0]!, manifest, deps, fresh) || fresh.generation !== revocations.generation) return { status: 'updating', content: '更新中', version, path: page }
        const file = page.split('#')[0]!
        if (reading) {
          const bytes = await readFile(await safePath(root, 'wiki/' + file)).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
          const disk = bytes ? hash(bytes) : undefined
          // 允许尚未刷新及中断后已写入的受管副本；手改、手删均不得由对象缓存绕过。
          if (disk ? ![reading.materialized[file], reading.desired?.[file], manifest.pages?.[file]].includes(disk) : reading.materialized[file] !== undefined) {
            view.conflicts.add(file)
            return { status: 'updating', content: '阅读页存在人工修改冲突，处理后可检索。', version, path: page }
          }
        }
        if (page !== 'index.md' && !deps.pages[page] && !(page.startsWith('sources/') && page.includes('#') && deps.pages[file])) {
          await versionPage(root, manifest, file)
          throw new Error('页面依赖记录缺失。')
        }
        let content: string
        try {
          const source = file.startsWith('sources/') ? manifest.sources.find(source => file === `sources/${source.source_id}.md`) : undefined
          if (source) await validateSourceSnapshot(root, source)
          content = await versionPage(root, manifest, file)
        }
        catch (error) {
          if ((await readRevocations(root)).generation !== revocations.generation) return { status: 'updating', content: '更新中', version, path: page }
          throw error
        }
        await pinned.assert()
        if ((await readRevocations(root)).generation !== revocations.generation) return { status: 'updating', content: '更新中', version, path: page }
        if (page.includes('#')) {
          const section = page.split('#')[1]!
          if (section.startsWith('^')) {
            const block = readBlock(content, section)
            if (block === undefined) throw new Error('页面分节不存在。')
            content = block
          } else {
            // 保留版本仍按当时的 HTML 锚点读取；新发布页面只生成块 ID。
            const start = content.indexOf(`<a id="${section}"></a>`), end = content.indexOf('<a id="', start + 1)
            if (start < 0) throw new Error('页面分节不存在。')
            content = content.slice(start, end < 0 ? undefined : end)
          }
        }
        if (page === 'index.md') content = content.split('\n').map(line => {
          const match = /\]\(((?:sources|topics|terms)\/[^)]+\.md)\)/.exec(line)
          return match && blocked(resolve(match[1]!), manifest, deps, revocations) ? `- [更新中](${match[1]})` : line
        }).join('\n')
        return { status: 'ok', content, version, path: page, ...(pinned.warning ? { warning: pinned.warning } : {}) }
      },
      source: async (sourceId, sourceOptions = {}) => {
        await pinned.assert()
        if (/^\d{14}-[a-z0-9]{7}$/.test(sourceId)) return { status: 'external', content: '请走 keeper_notes 回源', version }
        if (!validSourceId(sourceId)) throw new Error('来源编号无效。')
        if (sourceOptions.locator) locatorRange(sourceOptions.locator)
        const fresh = await readRevocations(root)
        if (fresh.sources.some(item => item.source_id === sourceId) || fresh.generation !== revocations.generation) return { status: 'updating', content: '更新中', version: current.version }
        const latest = version === current.version || pinned.warning ? manifest : await readManifest(root, current)
        const entry = latest.sources.find(item => item.source_id === sourceId)
        if (!entry) throw new Error('来源不存在。')
        if (version !== current.version && !pinned.warning || sourceOptions.sourceVersion && sourceOptions.sourceVersion !== entry.source_version) return { status: 'updated', content: '已更新', version: current.version, sourceVersion: entry.source_version }
        // manifest 只能指向该来源的快照；即使损坏也不允许转读库内其他文件。
        if (entry.files.source !== `objects/snapshots/${sourceId}/${entry.content_hash.replace(/^sha256:/, '')}/source.md`) throw new Error('快照路径无效。')
        const bytes = await readFile(await safePath(root, entry.files.source)).catch(async error => {
          if ((await readRevocations(root)).generation !== revocations.generation) return undefined
          throw error
        })
        await pinned.assert()
        if (!bytes || (await readRevocations(root)).generation !== revocations.generation) return { status: 'updating', content: '更新中', version: current.version }
        if (hash(bytes) !== entry.content_hash || entry.source_version !== entry.content_hash) throw new Error('快照内容与来源版本不一致。')
        let content = decodeSourceText(bytes)
        if (sourceOptions.locator) {
          const [first, last] = locatorRange(sourceOptions.locator), lines = content.split(/\r?\n/)
          if (last > lines.length) throw new Error('回源定位超出快照范围。')
          content = lines.slice(first - 1, last).join('\n')
        }
        return { status: 'ok', content, version: pinned.warning ? version : current.version, sourceVersion: entry.source_version,
          ...(pinned.warning ? { warning: pinned.warning } : !options.version && !sourceOptions.sourceVersion ? { warning: '未指定版本' } : {}) }
      },
    }
    let result: T
    try { result = await action(view) }
    catch (error) {
      // 指针切换后旧版本可能被清理；先重读当前视图，不能把竞态当成没有资料。
      if (!await view.unchanged()) continue
      // 读取期间出现变化时强制重新验齐，随后整次请求切换到同一完整版本。
      if (!verifyComplete) {
        try { await validateCompleteVersion(root, manifest) }
        catch { verifyComplete = true; continue }
      }
      throw error
    }
    options.signal?.throwIfAborted()
    await pinned.assert()
    if (!await view.unchanged()) continue
    return result
    } finally { await pinned.release() }
  }
}
export async function readLayeredDocument(knowledgeRoot: string, relative = 'index.md', options: LayeredReadOptions = {}): Promise<LayeredReadResult> {
  return withLayeredRead(await libraryRoot(await directory(knowledgeRoot)), view => view.document(relative), options)
}
export async function readLayeredPage(knowledgeRoot: string, relative = 'index.md', options: { version?: string } = {}): Promise<string> {
  return (await readLayeredDocument(knowledgeRoot, relative, options)).content
}
export async function readLayeredSource(knowledgeRoot: string, sourceId: string, options: LayeredReadOptions & { sourceVersion?: string; locator?: string } = {}): Promise<LayeredReadResult> {
  return withLayeredRead(await libraryRoot(await directory(knowledgeRoot)), view => view.source(sourceId, options), options)
}
