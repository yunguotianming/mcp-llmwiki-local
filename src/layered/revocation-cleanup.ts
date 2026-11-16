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
import { artifactId, isProductionFormat, protocolDigest, protocolError, readProtocol, sidecarPath, writeProtocol, writeProvenance } from './models.js'
import type { AcceptanceSnapshot, AttemptEntry, VersionProvenance } from './schema.js'
import type { VersionCosts } from './costs.js'
import { modelRetentionRoots } from './costs.js'

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
  if (manifest.topic_gaps) manifest.topic_gaps = manifest.topic_gaps.filter(gap => !gap.point_ids.some(id => revoked.has(sourceOf(id))))
  if (manifest.topic_recovery) {
    const recovery = manifest.topic_recovery
    const removed = new Set(recovery.topics.filter(topic => topic.point_ids.some(id => revoked.has(sourceOf(id)))).map(topic => topic.id))
    recovery.topics = recovery.topics.filter(topic => !removed.has(topic.id))
    recovery.repairs = Object.fromEntries(Object.entries(recovery.repairs).filter(([id, state]) => !removed.has(id) && !state.member_ids.some(point => revoked.has(sourceOf(point)))))
  }
  if (manifest.point_labels) manifest.point_labels = Object.fromEntries(Object.entries(manifest.point_labels).filter(([id]) => !revoked.has(sourceOf(id))))
  // 旧归并表不含逐标签来源，撤权后不能继续携带可能来自被撤资料的别名。
  if (await isProductionFormat(root)) delete manifest.tag_merges
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
      delete dependency.claims
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
async function cleanProductionVersion(root: string, manifest: SnapshotManifest, revocations: Revocations): Promise<void> {
  if (!await isProductionFormat(root)) return
  const version = manifest.version!, file = sidecarPath(version, 'provenance')
  const saved = await readProtocol<{ checksum: string; provenance: VersionProvenance }>(root, file, 'PROVENANCE_INCOMPLETE')
  if (!saved || protocolDigest(saved.provenance) !== saved.checksum) throw protocolError('PROVENANCE_INCOMPLETE', '撤权生产记录缺失。')
  const value = saved.provenance, artifacts: VersionProvenance['artifacts'] = {}, needed = new Set<string>()
  const revoked = new Set(revocations.sources.filter(item => (manifest.sources.find(source => source.source_id === item.source_id)?.revocation_generation ?? -1) < item.generation).map(item => item.source_id))
  for (const item of Object.values(value.artifacts)) {
    if (item.sourceRefs.some(ref => revoked.has(ref.sourceId))) continue
    if (item.kind === 'extraction' && !manifest.sources.some(source => source.extract.path === item.objectPath)) continue
    if (item.kind === 'page') {
      const digest = manifest.pages?.[item.pagePath!]
      if (!digest) continue
      if (digest !== item.objectDigest) {
        if (item.pagePath !== 'index.md') continue
        item.objectDigest = digest; item.objectPath = `objects/pages/${digest.slice(7)}.md`
        item.status = 'local-derived'; item.productionIds = []; item.inheritedFrom = null
      }
    }
    artifacts[artifactId(item)] = item
  }
  const digest = manifest.pages?.['index.md']
  if (digest && !Object.values(artifacts).some(a => a.pagePath === 'index.md')) {
    const item = { kind: 'page' as const, objectPath: `objects/pages/${digest.slice(7)}.md`, objectDigest: digest, pagePath: 'index.md', sourceRefs: [], status: 'local-derived' as const, productionIds: [], inheritedFrom: null }
    artifacts[artifactId(item)] = item
  }
  const visit = (id: string) => { if (needed.has(id)) return; needed.add(id); for (const parent of value.records[id]?.parentProductionIds ?? []) visit(parent) }
  for (const item of Object.values(artifacts)) for (const id of [...item.productionIds, ...(item.inheritedFrom?.productionIds ?? [])]) visit(id)
  value.artifacts = artifacts; value.records = Object.fromEntries([...needed].map(id => [id, value.records[id]!]))
  value.manifestChecksum = hash(storageJson(manifest)); value.revocationGeneration = manifest.revocation_generation
  await writeProvenance(root, value)
  const costFile = sidecarPath(version, 'costs'), cost = await readProtocol<{ checksum: string; costs: VersionCosts }>(root, costFile, 'PROVENANCE_INCOMPLETE')
  if (!cost || protocolDigest(cost.costs) !== cost.checksum) throw protocolError('PROVENANCE_INCOMPLETE', '撤权成本汇总缺失。')
  cost.costs.manifestChecksum = value.manifestChecksum
  await writeProtocol(root, costFile, { checksum: protocolDigest(cost.costs), costs: cost.costs })
}
async function cleanAcceptances(root: string, revocations: Revocations): Promise<void> {
  for (const file of await listFiles(root, 'logs/model-accepts')) {
    if (!/\/[a-f0-9]{64}\.json$/.test(file)) continue
    const snapshot = await readProtocol<AcceptanceSnapshot>(root, file, 'ACCEPT_PREPARE_CORRUPT')
    if (!snapshot) continue
    const generation = snapshot.record.identity.revocationGeneration
    const refs = [...snapshot.record.identity.scope.sourceRefs, ...snapshot.record.dependencies.flatMap(d => d.sourceRefs)]
    if (!refs.some(ref => revocations.sources.some(item => item.source_id === ref.sourceId && item.generation > generation))) continue
    await remove(root, `work/accepted/tasks/${snapshot.taskId.slice(2)}.json`)
    await remove(root, file)
  }
  // 先前中断可能已移除准备文件；接受索引与其依赖也独立核对。
  for (const file of await listFiles(root, 'work/accepted/tasks')) {
    const record = await readOptional<import('./schema.js').AcceptedRecord>(await safePath(root, file))
    if (record && [...record.identity.scope.sourceRefs, ...record.dependencies.flatMap(d => d.sourceRefs)].some(ref => revocations.sources.some(r => r.source_id === ref.sourceId && r.generation > record.identity.revocationGeneration))) {
      await remove(root, file)
    }
  }
  const retained = await modelRetentionRoots(root)
  const upgrade = await readProtocol<import('./upgrade.js').UpgradeStatus>(root, 'work/upgrade-0.3.0.json', 'UPGRADE_CHECKPOINT_CORRUPT')
  if (upgrade) {
    upgrade.accepted = Object.fromEntries(Object.entries(upgrade.accepted).filter(([, ref]) => retained.tasks.has(ref.taskId)))
    await writeProtocol(root, 'work/upgrade-0.3.0.json', upgrade)
  }
  for (const file of await listFiles(root, 'logs/model-runs')) {
    if (!/\/attempts\/[1-9]\d*\.json$/.test(file)) continue
    const entry = await readProtocol<AttemptEntry>(root, file, 'MODEL_LEDGER_CORRUPT')
    if (!entry) continue
    entry.accepts = entry.accepts.filter(ref => retained.tasks.has(ref.taskId))
    await writeProtocol(root, file, entry)
  }
  for (const file of await listFiles(root, 'work/accepted/objects')) if (!retained.outputs.includes(file)) await remove(root, file)
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
      const manifest = await readVersion(root, file.slice(9, -5), false)
      for (const page of await cleanManifest(root, manifest, revocations)) pages.add(page)
      await cleanProductionVersion(root, manifest, revocations)
      references(manifest, files, vectors)
      if (manifest.version === current?.version) active = manifest
    }
    if (active?.topics) await writeJson(root, 'state/topics.json', active.topics)
    else await remove(root, 'state/topics.json')
    // 中间成果未发布，撤权使其基线失效；不保留无法证明来源的半成品或临时字节。
    await cleanAcceptances(root, revocations)
    for (const file of await listFiles(root, 'work')) if (!file.startsWith('work/accepted/') && file !== 'work/upgrade-0.3.0.json') await remove(root, file)
    for (const file of (await modelRetentionRoots(root)).outputs) files.add(file)
    for (const file of await listFiles(root, 'logs/failures')) await remove(root, file)
    const log = await readFile(await safePath(root, 'logs/build.md'), 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    // 旧日志的多行正文没有可靠的记录边界，只保留身份、哈希和计数。
    if (log !== undefined) await atomicWrite(root, 'logs/build.md', '# 建库历史\n'
      + `- 历史日志哈希：${hash(log)}；字节数：${Buffer.byteLength(log)}\n`
      + revocations.sources.map(item => `- revoke | ${item.source_id} | 代次 ${item.generation}\n`).join(''))
    for (const file of await listFiles(root, 'logs')) if (file !== 'logs/build.md' && !file.startsWith('logs/model-accepts/') && !file.startsWith('logs/model-runs/')) await remove(root, file)
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
