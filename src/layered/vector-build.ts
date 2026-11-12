import { embeddingEndpoint, layeredSettings } from '../domain/config.js'
import { cachedPointVectors } from './embedding.js'
import { lexicalInputHash } from './lexical-vectors.js'
import { cloudEmbeddingHelp, createEmbeddingClient } from './cloud-embedding.js'
import { hash, writeJson } from './files.js'
import { publishedPage } from './objects.js'
import { readExtraction } from './publication.js'
import { hydrateVectors, readVectorRecord, vectorUnavailable } from './vectors.js'
import { detectOllama, embeddingHelp, embeddingLoadingHelp, hasVectorMode, libraryVectorState, lockedEmbeddingSettings, probeIdentity, recordIdentity, sameIdentity, selection } from './vector-identity.js'
import type { BuildLayeredOptions, LibraryVectorState, PendingBuild, SnapshotManifest, TopicState } from './schema.js'

// 向量服务恢复与显式切换允许接续已提取断点；其他登记或策略变化仍由原护栏拒绝。
export function sameExtractionContext(left: NonNullable<PendingBuild['preview_context']>, right: NonNullable<PendingBuild['preview_context']>): boolean {
  if (left.policyRevision !== right.policyRevision) return false
  const withoutVectorSettings = (key: string) => {
    const registration = JSON.parse(key)
    if (registration.layered) {
      for (const field of ['embeddingMode', 'embeddingUnavailable', 'embeddingChangeToken', 'localEmbeddingUrl', 'localEmbeddingModel', 'cloudEmbeddingUrl', 'cloudEmbeddingModel', 'cloudEmbeddingKeyEnv', 'vectorPrecision', 'embeddingBatchSize', 'embeddingBatchBytes', 'embeddingTimeoutMs']) delete registration.layered[field]
      if (!Object.keys(registration.layered).length) delete registration.layered
    }
    return JSON.stringify(registration)
  }
  try { return withoutVectorSettings(left.registrationKey) === withoutVectorSettings(right.registrationKey) }
  catch { return left.registrationKey === right.registrationKey }
}

export async function prepareVectorRun(root: string, pending: PendingBuild, committed: SnapshotManifest, options: BuildLayeredOptions, hasInputs = true): Promise<BuildLayeredOptions> {
  const settings = layeredSettings(options.topics || {}, options.tier), requested = selection(settings)
  if (options.topics === false) requested.mode = 'none'
  const prior = await libraryVectorState(root, committed, options.topics || {})
  const saved = pending.manifest.vector_state
  // 未提交代次优先续跑，已发布身份在本库内保持不变。
  const old = saved ?? prior
  // 已锁定身份只允许在副本中切换；登记或本机偏好不能改变它。
  const switching = old?.mode === 'unselected'
  const target: LibraryVectorState = old && !switching ? structuredClone(old) : {
    mode: options.topics === false || settings.embeddingMode === 'none' ? 'none' : settings.embeddingMode === 'cloud' ? 'cloud' : 'ollama', generation: (prior?.generation ?? 0) + 1,
    selection: requested, coverage: { embedded: [], missing: [] }, pending_points: [],
  }
  pending.manifest.vector_state = target
  if (!hasInputs && !target.identity && hasVectorMode(target.mode)) {
    target.mode = 'unselected'; target.generation = 0; target.message = '尚无可嵌入的要点或术语；有有效输入时再选择向量身份。'
    return { ...options, vectorDeferred: true }
  }
  if (target.mode === 'none') {
    settings.embeddingMode = 'none'
    delete target.page_vectors; delete target.message
    const local = { ...options, vectorDeferred: options.topics === false, topics: options.topics === false ? false as const : settings }
    delete local.embeddingClient; delete local.vectorIdentity
    return local
  }
  if (target.mode === 'unresolved') {
    target.message = '旧库向量身份无法恢复，请由写入端在设置中显式确认修复；当前只提供全文检索。'
    return { ...options, vectorDeferred: true }
  }
  try {
    if (target.identity) lockedEmbeddingSettings(settings, target.identity)
    if (!options.embeddingClient && settings.embeddingMode !== 'cloud') {
      const available = await detectOllama(settings, false, options.signal)
      settings.localEmbeddingModel = available.model
    }
    target.mode = settings.embeddingMode === 'cloud' ? 'cloud' : 'ollama'
    const client = options.embeddingClient ?? createEmbeddingClient(settings)
    target.identity = await probeIdentity(client, settings, options.signal, target.identity)
    delete target.message
    await writeJson(root, 'work/pending.json', pending)
    return { ...options, topics: settings, embeddingClient: client, vectorIdentity: target.identity }
  } catch (error) {
    options.signal?.throwIfAborted()
    // 新库自动没有可用模型时保持待选，不能悄悄固定为全文。
    if (!target.identity) {
      await writeJson(root, 'work/pending.json', pending)
      throw new Error(settings.embeddingMode === 'cloud' ? cloudEmbeddingHelp : error instanceof Error && error.message === embeddingLoadingHelp ? embeddingLoadingHelp : embeddingHelp, { cause: error })
    }
    target.message = target.identity.provider === 'ollama' ? `更新建库已暂停。本库使用 ${target.identity.model}，请先执行 ollama pull ${target.identity.model}；若已安装，请检查向量服务及权重身份。` : `更新建库已暂停。本库使用 ${target.identity.model}，请检查云端向量服务和凭据。`
    pending.paused = { reason: 'embedding', message: target.message, at: new Date().toISOString() }
    await writeJson(root, 'work/pending.json', pending)
    throw new Error(target.message, { cause: error })
  }
}

export async function updateVectorCoverage(root: string, pending: PendingBuild): Promise<void> {
  const state = pending.manifest.vector_state
  if (!state) return
  const points = (await Promise.all(pending.manifest.sources.map(source => readExtraction(root, source.extract.path)))).flatMap(extract => extract.segments.flatMap(segment => segment.points))
  const lexical = state.identity?.provider === 'lexical'
  const inputHash = (point: typeof points[number]) => lexical ? lexicalInputHash(point, pending.manifest.point_labels) : hash(point.text)
  const cached = state.identity && !lexical ? await cachedPointVectors(root, points, state.identity, pending.manifest.topics?.embedding.url) : {}
  const vectors = { ...pending.manifest.topics?.vectors, ...pending.topics?.state.vectors, ...cached }
  if (pending.topics) pending.topics.state.vectors = Object.fromEntries(points.flatMap(point => vectors[point.point_id]?.input_hash === inputHash(point) ? [[point.point_id, vectors[point.point_id]!]] : []))
  const embedded: string[] = [], missing: string[] = []
  const records = new Map<string, ReturnType<typeof readVectorRecord>>()
  for (const point of points) {
    const reference = vectors[point.point_id]
    if (state.identity && reference?.vector_id && reference.input_hash === inputHash(point)) {
      // 暖缓存已经核验身份与对象；同一轮直接复用，保留切换中旧引用的替换能力。
      if (cached[point.point_id]) { embedded.push(point.point_id); continue }
      try {
        // 同文本的多来源要点共享对象；本轮只核验一次，下一轮仍重新检查文件。
        if (!records.has(reference.vector_id)) records.set(reference.vector_id, readVectorRecord(root, reference.vector_id))
        const record = await records.get(reference.vector_id)!
        if (record.identity.input_hash === inputHash(point) && sameIdentity(state.identity, recordIdentity(record, pending.manifest.topics?.embedding.url))) { embedded.push(point.point_id); continue }
      }
      catch (error) { if (!vectorUnavailable(error)) throw error }
    }
    missing.push(point.point_id)
  }
  state.coverage = { embedded: embedded.sort(), missing: missing.sort() }
  const assigned = new Set((pending.topics?.state.topics ?? []).filter(topic => !topic.archived).flatMap(topic => topic.point_ids))
  state.pending_points = points.filter(point => point.verification?.status !== 'unverified' && !assigned.has(point.point_id)).map(point => point.point_id).sort()
}

// 语义服务离线时冻结有效旧树；词项主题运行时仅保留原有术语页。
// 来源改变的页面及父页撤下，完整要点仍在来源页。
export async function deferVectorStages(root: string, pending: PendingBuild, committed: SnapshotManifest, options: BuildLayeredOptions, termsOnly = false): Promise<void> {
  const settings = layeredSettings(options.topics || {}, options.tier), state = pending.manifest.vector_state!
  const previousIdentity = (await libraryVectorState(root, committed, options.topics || {}))?.identity
  if (state.mode !== 'none' && state.mode !== 'unselected' && (settings.embeddingUnavailable !== 'continue'
    || previousIdentity && !sameIdentity(previousIdentity, state.identity))) {
    await updateVectorCoverage(root, pending)
    const message = state.mode === 'cloud' ? '云端向量服务不可用，主题聚类已暂停。' : '本地向量模型不可用，主题聚类已暂停。'
    pending.paused = { reason: 'embedding', message, at: new Date().toISOString() }
    await writeJson(root, 'work/pending.json', pending)
    throw new Error(message)
  }
  const changed = new Set(committed.sources.filter(source => pending.manifest.sources.find(item => item.source_id === source.source_id)?.extract.path !== source.extract.path).map(source => source.source_id))
  const deps = committed.deps?.pages ?? {}, kept = new Set(Object.keys(deps).filter(page => !page.startsWith('sources/') && page !== 'index.md'
    && !committed.rebuild_pages?.includes(page.split('#')[0]!) && !deps[page]!.sources.some(id => changed.has(id))))
  for (;;) {
    const size = kept.size
    for (const page of kept) if (deps[page]!.children?.some(child => !kept.has(child.page))) kept.delete(page)
    if (size === kept.size) break
  }
  const pages: NonNullable<PendingBuild['topics']>['pages'] = {}, termPages: NonNullable<PendingBuild['terms']>['pages'] = {}, sections: NonNullable<PendingBuild['terms']>['section_dependencies'] = {}
  for (const page of [...kept].sort()) {
    if (termsOnly && !page.startsWith('terms/')) continue
    if (page.includes('#')) { sections[page] = structuredClone(deps[page]!); continue }
    const value = { content: await publishedPage(root, committed.version!, page), dependencies: structuredClone(deps[page]!) }
    if (page.startsWith('topics/')) pages[page] = value
    if (page.startsWith('terms/')) termPages[page] = value
  }
  if (!termsOnly) {
    const topics: TopicState = await hydrateVectors(root, structuredClone(committed.topics ?? { format_version: 1, version: committed.version, next_topic_number: 1,
      embedding: embeddingEndpoint(settings), topics: [], vectors: {} }), true)
    topics.topics = topics.topics.filter(topic => kept.has(topic.path))
    const valid = new Map((await Promise.all(pending.manifest.sources.map(source => readExtraction(root, source.extract.path)))).flatMap(extract => extract.segments.flatMap(segment => segment.points)).map(point => [point.point_id, point]))
    topics.vectors = Object.fromEntries(Object.entries(topics.vectors).filter(([id, value]) => valid.has(id) && value.input_hash === hash(valid.get(id)!.text)))
    pending.topics = { fingerprint: '', state: topics, pages, rewritten: [], model_calls: 0, aliases: committed.aliases ?? {} }
  }
  pending.terms = { fingerprint: '', records: Object.values(termPages).flatMap(page => page.dependencies.terms ?? []), pages: termPages, section_dependencies: sections, rewritten: [], model_calls: 0 }
  if (termsOnly) return
  await updateVectorCoverage(root, pending)
  state.page_vectors = Object.fromEntries(Object.entries(committed.vector_state?.page_vectors ?? {}).filter(([page]) => kept.has(page)))
  state.message ??= state.mode === 'none' ? '不使用向量：查询仅走全文，主题生成已关闭，新增或变化要点保留在来源页。' : '向量服务不可用：新增或变化要点待归属主题，恢复后自动补齐。'
  await writeJson(root, 'work/pending.json', pending)
}

export async function preparePageVectors(root: string, pending: PendingBuild, files: [string, string][], options?: BuildLayeredOptions): Promise<void> {
  const state = pending.manifest.vector_state
  if (!state || !hasVectorMode(state.mode) || options?.vectorDeferred || !options?.embeddingClient || !state.identity) return
  const points = pending.topics?.state.vectors ?? {}
  state.page_vectors = {}
  for (const [page] of files) {
    const dependency = pending.topics?.pages[page]?.dependencies ?? pending.terms?.pages[page]?.dependencies
    const ids = page === 'index.md' ? Object.keys(points) : page.startsWith('sources/')
      ? Object.keys(points).filter(id => id.startsWith(page.slice(8, -3) + ':')) : dependency?.points.map(point => point.point_id) ?? []
    const refs = [...ids.flatMap(id => points[id]?.vector_id ? [points[id]!] : []),
      ...(dependency?.terms ?? []).flatMap(term => term.contributions),
      ...(pending.terms?.records.find(term => page === `terms/${term.id}.md`)?.contributions ?? [])]
    const vectors = [...new Map(refs.flatMap(ref => ref.vector_id ? [[ref.vector_id, { vector_id: ref.vector_id, input_hash: 'input_hash' in ref ? ref.input_hash : hash([ref.name, ...ref.aliases].join('；')) }]] as const : [])).values()]
    if (vectors.length) state.page_vectors[page] = { vectors }
  }
}
