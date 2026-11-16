import { pageRelevance, searchConfidence } from './relevance.js'
import { readVectorRecord, vectorUnavailable } from '../layered/vectors.js'
import { hasVectorMode, identityKey, libraryVectorState, lockedEmbeddingSettings, queryInput, recordIdentity, sameIdentity } from '../layered/vector-identity.js'
import path from 'node:path'
import { layeredSettings } from '../domain/config.js'
import type { LibraryRegistration } from '../domain/config.js'
import { signature } from '../storage/files.js'
import { layeredIndex } from '../storage/jobs.js'
import type { IndexRow } from '../storage/jobs.js'
import { cachedPointVectors, centroid, normalized, similarity } from '../layered/embedding.js'
import { createEmbeddingClient } from '../layered/cloud-embedding.js'
import { embeddingReadiness, embeddingTimedOut, type EmbeddingReadiness } from '../layered/embedding-readiness.js'
import type { EmbeddingClient, LibraryCard, EmbeddingIdentity, PendingTopicReview, Point } from '../layered/schema.js'
import { validSourceId, withLayeredRead } from '../layered/revocations.js'
import { withStateLayout } from '../storage/paths.js'
import { SiyuanAdapter, validateSiyuanRoot, WikiExportClient } from '../layered/siyuan.js'
import type { LayeredReadOptions, LayeredReadResult, LayeredReadView } from '../layered/revocations.js'
import { terms } from './identity-search.js'
import type { WikiPage } from './query.js'
import { excerpts, fuseRanks, stripBlockIds } from './page-search.js'
import type { EvidenceSegment, PageExcerpt, SearchNotice, SearchOptions } from './page-search.js'
import { browsePages } from './browse.js'
import type { BrowseOptions } from './browse.js'
import { readExtraction } from '../layered/publication.js'
import { evidenceBlockIds } from '../layered/anchors.js'
import type { PointMatch } from './page-search.js'
import { PageMetadataError, pageMetadata } from './page-metadata.js'

export interface LayeredLibrary { root: string; card: Omit<LibraryCard, 'origin_type'> & { origin_type: 'local' | 'siyuan' } }
export interface PageReadOptions extends LayeredReadOptions { offset?: number | undefined }
export interface SourceReadOptions extends PageReadOptions { sourceVersion?: string | undefined; maxChars?: number | undefined }
interface IndexedPage extends WikiPage {
  warning?: string
  pendingReview?: PendingTopicReview
  id: string; sources: string[]; sourceVersions: { sourceId: string; sourceVersion: string }[]
  sourceDate: string; sourceType: string; credibility: string; version: string; currentVersion: string; vector: number[]
  pointVectors: number[][]; vectorIds: string[]; pointVectorIds: string[]
}
export type LayeredSearchHit = Omit<IndexedPage, 'content' | 'hash' | 'links' | 'vector' | 'pointVectors' | 'vectorIds' | 'pointVectorIds'> & { score: number; relevance: number; snippet: string; snippetSegments: EvidenceSegment[]; anchor: string; page_ref: string; topic_path: string; score_channels: Record<string, number>; excerpts: PageExcerpt[]; status: 'ok'; retrieval: 'fts' | 'vector' | 'hybrid' }
export type SearchDegradation = SearchNotice
type StoredPage = Pick<IndexedPage, 'path' | 'hash' | 'title' | 'type' | 'aliases' | 'id' | 'vectorIds' | 'pointVectorIds'> & { topic_path: string }
function storedPage(page: IndexedPage): StoredPage {
  const { path: relative, hash, title, type, aliases, id, vectorIds, pointVectorIds } = page
  return { path: relative, hash, title, type, aliases, id, vectorIds, pointVectorIds, topic_path: relative.startsWith('topics/') ? relative : '' }
}
function embeddingFailure(error: unknown, timeoutMs: number): string {
  const seen = new Set<unknown>(), messages: string[] = []
  while (error instanceof Error && !seen.has(error)) {
    seen.add(error); messages.push(error.name + ' ' + error.message); error = error.cause
  }
  const message = messages.join(' ')
  if (/TimeoutError|ETIMEDOUT|超时/i.test(message)) return `向量请求超时（查询最多等待 ${timeoutMs / 1000} 秒）`
  if (/HTTP 404|模型缺失/i.test(message)) return '嵌入模型缺失（HTTP 404）'
  if (/身份|权重|前处理/.test(message)) return '本机向量身份与本库不符或缺失'
  if (/TypeError|ECONN|fetch failed|连接|不可达/i.test(message)) return '向量服务连接失败'
  return '向量服务或返回向量不可用'
}
const embeddingFailures = new Map<string, { until: number; reason: string }>()
const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
const text = (value: unknown): string => typeof value === 'string' ? value : ''
const normalize = (value: string) => value.normalize('NFKC').replace(/\.md$/i, '').toLowerCase()

export function paginate(result: LayeredReadResult, maxChars: number, offset = 0) {
  if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxChars) || maxChars < 1) throw new Error('分页 offset 必须是非负整数，maxChars 必须是正整数。')
  const end = Math.min(result.content.length, offset + Math.min(100000, maxChars))
  if (result.status !== 'ok') return { ...result, truncated: false, next_offset: null }
  return { ...result, content: result.content.slice(offset, end), truncated: end < result.content.length, next_offset: end < result.content.length ? end : null }
}
function pageValue(library: LibraryRegistration, view: LayeredReadView, relative: string, raw: string): IndexedPage {
  const { header, content } = pageMetadata(raw, relative), sources = (view.deps.pages[relative] ?? view.deps.pages[relative.split('#')[0]!])?.sources ?? []
  const pendingReview = view.pendingReview(relative)
  const type = relative === 'index.md' ? 'navigation' : relative.includes('#') ? relative.startsWith('sources/') ? 'source' : 'term'
    : header.page_type === 'index' && relative.startsWith('terms/index-') ? 'term-index' : text(header.page_type)
  if (!['source', 'topic', 'term', 'term-index', 'navigation'].includes(type)) throw new PageMetadataError(relative)
  return { library: library.name, path: relative, type: type as IndexedPage['type'], id: text(header.id), title: text(header.title) || /^#\s+(.+)$/m.exec(content)?.[1] || relative,
    aliases: strings(header.aliases), tags: strings(header.tags), updated: text(header.updated), content, summary: stripBlockIds(content).replace(/^#+\s*/gm, '').replace(/\s+/g, ' ').trim().slice(0, 240),
    hash: signature(raw), links: [], sources, ...(pendingReview ? { pendingReview } : {}), ...(view.warning ? { warning: view.warning } : {}), sourceVersions: sources.map(sourceId => ({ sourceId, sourceVersion: view.manifest.sources.find(source => source.source_id === sourceId)?.source_version ?? '' })),
    sourceDate: text(header.source_date), sourceType: text(header.source_type), credibility: text(header.credibility), version: view.version, currentVersion: view.current.version, vector: [], pointVectors: [], vectorIds: [], pointVectorIds: [] }
}
// 向量记录对象由已校验对象缓存按文件元数据复用，内容不可变；同一记录的归一化结果跟随记录对象复用，记录被淘汰或文件变化时一并失效。
// 返回的数组被多个查询共享，调用方只读不改（相似度与质心计算都不改写输入）。
const normalizedRecords = new WeakMap<object, number[]>()
function normalizedRecord(record: { vector: number[] }): number[] {
  let value = normalizedRecords.get(record)
  if (!value) { value = normalized(record.vector); normalizedRecords.set(record, value) }
  return value
}
async function run<T>(root: string, options: LayeredReadOptions, action: (view: LayeredReadView) => Promise<T>) {
  // 一次查询要解析上千个库内路径；布局在本次读取开始时确定，与写入路径相同，每个目标仍单独解析真实路径并校验边界。
  // 布局只会在停止写入后由迁移改变，查询期间不变；查询结束即失效，下一次查询重新识别。
  return withStateLayout(root, () => withLayeredRead(root, async view => ({ value: await action(view), view }), { ...options, filterConflicts: true }))
}
async function admission(library: LibraryRegistration, layered: LayeredLibrary, signal?: AbortSignal): Promise<void> {
  if (layered.card.origin_type !== 'siyuan') return
  if (!library.siyuan) throw new Error('思源库缺少准入设置，拒绝读取；请走 keeper_notes 回源。')
  await validateSiyuanRoot(layered.root, library.siyuan)
  await new SiyuanAdapter(new WikiExportClient(library.id, library.siyuan)).checkAdmission(layered.root, signal)
}
export class LayeredQuery {
  constructor(private readonly embeddingClient?: EmbeddingClient, private readonly readiness: EmbeddingReadiness = embeddingReadiness) {}
  async browse(library: LibraryRegistration, layered: LayeredLibrary, ref: string, options: BrowseOptions, signal?: AbortSignal) {
    return run(layered.root, { signal, checkAdmission: () => admission(library, layered, signal) }, view => browsePages(view, library.name, ref, options))
  }
  async catalog(library: LibraryRegistration, layered: LayeredLibrary, signal?: AbortSignal) {
    return run(layered.root, { signal, checkAdmission: () => admission(library, layered, signal) }, async view => {
      const pages = Object.keys(view.deps.pages).filter(page => !page.includes('#')), card = view.manifest.card!
      const termIds = new Set([...pages.filter(page => /^terms\/TM-/.test(page)).map(page => path.posix.basename(page, '.md')), ...Object.values(view.deps.pages).flatMap(page => (page.terms ?? []).map(term => term.id))])
      return { libraryId: library.id, name: library.name, description: library.description, path: library.wikiPath, mode: library.mode, pageCount: pages.length,
        cardName: card.name, domain: card.domain, originType: card.origin_type, sourceType: card.source_type, sourceCount: card.source_count,
        topicCount: pages.filter(page => page.startsWith('topics/')).length, termCount: termIds.size,
        updated: card.updated_at, version: view.version, navigationOnly: true, ...(view.warning ? { warning: view.warning } : {}) }
    })
  }
  async search(library: LibraryRegistration, layered: LayeredLibrary, query: string, types?: string[], signal?: AbortSignal, options: SearchOptions & { limit?: number } = {}) {
    if (!Number.isSafeInteger(options.limit ?? 8) || (options.limit ?? 8) < 1) throw new Error('检索条数必须为正整数。')
    const limit = Math.min(20, options.limit ?? 8)
    const queries = [query, ...options.variants ?? []], notices: SearchNotice[] = []
    const settings = layeredSettings(library.layered)
    let client: EmbeddingClient | undefined, locked: EmbeddingIdentity | undefined, failureKey = '', vectorEnabled = false
    const timeout = new AbortController(), callSignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal
    let timer: ReturnType<typeof setTimeout> | undefined, degradation: SearchDegradation | undefined
    let budgetMs = settings.queryEmbeddingColdTimeoutMs, remainingMs = budgetMs
    const degrade = (cause: unknown) => {
      signal?.throwIfAborted()
      if (degradation) return
      const timedOut = embeddingTimedOut(cause), reason = embeddingFailure(cause, budgetMs)
      degradation = { library: library.name, stage: 'embedding', retrieval: 'fts', reason, message: '已降级为关键词检索：' + reason }
      if (locked) this.readiness.failed(settings, cause)
      if (timedOut && locked?.provider === 'ollama') void this.readiness.warm(settings, this.embeddingClient, true)
      if (failureKey && !timedOut) {
        if (embeddingFailures.size >= 64) embeddingFailures.delete(embeddingFailures.keys().next().value!)
        embeddingFailures.set(failureKey, { until: Date.now() + 60000, reason })
      }
      console.warn(`[llmwiki] ${library.id}：${degradation.message}`)
    }
    const timed = async <T,>(action: () => Promise<T>): Promise<T> => {
      const started = performance.now()
      // 冷态或就绪期限只累计服务请求，读取页面和缺失向量不消耗服务期限。
      if (remainingMs <= 0) timeout.abort(new DOMException('嵌入查询超时', 'TimeoutError'))
      timer = setTimeout(() => timeout.abort(new DOMException('嵌入查询超时', 'TimeoutError')), Math.max(0, Math.ceil(remainingMs)))
      let cancelled: (() => void) | undefined
      try {
        callSignal.throwIfAborted()
        // 查询期限独立于建库重试；注入客户端不响应取消时也能及时返回 FTS。
        return await Promise.race([action(), new Promise<never>((_, reject) => {
          cancelled = () => reject(callSignal.reason)
          callSignal.addEventListener('abort', cancelled, { once: true })
          if (callSignal.aborted) cancelled()
        })])
      } finally {
        clearTimeout(timer); timer = undefined
        remainingMs -= performance.now() - started
        if (cancelled) callSignal.removeEventListener('abort', cancelled)
      }
    }
    const embed = async (input: string[]) => {
      if (degradation || !vectorEnabled || !client || !locked) return []
      try {
        const vectors = await timed(() => client!.embed(input.map(value => queryInput(value, locked!)), callSignal))
        if (vectors.length !== input.length || vectors.some(vector => vector.length !== locked!.dimensions)) throw new Error('嵌入结果数量或身份维度不匹配。')
        const result = vectors.map(normalized)
        this.readiness.ready(settings)
        return result
      } catch (cause) { degrade(cause); return [] }
    }
    try {
    const result = await run(layered.root, { signal, checkAdmission: () => admission(library, layered, signal) }, async view => {
      const vectorState = await libraryVectorState(layered.root, view.manifest, library.layered)
      locked = vectorState?.identity
      const pointIds = new Set(Object.values(view.deps.pages).flatMap(page => page.points.map(point => point.point_id)))
      const references = { ...view.manifest.topics?.vectors }
      const pointReference = (id: string) => references[id]?.vector_id
      const identity = locked ? identityKey(locked) : vectorState?.mode ?? 'unresolved'
      if (hasVectorMode(vectorState?.mode) && locked) {
        failureKey = JSON.stringify([layered.root, identity, settings.localEmbeddingUrl, settings.localEmbeddingModel, settings.embeddingMode,
          settings.cloudEmbeddingUrl, settings.cloudEmbeddingModel, view.version, view.generation])
        const cached = embeddingFailures.get(failureKey)
        if (cached && cached.until > Date.now()) degradation = { library: library.name, stage: 'embedding', retrieval: 'fts', reason: cached.reason, message: '已降级为关键词检索：' + cached.reason }
        else try {
          lockedEmbeddingSettings(settings, locked)
          const readiness = this.readiness.state(settings)
          budgetMs = remainingMs = readiness.status === 'ready' ? settings.queryEmbeddingTimeoutMs : settings.queryEmbeddingColdTimeoutMs
          client = this.embeddingClient ?? createEmbeddingClient({ ...settings, embeddingTimeoutMs: budgetMs }, fetch, 0)
          if (readiness.status === 'warming') {
            const warmed = await timed(() => readiness.result)
            if (warmed.status === 'failed') throw warmed.cause
          }
          if (await timed(() => client!.identity?.(callSignal) ?? Promise.resolve(undefined)) !== locked.revision) throw new Error('向量权重身份不符。')
          queryInput('', locked); vectorEnabled = true
        } catch (error) { degrade(error) }
      } else notices.push({ library: library.name, stage: 'embedding', retrieval: 'fts', reason: vectorState?.mode ?? 'unresolved',
        message: vectorState?.mode === 'none' ? '本库不使用向量，当前仅使用全文检索。' : vectorState?.message ?? '本库缺少向量身份，当前仅使用全文检索。' })
      // 历史主题映射可能漏收已有向量；只从当前可读要点回查已校验缓存，不补算资料。
      const recovered: Record<string, string> = {}
      if (vectorEnabled && locked) {
        const missing = new Set([...pointIds].filter(id => !pointReference(id)))
        const sourceIds = new Set([...missing].map(id => id.split(':')[0]!)), points: Point[] = []
        for (const source of view.manifest.sources) if (sourceIds.has(source.source_id)) {
          signal?.throwIfAborted()
          const extraction = await readExtraction(layered.root, source.extract.path)
          points.push(...extraction.segments.flatMap(segment => segment.points).filter(point => missing.has(point.point_id)))
        }
        if (points.length) for (const [id, reference] of Object.entries(await cachedPointVectors(layered.root, points, locked, view.manifest.topics?.embedding.url))) {
          references[id] = reference; recovered[id] = reference.vector_id!
        }
      }
      const stamp = JSON.stringify(['layered-query-v7', view.version, view.generation, identity, library.name, signature(JSON.stringify(recovered))])
      const archived = new Set(view.manifest.topics?.topics.filter(topic => topic.archived && !topic.point_ids.length).map(topic => topic.path))
      const rows = await layeredIndex<{ path: string; stamp: string; data: string }[]>(layered.root, 'index-read', {}, view.version, view.generation)
      // 单次读取视图内复用已校验的 Markdown；跨次查询仍必须重新回读并核对哈希。
      const documents = new Map<string, IndexedPage>()
      const invalidMetadata = new Set<string>()
      const readablePage = (relative: string, content: string) => {
        try { return pageValue(library, view, relative, content) }
        catch (error) {
          if (!(error instanceof PageMetadataError)) throw error
          if (!invalidMetadata.has(relative)) notices.push({ library: library.name, stage: 'index', reason: 'page-metadata-invalid',
            message: error.message + '；本次跳过该页，格式错误不代表内容无依据，其他来源及原文仍可读取。' })
          invalidMetadata.add(relative)
          return undefined
        }
      }
      let pages: IndexedPage[]
      if (rows.length && rows.every(row => row.stamp === stamp)) pages = rows.map(row => ({ ...JSON.parse(row.data), content: '', vector: undefined, pointVectors: undefined }) as IndexedPage)
      else {
        pages = []
        for (const relative of Object.keys(view.deps.pages).filter(page => !page.includes('#') && !archived.has(page)).sort()) {
          signal?.throwIfAborted()
          const result = await view.document(relative)
          if (result.status !== 'ok') continue
          const page = readablePage(relative, result.content), dependency = view.deps.pages[relative]!
          if (!page) continue
          documents.set(relative, page)
          const pointIds = dependency.points.flatMap(point => pointReference(point.point_id) ? [pointReference(point.point_id)!] : [])
          const derived = vectorState?.page_vectors?.[relative]
          page.vectorIds = derived ? derived.vectors.map(vector => vector.vector_id) : pointIds.length ? pointIds
            : (dependency.terms ?? []).flatMap(term => term.contributions.flatMap(item => item.vector_id ? [item.vector_id] : []))
          if (page.type === 'source') page.pointVectorIds = pointIds
          pages.push(page)
        }
        const tokenize = (value: string) => [...terms(value)].join(' ')
        // 索引只存页面和向量引用，服务离线不改变它；冲突仍强制重建，并保留可解析的代次。
        const storedStamp = view.conflicts.size || invalidMetadata.size ? JSON.stringify([...JSON.parse(stamp), view.conflicts.size ? 'conflicts' : 'metadata-invalid']) : stamp
        const updates: IndexRow[] = pages.map(page => ({ path: page.path, stamp: storedStamp, data: JSON.stringify(storedPage(page)), title: tokenize(page.title), aliases: tokenize(page.aliases.join(' ')), identity: tokenize(page.id + ' ' + storedPage(page).topic_path), body: tokenize(stripBlockIds(page.content)) }))
        await layeredIndex(layered.root, 'index-save', { pages: updates, removed: rows.filter(row => !pages.some(page => page.path === row.path)).map(row => row.path) }, view.version, view.generation)
      }
      const loaded = new Map<string, Promise<number[]>>(), availableVectors = new Set<string>()
      let missingVectors = 0
      const load = (id: string) => {
        if (!loaded.has(id)) loaded.set(id, readVectorRecord(layered.root, id).then(record => {
          if (!sameIdentity(locked, recordIdentity(record, view.manifest.topics?.embedding.url))) throw new Error('向量身份不符。')
          const vector = normalizedRecord(record)
          availableVectors.add(id)
          return vector
        }).catch(error => { if (!vectorUnavailable(error) && !(error instanceof Error && /向量.*身份/.test(error.message))) throw error; missingVectors++; return [] }))
        return loaded.get(id)!
      }
      for (const page of pages) {
        page.vector = vectorEnabled && page.vectorIds.length ? centroid((await Promise.all(page.vectorIds.map(load))).filter(vector => vector.length)) : []
        page.pointVectors = vectorEnabled ? (await Promise.all(page.pointVectorIds.map(load))).filter(vector => vector.length) : []
      }
      const covered = [...pointIds].filter(id => {
        const reference = pointReference(id)
        return reference && availableVectors.has(reference)
      })
      if (vectorEnabled && (missingVectors || covered.length < pointIds.size)) notices.push({ library: library.name, stage: 'embedding', reason: 'partial-coverage',
        message: `向量覆盖不完整（要点 ${covered.length}/${pointIds.size}）；缺失或身份不符的部分仅走全文。` })
      const ranks: { paths: string[]; weight: number; channel: string }[] = [], lexical = new Set<string>(), vectors = new Set<string>()
      const pointScores = new Map<string, number>()
      for (const [index, input] of queries.entries()) {
        const [vector] = await embed([input])
        const fts = await layeredIndex<{ path: string; score: number }[]>(layered.root, 'index-search', { query: [...terms(input)].slice(0, 64).map(term => '"' + term.replaceAll('"', '""') + '"').join(' OR ') }, view.version, view.generation)
        let semantic: { path: string; score: number }[] = []
        if (vector && !degradation) try {
          for (const id of pointIds) {
            const reference = pointReference(id)
            if (!reference || !availableVectors.has(reference)) continue
            const score = Math.round(similarity(vector, await load(reference)) * 1e6) / 1e6
            if (score >= 0.5) pointScores.set(id, Math.max(pointScores.get(id) ?? 0, score))
          }
          // 编码精度造成的微小误差视为同分，随后按路径稳定排序。
          semantic = pages.map(page => ({ path: page.path, score: Math.round(page.pointVectors.reduce((best, point) => Math.max(best, similarity(vector, point)), page.vector.length ? similarity(vector, page.vector) : -1) * 1e6) / 1e6 })).filter(item => item.score >= 0.5).sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, 200)
        } catch (cause) { degrade(cause) }
        for (const [channel, list] of [['fts', fts], ['vector', semantic]] as const) {
          list.forEach(item => (channel === 'fts' ? lexical : vectors).add(item.path))
          ranks.push({ paths: list.map(item => item.path), weight: index ? 0.5 : 1, channel: (index ? 'variant' + index : 'original') + ':' + channel })
        }
      }
      if (degradation) { vectors.clear(); pointScores.clear(); ranks.splice(0, ranks.length, ...ranks.filter(rank => rank.channel.endsWith(':fts'))) }
      const scores = fuseRanks(ranks), results: LayeredSearchHit[] = []
      const sourceAnchors = new Map<string, Promise<Map<string, string[]>>>(), pageMatches = new Map<string, PointMatch[]>()
      const anchorsFor = (sourceId: string) => {
        if (!sourceAnchors.has(sourceId)) {
          const source = view.manifest.sources.find(source => source.source_id === sourceId)
          sourceAnchors.set(sourceId, source ? readExtraction(layered.root, source.extract.path).then(extraction => evidenceBlockIds(extraction.segments.flatMap(segment => segment.points))) : Promise.resolve(new Map()))
        }
        return sourceAnchors.get(sourceId)!
      }
      let stale = false
      for (const page of pages) {
        if (!scores.has(page.path) || types?.length && !types.includes(page.type)) continue
        // 索引只是候选；缓存命中也必须经过统一正文过滤。
        let currentPage = documents.get(page.path)
        if (!currentPage) {
          const result = await view.document(page.path)
          if (result.status !== 'ok') continue
          currentPage = readablePage(page.path, result.content)
          if (!currentPage) continue
        }
        if (currentPage.hash !== page.hash) {
          stale = true; notices.push({ library: library.name, stage: 'index', reason: 'stale-index', message: '页面索引哈希已过期，已跳过；下次查询前重建：' + page.path }); continue
        }
        documents.set(page.path, currentPage)
        const matches: PointMatch[] = []
        for (const point of view.deps.pages[page.path]?.points ?? []) {
          const anchors = (await anchorsFor(point.point_id.split(':')[0]!)).get(point.point_id)
          if (anchors) matches.push({ anchors, score: pointScores.get(point.point_id) ?? 0 })
        }
        pageMatches.set(page.path, matches)
        const { content, hash: _hash, links: _links, vector: _vector, pointVectors: _pointVectors, vectorIds: _vectorIds, pointVectorIds: _pointVectorIds, ...value } = currentPage
        // 短片段同样从命中窗口取文；900 字节与原三百汉字的容量相当。
        const block = excerpts(currentPage, queries, 900, matches)[0], snippet = block?.content ?? ''
        results.push({ ...value, relevance: pageRelevance(query, { ...value, snippet }), ...scores.get(page.path)!, page_ref: page.path, topic_path: storedPage(page).topic_path, anchor: block?.anchor ?? '', snippet, snippetSegments: block?.segments ?? [], excerpts: [], status: 'ok', retrieval: lexical.has(page.path) ? vectors.has(page.path) ? 'hybrid' : 'fts' : 'vector' })
      }
      if (stale) await layeredIndex(layered.root, 'index-save', { removed: pages.map(page => page.path) }, view.version, view.generation)
      results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
      results.splice(limit)
      if (options.include !== 'hits') {
        let budget = options.excerpt_budget ?? 4000
        for (const hit of results.slice(0, options.excerpt_pages ?? 3)) {
          const page = documents.get(hit.path)!
          hit.excerpts = excerpts(page, queries, Math.floor(budget / Math.max(1, Math.min(options.excerpt_pages ?? 3, results.length) - results.indexOf(hit))), pageMatches.get(hit.path))
          budget -= hit.excerpts.reduce((sum, excerpt) => sum + excerpt.tokens, 0)
        }
      }
      return results
    })
    return { ...result, ...searchConfidence(result.value, settings.searchRelevanceThreshold), notices, ...(degradation ? { degradation } : {}) }
    } finally { clearTimeout(timer) }
  }
  async read(library: LibraryRegistration, layered: LayeredLibrary, ref: string, maxChars: number, options: PageReadOptions = {}) {
    return run(layered.root, { ...options, checkAdmission: () => admission(library, layered, options.signal) }, async view => {
      let relative: string | undefined
      if (ref.includes('/') || ref === 'index.md' || /^(?:S|T|TM|TI)-\d/.test(ref) || validSourceId(ref)) {
        // 未指定库时允许继续查找旧格式页面，仍不尝试读取任意文件。
        if (ref.includes('/') && !/^(?:sources\/(?:S-\d|\d{14}-)|topics\/T-\d|terms\/(?:TM-\d|index-\d))/.test(ref)) return undefined
        relative = view.resolve(ref.replace(/^(S-\d{4,}|T-\d{4,}(?:-\d{2,})*|TM-\d{4,}|TI-\d{2,})\.md$/, '$1'))
      }
      else for (const candidate of Object.keys(view.deps.pages).filter(page => !page.includes('#'))) {
        const result = await view.document(candidate)
        if (result.status !== 'ok') continue
        let page: IndexedPage
        try { page = pageValue(library, view, candidate, result.content) }
        catch (error) { if (error instanceof PageMetadataError) continue; throw error }
        if ([page.id, page.title, path.posix.basename(candidate), ...page.aliases].some(value => normalize(value) === normalize(ref))) { relative = candidate; break }
      }
      if (!relative) return undefined
      const result = await view.document(relative)
      const page = result.status === 'ok' ? pageValue(library, view, result.path!, result.content) : undefined
      return { library: library.name, path: result.path!, type: page?.type ?? 'updating', title: page?.title ?? '更新中', aliases: page?.aliases ?? [], tags: page?.tags ?? [],
        ...(page ? { updated: page.updated, sources: page.sources, sourceVersions: page.sourceVersions, sourceDate: page.sourceDate, sourceType: page.sourceType, credibility: page.credibility,
          ...(page.pendingReview ? { pendingReview: page.pendingReview } : {}) } : {}),
        currentVersion: view.current.version, ...paginate(result, maxChars, options.offset) }
    })
  }
  async source(library: LibraryRegistration, layered: LayeredLibrary, sourceId: string, locator: string, maxChars: number, options: SourceReadOptions = {}) {
    if (layered.card.origin_type === 'siyuan') return { library: library.name, sourceId, locator, status: 'external' as const, content: '请走 keeper_notes 回源', truncated: false, next_offset: null }
    if (!locator) throw new Error('请提供原文定位。')
    return (await run(layered.root, options, async view => ({ library: library.name, sourceId, locator,
      currentVersion: view.current.version, ...paginate(await view.source(sourceId, { locator, sourceVersion: options.sourceVersion }), maxChars, options.offset) }))).value
  }
}
