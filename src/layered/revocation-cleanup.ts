import { readFile, unlink } from 'node:fs/promises'
import { safePath } from '../storage/paths.js'
import { readOptional } from '../storage/files.js'
import { atomicWrite, hash, hashName, withRevocationLock, withoutStorageGeneration, writeJson } from './files.js'
import { manifestPath, putPage, readVersion } from './objects.js'
import { listFiles, references } from './retention.js'
import { storageJson, vectorPath } from './vectors.js'
import { checkWriter } from './devices.js'
import { indexDependencies } from './revocations.js'
import type { CurrentVersion, Revocations, SnapshotManifest, TopicState } from './schema.js'
import type { ReadingCopyState } from './reading-copy.js'

const journalPath = 'state/revocation-pending.json'
interface CleanupIntent { revocations: Revocations; pages: string[] }
const basePage = (page: string) => page.split('#')[0]!
const sourceOf = (point: string) => point.split(':')[0]!

function affectedPages(manifest: SnapshotManifest, revoked: Set<string>): Set<string> {
  const pages = new Set((manifest.rebuild_pages ?? []).map(basePage))
  for (const id of revoked) {
    const page = `sources/${id}.md`
    if (manifest.pages?.[page] || manifest.sources.some(source => source.source_id === id)) pages.add(page)
    for (const page of manifest.deps?.reverse_sources?.[id] ?? []) pages.add(basePage(page))
  }
  for (const [page, deps] of Object.entries(manifest.deps?.pages ?? {})) {
    if (deps.sources.some(id => revoked.has(id)) || deps.points.some(point => revoked.has(sourceOf(point.point_id)))
      || deps.terms?.some(term => term.contributions.some(item => revoked.has(item.source_id)))) pages.add(basePage(page))
  }
  for (;;) {
    const size = pages.size
    for (const [page, deps] of Object.entries(manifest.deps?.pages ?? {})) if (deps.children?.some(child => pages.has(basePage(child.page)))) pages.add(basePage(page))
    if (size === pages.size) return pages
  }
}
function cleanTopics(state: TopicState, revoked: Set<string>, pages: Set<string>): void {
  state.vectors = Object.fromEntries(Object.entries(state.vectors).filter(([id]) => !revoked.has(sourceOf(id))))
  for (const topic of state.topics) {
    topic.sources = topic.sources.filter(id => !revoked.has(id))
    topic.point_ids = topic.point_ids.filter(id => !revoked.has(sourceOf(id)))
    if (!topic.point_ids.length) topic.archived = true
    if (topic.direct_point_ids) topic.direct_point_ids = topic.direct_point_ids.filter(id => !revoked.has(sourceOf(id)))
    if (pages.has(topic.path)) { topic.title = ''; topic.summary = ''; topic.aliases = []; topic.centroid = [] }
  }
  if (state.candidates) state.candidates = state.candidates.map(group => group.filter(id => !revoked.has(sourceOf(id)))).filter(group => group.length)
  if (state.logical_sources) for (const id of revoked) delete state.logical_sources[id]
}
async function cleanManifest(root: string, manifest: SnapshotManifest, revocations: Revocations): Promise<Set<string>> {
  const revoked = new Set(revocations.sources.filter(item => (manifest.sources.find(source => source.source_id === item.source_id)?.revocation_generation ?? -1) < item.generation).map(item => item.source_id))
  const pages = affectedPages(manifest, revoked)
  if (!pages.size) return pages
  manifest.sources = manifest.sources.filter(source => !revoked.has(source.source_id))
  if (manifest.gaps) manifest.gaps = manifest.gaps.filter(gap => !revoked.has(gap.source_id))
  if (manifest.card) manifest.card.source_count = manifest.sources.length
  manifest.rebuild_pages = [...pages].sort()
  for (const page of pages) delete manifest.pages![page]
  if (manifest.topics) cleanTopics(manifest.topics, revoked, pages)
  if (manifest.point_labels) manifest.point_labels = Object.fromEntries(Object.entries(manifest.point_labels).filter(([id]) => !revoked.has(sourceOf(id))))
  if (manifest.point_label_gaps) manifest.point_label_gaps = manifest.point_label_gaps.filter(gap => !revoked.has(gap.source_id))
  if (manifest.vector_state) {
    const state = manifest.vector_state
    state.coverage.embedded = state.coverage.embedded.filter(id => !revoked.has(sourceOf(id)))
    state.coverage.missing = state.coverage.missing.filter(id => !revoked.has(sourceOf(id)))
    state.pending_points = state.pending_points.filter(id => !revoked.has(sourceOf(id)))
    state.page_vectors = Object.fromEntries(Object.entries(state.page_vectors ?? {}).filter(([page]) => page !== 'index.md' && !pages.has(basePage(page))))
  }
  const deps = manifest.deps!
  for (const [page, dependency] of Object.entries(deps.pages)) {
    if (pages.has(basePage(page)) && (page.startsWith('sources/') || page.includes('#'))) { delete deps.pages[page]; continue }
    dependency.sources = dependency.sources.filter(id => !revoked.has(id))
    dependency.points = dependency.points.filter(point => !revoked.has(sourceOf(point.point_id)))
    if (pages.has(basePage(page))) {
      delete dependency.calls
      if (dependency.terms) dependency.terms = dependency.terms.flatMap(term => {
        const contributions = term.contributions.filter(item => !revoked.has(item.source_id))
        if (!contributions.length) return []
        const first = contributions[0]!
        return [{ ...term, name: first.name, category: first.category, aliases: [...new Set(contributions.flatMap(item => item.aliases))], contributions, sections: [] }]
      })
    }
  }
  for (const dependency of Object.values(deps.pages)) if (dependency.children) dependency.children = dependency.children.filter(child => Boolean(deps.pages[child.page]))
  indexDependencies(deps)
  // 导航完全重新渲染，避免多行标题或缺口记录藏在旧导航正文里。
  const title = (value: string) => value.replace(/[\r\n\[\]]/g, ' ')
  const links = Object.keys(manifest.pages ?? {}).filter(page => page !== 'index.md').sort().map(page => {
    const source = manifest.sources.find(item => page === `sources/${item.source_id}.md`)
    const topic = manifest.topics?.topics.find(item => item.path === page)
    return `- [${title(source?.metadata.title ?? topic?.title ?? page)}](${page})`
  })
  manifest.pages!['index.md'] = await putPage(root, '# Wiki\n\n' + links.join('\n') + '\n\n' + [...pages].sort().map(page => `- [更新中](${page})`).join('\n') + '\n')
  // 历史日志中的提取缺口可能包含原文；保留版本身份，正文在重新发布时生成。
  delete manifest.log
  await writeJson(root, manifestPath(manifest.version!), { checksum: hash(storageJson(manifest)), manifest })
  return pages
}
async function remove(root: string, file: string): Promise<void> {
  await unlink(await safePath(root, file)).catch(error => { if (error.code !== 'ENOENT') throw error })
}
export async function beginRevocationCleanup(root: string, revocations: Revocations): Promise<void> {
  // 写前日志只存身份和路径，不复制待撤内容；表提交前崩溃也可完成已登记的撤权。
  const pages = new Set<string>(['index.md'])
  const ids = new Set(revocations.sources.map(item => item.source_id))
  for (const id of ids) pages.add(`sources/${id}.md`)
  for (const file of await listFiles(root, 'versions')) if (/^versions\/v\d{6,}\.json$/.test(file)) {
    const manifest = await readVersion(root, file.slice(9, -5))
    for (const page of affectedPages(manifest, ids)) pages.add(page)
  }
  const pending = await readOptional<{ manifest: SnapshotManifest; topics?: { pages: Record<string, unknown> }; terms?: { pages: Record<string, unknown> } }>(await safePath(root, 'work/pending.json'))
  if (pending) {
    for (const page of affectedPages(pending.manifest, ids)) pages.add(page)
    for (const page of [...Object.keys(pending.topics?.pages ?? {}), ...Object.keys(pending.terms?.pages ?? {})]) pages.add(page)
  }
  await writeJson(root, journalPath, { revocations, pages: [...pages] } satisfies CleanupIntent)
}
export async function resumeRevocationCleanup(root: string): Promise<void> {
  if (!await readOptional(await safePath(root, journalPath))) return
  await withoutStorageGeneration(() => withRevocationLock(root, async () => {
    const intent = await readOptional<CleanupIntent>(await safePath(root, journalPath))
    if (!intent) return
    await checkWriter(root)
    const existing = await readOptional<Revocations>(await safePath(root, 'state/revocations.json'))
    if (!existing || existing.generation < intent.revocations.generation) await writeJson(root, 'state/revocations.json', intent.revocations)
    const revocations = existing && existing.generation > intent.revocations.generation ? existing : intent.revocations
    const pages = new Set(intent.pages), files = new Set<string>(), vectors = new Set<string>()
    const current = await readOptional<CurrentVersion>(await safePath(root, 'state/current.json'))
    let active: SnapshotManifest | undefined
    for (const file of await listFiles(root, 'versions')) if (/^versions\/v\d{6,}\.json$/.test(file)) {
      const manifest = await readVersion(root, file.slice(9, -5))
      for (const page of await cleanManifest(root, manifest, revocations)) pages.add(page)
      references(manifest, files, vectors)
      if (manifest.version === current?.version) active = manifest
    }
    if (active?.topics) await writeJson(root, 'state/topics.json', active.topics)
    else await remove(root, 'state/topics.json')
    // 中间成果未发布，撤权使其基线失效；不保留无法证明来源的半成品或临时字节。
    for (const file of await listFiles(root, 'work')) await remove(root, file)
    for (const file of await listFiles(root, 'logs/failures')) await remove(root, file)
    const log = await readFile(await safePath(root, 'logs/build.md'), 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    // 旧日志的多行正文没有可靠的记录边界，只保留身份、哈希和计数。
    if (log !== undefined) await atomicWrite(root, 'logs/build.md', '# 建库历史\n'
      + `- 历史日志哈希：${hash(log)}；字节数：${Buffer.byteLength(log)}\n`
      + revocations.sources.map(item => `- revoke | ${item.source_id} | 代次 ${item.generation}\n`).join(''))
    for (const file of await listFiles(root, 'logs')) if (file !== 'logs/build.md') await remove(root, file)
    const reading = await readOptional<ReadingCopyState>(await safePath(root, 'state/reading-copy.json'))
    for (const page of pages) {
      if (page !== 'index.md' && !/^(sources|topics|terms)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.md$/.test(page)) throw new Error('撤权阅读页路径无效。')
      const bytes = await readFile(await safePath(root, 'wiki/' + page)).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
      if (bytes && hash(bytes) !== reading?.materialized[page]) await writeJson(root, `conflicts/${hashName(hash('revoke\0' + page + '\0' + revocations.generation))}.json`, { page, generation: revocations.generation, reason: '因撤权移除', detected_at: new Date().toISOString() })
      await remove(root, 'wiki/' + page)
      if (reading) { delete reading.materialized[page]; delete reading.desired?.[page]; delete reading.failures[page] }
    }
    if (reading) { reading.version = null; reading.target = null; delete reading.desired; await writeJson(root, 'state/reading-copy.json', reading); references(reading, files, vectors) }
    for (const file of await listFiles(root, 'conflicts')) if (file.endsWith('.json')) {
      const conflict = await readOptional<{ page?: string }>(await safePath(root, file))
      if (conflict?.page && pages.has(basePage(conflict.page))) await writeJson(root, file, { page: conflict.page, generation: revocations.generation, reason: '因撤权移除' })
      else references(conflict, files, vectors)
    }
    // 查询的读写也持有同一锁，SQLite 句柄已关闭；删除文件同时清除 FTS、空闲页和 WAL。
    await (await import('../storage/jobs.js')).invalidateLayeredIndex(root)
    for (const file of await listFiles(root, 'cache')) await remove(root, file)
    for (const file of [...await listFiles(root, 'versions'), ...await listFiles(root, 'wiki'), ...await listFiles(root, 'state')]) {
      if (/\.json\.[a-f0-9-]{36}\.tmp$/.test(file) && /^(versions\/|state\/(topics|embeddings|reading-copy)\.json\.)/.test(file)
        || file.endsWith('.tmp') && [...pages].some(page => file.startsWith('wiki/' + page + '.'))) await remove(root, file)
    }
    for (const file of await listFiles(root, 'objects')) if (!files.has(file)) await remove(root, file)
    const cache = await readOptional<{ vectors: Record<string, { vector_id: string }> }>(await safePath(root, 'state/embeddings.json'))
    if (cache) { cache.vectors = Object.fromEntries(Object.entries(cache.vectors).filter(([, value]) => files.has(vectorPath(value.vector_id)))); await writeJson(root, 'state/embeddings.json', cache) }
    // 只有所有物理清除均完成才提交完成标记；任一步失败保留待办并向调用者报错。
    await remove(root, journalPath)
  }))
}
