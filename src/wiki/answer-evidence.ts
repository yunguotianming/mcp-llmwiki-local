import { signature } from '../storage/files.js'
import { terms } from './identity-search.js'
import { excerpts, pageParagraphs, tokenCost } from './page-search.js'
import type { EvidenceSegment, PageExcerpt } from './page-search.js'
import { PageMetadataError } from './page-metadata.js'
import type { PendingTopicReview } from '../layered/schema.js'

export interface AnswerEvidenceSource { sourceId: string; sourceVersion: string; path: string; title: string }
export interface AnswerEvidenceSegment extends EvidenceSegment { sources: AnswerEvidenceSource[] }
export interface AnswerEvidence {
  id: number; path: string; title: string; content: string; hash: string; version: string
  anchor: string; locator: string; truncated: boolean; unverified: boolean
  sources: AnswerEvidenceSource[]; segments: AnswerEvidenceSegment[]
  pendingReview?: PendingTopicReview
}
export interface AnswerEvidenceHit {
  path: string; title: string; version: string; sourceVersions: { sourceId: string; sourceVersion: string }[]
  snippet: string; snippetSegments: EvidenceSegment[]; anchor: string; excerpts: PageExcerpt[]
  pendingReview?: PendingTopicReview
}
export interface AnswerEvidenceOptions {
  budget: number; limit: number
  sourceTitles?: ReadonlyMap<string, string> | undefined
}
export interface AnswerEvidencePage {
  path: string; title: string; content: string; currentVersion: string; status: string
  sourceVersions?: { sourceId: string; sourceVersion: string }[] | undefined
  truncated?: boolean | undefined
  pendingReview?: PendingTopicReview
}
export interface AnswerEvidenceReadOptions extends AnswerEvidenceOptions {
  read: (path: string, maxChars: number, signal: AbortSignal | undefined, options: { version: string; offset?: number }) => Promise<AnswerEvidencePage | undefined>
  signal?: AbortSignal | undefined
}
const sourceKey = (source: { sourceId: string; sourceVersion: string }) => `${source.sourceId}@${source.sourceVersion}`
const ownSource = (path: string) => /^sources\/((?:S-\d+|\d{14}-[a-z0-9]{7}))\.md$/.exec(path)?.[1]
const citedSources = (content: string) => [...content.matchAll(/\[((?:S-\d+|\d{14}-[a-z0-9]{7}))@([^\]#]+)#(?:L\d+-L\d+|block:[^\]]+)\]/g)]
  .map(match => ({ sourceId: match[1]!, sourceVersion: match[2]! }))
function sourcesFor(content: string, hit: AnswerEvidenceHit, titles?: ReadonlyMap<string, string>): AnswerEvidenceSource[] {
  const cited = citedSources(content)
  // 来源页自身可绑定其身份；主题和术语页只能跟随当前片段里的真实引用。
  const own = ownSource(hit.path)
  if (own && !cited.length) cited.push(...hit.sourceVersions.filter(source => source.sourceId === own))
  return [...new Map(cited.filter(source => hit.sourceVersions.some(known => sourceKey(known) === sourceKey(source)))
    .map(source => [sourceKey(source), { ...source, path: `sources/${source.sourceId}.md`, title: titles?.get(sourceKey(source)) ?? (source.sourceId === own ? hit.title : source.sourceId) }])).values()]
}
function substantive(content: string): boolean {
  const body = content.replace(/\[[^\]]*\]\([^)]*\)|\[(?:S-\d+|\d{14}-[a-z0-9]{7})@[^\]]*\]/g, '').replace(/^\s*(?:```[^\n]*|#{1,6}[^\n]*|\^[\w-]+)\s*$/gm, '').trim()
  return body.length >= 4 && !/^(?:[-*]\s*)?(?:别名|别称|aliases|title|来源路径|source|路径|path|版本|version|更新时间|标签|tags)\s*[:：]/i.test(body)
    && !/^(?:本节)?(?:无|暂无|未提供依据|未提供证据|未给出依据|待补充)[。；\s]*$/.test(body)
}
const referencePattern = /\[((?:S-\d+|\d{14}-[a-z0-9]{7})@[^\]#]+#(?:L\d+-L\d+|block:[^\]]+))\](?:\(([^)]*)\))?/g
const titleIdentity = (title: string) => title.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
const hitQuotes = (hit: AnswerEvidenceHit) => hit.excerpts.length ? hit.excerpts : [{ content: hit.snippet, segments: hit.snippetSegments }]
function referenceAliases(hits: AnswerEvidenceHit[], version: string): Map<string, Set<string>> {
  const aliases = new Map<string, Set<string>>()
  for (const hit of hits.filter(hit => hit.version === version)) for (const quote of hitQuotes(hit)) for (const segment of quote.segments ?? []) {
    const content = quote.content.slice(segment.start, segment.end)
    if (citedSources(content).some(source => !hit.sourceVersions.some(known => sourceKey(known) === sourceKey(source)))) continue
    for (const match of content.matchAll(referencePattern)) {
      const anchor = /#(\^p[\w-]+)$/.exec(match[2] ?? '')?.[1], source = match[1]!.split('#')[0]!
      if (!anchor) continue
      const key = `${source}\0${anchor}`, refs = aliases.get(key) ?? new Set<string>()
      refs.add(match[1]!); aliases.set(key, refs)
    }
  }
  return aliases
}
function candidateIdentity(content: string, hit: AnswerEvidenceHit, aliases: ReadonlyMap<string, Set<string>>): string {
  const refs = new Set<string>(), own = ownSource(hit.path)
  let unresolved = false
  const body = content.replace(referencePattern, (_match, reference: string) => { refs.add(reference); return `[${reference}]` })
    .replace(/\[(?:证据|回源)\]\(#(\^p[\w-]+)\)/g, (link, anchor: string) => {
      const source = hit.sourceVersions.filter(source => source.sourceId === own)
      const known = source.length === 1 ? aliases.get(`${sourceKey(source[0]!)}\0${anchor}`) : undefined
      if (!known) { unresolved = true; return link }
      for (const ref of known) refs.add(ref)
      return [...known].sort().map(ref => `[${ref}]`).join(' ')
    }).replace(/\s+/g, ' ').trim()
  // 只凭同一完整主张及同一真实引用集合合并；没有可证明的锚点映射时保留原候选。
  const identity = unresolved || !refs.size ? `${hit.path}\0${content}` : `${body}\0${[...refs].sort().join('\0')}`
  // 待核实结论绑定版本和页面，不能与同文来源合并后迁移或丢失该状态。
  return hit.pendingReview ? `${identity}\0${JSON.stringify(hit.pendingReview)}` : identity
}
type Candidate = Omit<AnswerEvidence, 'id'> & { score: number; matched: string[]; namedTitles: string[]; rank: number; hit: AnswerEvidenceHit; sourceUnverified: boolean }
function candidates(question: string, hits: AnswerEvidenceHit[], version: string, options: AnswerEvidenceOptions): Candidate[] {
  const result: Candidate[] = [], seen = new Map<string, Candidate>(), questionTerms = terms(question)
  const aliases = referenceAliases(hits, version), requestedTitles = [...question.matchAll(/《([^》]+)》/g)].map(match => titleIdentity(match[1]!)).filter(Boolean)
  for (const [rank, hit] of hits.entries()) {
    if (hit.version !== version) continue
    const quotes = hitQuotes(hit)
    for (const quote of quotes) for (const original of quote.segments ?? []) {
      const content = quote.content.slice(original.start, original.end)
      if (!substantive(content)) continue
      // 引用版本必须由当前页依赖证明；不能仅删掉来源标签后继续把错版本正文当事实。
      if (citedSources(content).some(source => !hit.sourceVersions.some(known => sourceKey(known) === sourceKey(source)))) continue
      const paragraphs = pageParagraphs(content, [question]).filter(block => block.penalty === 1)
      if (!paragraphs.length) continue
      const sources = sourcesFor(content, hit, options.sourceTitles)
      const titleTerms = terms([hit.title, ...sources.map(source => source.title)].join(' '))
      const score = Math.max(...paragraphs.map(block => block.score)) + [...questionTerms].filter(term => titleTerms.has(term)).length * 0.5
      const names = new Set([hit.title, ...sources.map(source => source.title)].map(titleIdentity))
      const namedTitles = citedSources(content).length ? requestedTitles.filter(title => names.has(title)) : []
      const candidate = { path: hit.path, title: hit.title, content, hash: signature(content), version, anchor: original.anchor, locator: original.locator,
        sources, segments: [{ ...original, start: 0, end: content.length, sources, unverified: original.unverified || !!hit.pendingReview }],
        truncated: original.truncated, unverified: original.unverified || !!hit.pendingReview, ...(hit.pendingReview ? { pendingReview: hit.pendingReview } : {}),
        score, matched: [...new Set(paragraphs.flatMap(block => block.matched))], namedTitles, rank, hit, sourceUnverified: original.unverified }
      const key = candidateIdentity(content, hit, aliases), previous = seen.get(key)
      if (previous) {
        const unverified = previous.unverified || candidate.unverified, truncated = previous.truncated || candidate.truncated, firstRank = Math.min(previous.rank, rank)
        const sourceUnverified = previous.sourceUnverified || candidate.sourceUnverified
        const score = Math.max(previous.score, candidate.score), matched = [...new Set([...previous.matched, ...candidate.matched])], namedTitles = [...new Set([...previous.namedTitles, ...candidate.namedTitles])]
        // 保留带真实展开引用的正文，不能用更短的原始锚点替代原文定位。
        if (citedSources(candidate.content).length > citedSources(previous.content).length || citedSources(candidate.content).length === citedSources(previous.content).length && ownSource(candidate.path) && !ownSource(previous.path)) Object.assign(previous, candidate)
        previous.rank = firstRank; previous.score = score; previous.matched = matched; previous.namedTitles = namedTitles
        previous.unverified = unverified; previous.truncated = truncated; previous.sourceUnverified = sourceUnverified
        for (const segment of previous.segments) { segment.unverified ||= unverified; segment.truncated ||= truncated }
        continue
      }
      seen.set(key, candidate); result.push(candidate)
    }
  }
  return result
}

/** 回答和离线回放共用的选择入口；预算为最终正文的 UTF-8 字节总数。 */
export function selectAnswerEvidence(question: string, hits: AnswerEvidenceHit[], version: string, options: AnswerEvidenceOptions): AnswerEvidence[] {
  const budget = Math.max(0, Math.floor(options.budget)), limit = Math.max(0, Math.floor(options.limit))
  if (!budget || !limit) return []
  const all = candidates(question, hits, version, options), pending = all.some(item => item.score > 0 || item.namedTitles.length) ? all.filter(item => item.score > 0 || item.namedTitles.length) : all
  const selected: Candidate[] = [], pages = new Set<string>(), covered = new Set<string>(), sources = new Set<string>(), titles = new Set<string>()
  const gain = (item: Candidate) => item.score + item.matched.filter(term => !covered.has(term)).length
  while (pending.length && selected.length < limit) {
    // 相关性相当时优先不同页面；低相关新页不能挤掉同页的实质事实。
    // 明确题名且有真实引用时保住该来源；比较多个题名时先覆盖尚未出现的一方。
    const named = pending.filter(item => item.namedTitles.length), uncovered = named.filter(item => item.namedTitles.some(title => !titles.has(title)))
    const eligible = uncovered.length ? uncovered : named.length ? named : pending
    const best = Math.max(...eligible.map(gain)), fresh = eligible.filter(item => !pages.has(item.path) && gain(item) >= best / 2), pool = fresh.length ? fresh : eligible
    pool.sort((a, b) => gain(b) - gain(a)
      || b.sources.filter(source => !sources.has(sourceKey(source))).length - a.sources.filter(source => !sources.has(sourceKey(source))).length
      || a.rank - b.rank)
    const next = pool[0]!
    selected.push(next); pending.splice(pending.indexOf(next), 1); pages.add(next.path)
    for (const term of next.matched) covered.add(term)
    for (const source of next.sources) sources.add(sourceKey(source))
    for (const title of next.namedTitles) titles.add(title)
  }
  let available = budget
  const share = Math.floor(budget / selected.length), result: AnswerEvidence[] = []
  for (const [index, item] of selected.entries()) {
    const reserve = selected.slice(index + 1).reduce((sum, other) => sum + Math.min(share, tokenCost(other.content)), 0)
    const fit = (cap: number) => tokenCost(item.content) <= cap ? { content: item.content, segments: item.segments }
      : excerpts({ library: '', path: item.path, title: item.title, content: item.content }, [question], cap)[0]
    let window = fit(available - reserve)
    // 平均预留放不下完整主张时回收后续份额，先保住更高相关的可容纳事实。
    if (!window?.content || !substantive(window.content)) window = fit(available)
    if (!window?.content || !substantive(window.content)) continue
    available -= tokenCost(window.content)
    const { score: _score, matched: _matched, namedTitles: _namedTitles, rank: _rank, hit: _hit, sourceUnverified: _sourceUnverified, ...quote } = item, truncated = item.truncated || window.content !== item.content
    const bindings = sourcesFor(window.content, item.hit, options.sourceTitles)
    result.push({ ...quote, id: result.length + 1, content: window.content, hash: signature(window.content), truncated, sources: bindings,
      segments: (window.segments ?? []).map(segment => ({ ...segment, anchor: item.anchor, locator: item.locator, contextLocator: item.segments[0]!.contextLocator,
        truncated: segment.truncated || truncated, unverified: segment.unverified || item.unverified, sources: sourcesFor(window.content.slice(segment.start, segment.end), item.hit, options.sourceTitles) })) })
  }
  return result
}

/** 只补读实际引用的来源，固定版本、本地读取有界；补读正文仍通过同一最终预算。 */
export async function assembleAnswerEvidence(question: string, hits: AnswerEvidenceHit[], version: string, options: AnswerEvidenceReadOptions): Promise<AnswerEvidence[]> {
  const initial = candidates(question, hits, version, options), titles = new Map(options.sourceTitles), references = new Map<string, { source: AnswerEvidenceSource; score: number; unverified: boolean }>()
  for (const item of initial) for (const source of item.sources) {
    const key = sourceKey(source), previous = references.get(key)
    references.set(key, { source, score: Math.max(previous?.score ?? 0, item.score), unverified: !!previous?.unverified || item.sourceUnverified })
  }
  const seeds = [...references.values()].sort((a, b) => b.score - a.score).slice(0, 8), ready: typeof seeds = []
  // 八个来源各读 512 字符，再给最多四个来源各读 30,000 字符；合计最多 124,096 字符。
  const read = async (source: AnswerEvidenceSource, maxChars: number) => {
    options.signal?.throwIfAborted()
    let page: AnswerEvidencePage | undefined
    try { page = await options.read(source.path, maxChars, options.signal, { version }) }
    catch (error) {
      if (error instanceof PageMetadataError || error instanceof Error && error.message === '未找到 Wiki 页面。请先检索并使用返回的 library 与 path。') return undefined
      throw error
    }
    if (!page) return undefined
    if (page.status !== 'ok' || page.currentVersion !== version) throw new Error('回答补读来源已撤权或版本变化，请重新提问。')
    if (page.path !== source.path || !page.sourceVersions?.some(known => sourceKey(known) === sourceKey(source))) return undefined
    return page
  }
  const questionTerms = terms(question)
  for (const seed of seeds) {
    const page = await read(seed.source, 512)
    if (!page) continue
    titles.set(sourceKey(seed.source), page.title)
    ready.push({ ...seed, score: seed.score + [...terms(page.title)].filter(term => questionTerms.has(term)).length * 2 })
  }
  const supplemented: AnswerEvidenceHit[] = []
  for (const seed of ready.sort((a, b) => b.score - a.score).slice(0, 4)) {
    const page = await read(seed.source, 30000)
    if (!page) continue
    // 半段末尾不能被视为完整正文；前面的完整段落不因本地分页被一并标成裁剪。
    const end = page.truncated ? page.content.lastIndexOf('\n\n') : page.content.length
    const content = end >= 0 ? page.content.slice(0, end) : ''
    const quotes = excerpts({ library: '', path: page.path, title: page.title, content }, [question], options.budget)
      .map(quote => ({ ...quote, segments: (quote.segments ?? []).map(segment => ({ ...segment, unverified: segment.unverified || seed.unverified })) }))
    supplemented.push({ path: page.path, title: page.title, version, sourceVersions: page.sourceVersions!, snippet: '', snippetSegments: [], anchor: '', excerpts: quotes,
      ...(page.pendingReview ? { pendingReview: page.pendingReview } : {}) })
  }
  return selectAnswerEvidence(question, [...hits, ...supplemented], version, { ...options, sourceTitles: titles })
}
