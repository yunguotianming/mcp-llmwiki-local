import { signature } from '../storage/files.js'
import { terms } from './identity-search.js'
import { parseMarkdown, separateImages } from '../ingest/markdown.js'

export interface SearchNotice { library: string; stage: 'understanding' | 'embedding' | 'index' | 'library'; reason: string; message: string; retrieval?: 'fts' }
export interface SearchOptions { variants?: string[] | undefined; include?: 'hits' | 'excerpts' | undefined; excerpt_budget?: number | undefined; excerpt_pages?: number | undefined }
export interface PageExcerpt { library: string; path: string; title: string; anchor: string; locator: string; quote_hash: string; content: string; tokens: number }
export const stripBlockIds = (content: string): string => content.replace(/[ \t]+\^[a-zA-Z0-9-]+[ \t]*(?=\r?$)/gm, '')
// 未依赖特定供应商 tokenizer；UTF-8 字节数作为保守 token 上界，同一预算在所有入口一致。
export const tokenCost = (value: string): number => Buffer.byteLength(value, 'utf8')
export function tokenSlice(value: string, budget: number): string {
  let used = 0, result = ''
  for (const char of value) { const size = tokenCost(char); if (used + size > budget) break; used += size; result += char }
  return result
}
export function validVariants(query: string, values: unknown, max = 3): string[] {
  const key = (value: string) => value.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()
  const seen = new Set([key(query)]), variants: string[] = []
  if (!Array.isArray(values)) return variants
  for (const value of values) {
    if (typeof value !== 'string' || !value.trim() || tokenCost(value) > 1500 || seen.has(key(value))) continue
    seen.add(key(value)); variants.push(value.trim())
    if (variants.length >= max) break
  }
  return variants
}
export function fuseRanks(lists: { paths: string[]; weight: number; channel: string }[]) {
  const scores = new Map<string, { score: number; score_channels: Record<string, number> }>()
  for (const list of lists) [...new Set(list.paths)].forEach((path, index) => {
    const entry = scores.get(path) ?? { score: 0, score_channels: {} }, score = list.weight / (61 + index)
    entry.score += score; entry.score_channels[list.channel] = (entry.score_channels[list.channel] ?? 0) + score; scores.set(path, entry)
  })
  return scores
}
export interface PointMatch { anchors: string[]; score: number }
// 书名用于召回页面；存在书名外的问题时，段落排序聚焦实际问题。
const passageQueries = (queries: string[]) => queries.map(query => {
  const question = query.replace(/《[^》]+》/g, '').trim()
  return terms(question).size ? question : query
})
// 中英文相邻时分开取词，避免外文专名被拆成无关字母对。
const passageVocabulary = (value: string) => terms(value.replace(/(\p{Script=Han}+)/gu, ' $1 '))
// 书名及其兜底变体负责页级召回；片段只保留书名外的问法和变体新增词项。
function passageTerms(queries: string[]): Map<string, number> {
  const titles = passageVocabulary([...queries[0]?.matchAll(/《([^》]+)》/g) ?? []].map(match => match[1]).join(' '))
  const focused = passageQueries(queries), original = passageVocabulary(focused[0] ?? ''), result = new Map<string, number>()
  // 明确问法后的条件比前面的资料背景更重要；不依赖题号、来源名或业务词表。
  const focus = passageVocabulary(/(?:如何|怎样|多少|哪些|为什么|有何|有没有|是否)(.+)/.exec(focused[0] ?? '')?.[1] ?? '')
  focused.forEach((query, index) => {
    for (const term of passageVocabulary(query)) if ((!titles.has(term) || original.has(term))
      && !/[的与及和是]/.test(term) && !/^(?:中|具体|体内|内容|什么|哪里|关于|原文|证据|来源|定位|the|of|in|and|to|what|how|where)$/i.test(term)) result.set(term, Math.max(result.get(term) ?? 0, index ? 1 : focus.size ? focus.has(term) ? 3 : 0.5 : 2))
  })
  // 定义类问题优先命中定义表述，不能由一串高频对象名称挤掉问法本身。
  if (original.has('定义')) result.set('定义', 6)
  return result
}
const citationPattern = /\[((?:S-\d+|\d{14}-[a-z0-9]{7})@[^\]#]+#(?:L\d+-L\d+|block:[^\]]+))\]/g
const plainPoint = (value: string) => value.replace(/\[[^\]]+\]\([^)]*\)|\[(?:S-\d+|\d{14}-[a-z0-9]{7})@[^\]]+\]/g, '').trim()
// 结构区按节名及要点开头识别；只有问句明确涉及该类信息才免降权。方法类也接受访谈、编码等过程问法。
const structural = [
  { section: /题名|标题|作者|ORCID|\bauthors?\b|correspondence/i, point: /^(?:文章|论文|研究)?(?:题名|标题|作者(?:信息|名单|贡献|为|是)|ORCID)/i, intent: /题名|标题|作者|署名|ORCID|\bauthors?\b|\btitle\b/i },
  { section: /研究目的|\baims?\b|\bobjectives?\b/i, point: /^(?:本|该)?(?:研究|文献综述|综述|文章|论文)(?:旨在|目的|的目的是)/, intent: /目的|旨在|目标|\baims?\b|\bobjectives?\b/i },
  { section: /参考文献|\breferences?\b|bibliography/i, point: /^参考文献/, intent: /参考文献|书目|引用了|\breferences?\b|bibliography/i },
  { section: /致谢|资助|利益冲突|acknowledg|funding|conflict of interest/i, point: /^(?:作者|研究|本研究|该研究)?(?:声明|感谢|获.*资助)|^(?:资助|致谢|利益冲突)/, intent: /致谢|感谢|资助|基金|利益冲突|acknowledg|funding|conflict of interest/i },
  { section: /导航|目录|navigation|contents/i, point: /^(?:导航|目录)/, intent: /导航|目录|navigation|contents/i },
  { section: /术语清单|key\s*words/i, point: /^(?:原文列出的)?关键词/, intent: /术语|定义|关键词|含义|意思|keywords|definition/i },
  { section: /^方法$|\bmethods?\b|\bdesign\b|data collection|data analysis/i, point: /^(?:本|该)?研究(?:采用|使用|设计为|开展了)/, intent: /方法|设计|访谈|收集|分析|编码|核验|核实|验证|确认|校验|分歧|抽样|样本|招募|招收|纳入|排除|\bmethods?\b|interview|sampling|coding|analysis/i },
]
type Paragraph = ReturnType<typeof computeParagraphs>[number]
// 一次查询里同一页先取短片段、再取摘录，切块与打分输入完全相同；最近结果按输入复用。
// 只缓存最近几项且按内容与参数全文比较，页面变化或查询变化必然重新计算；调用方拿到的是浅拷贝数组，块对象不被修改。
const paragraphCache: { content: string; key: string; value: Paragraph[] }[] = []
export function pageParagraphs(content: string, queries: string[], pointMatches: PointMatch[] = []): Paragraph[] {
  // JSON 把 NaN、Infinity 都写成 null，非有限分数会撞键；这种输入不走缓存，直接计算。
  if (pointMatches.some(point => !Number.isFinite(point.score))) return computeParagraphs(content, queries, pointMatches)
  const key = JSON.stringify([queries, pointMatches])
  const hit = paragraphCache.find(entry => entry.content === content && entry.key === key)
  if (hit) return hit.value.map(block => ({ ...block, refs: [...block.refs], matched: [...block.matched] }))
  const value = computeParagraphs(content, queries, pointMatches)
  paragraphCache.unshift({ content, key, value: value.map(block => ({ ...block, refs: [...block.refs], matched: [...block.matched] })) })
  paragraphCache.length = Math.min(paragraphCache.length, 8)
  return value
}
function computeParagraphs(content: string, queries: string[], pointMatches: PointMatch[]) {
  const needles = passageTerms(queries), question = passageQueries(queries).join('\n'), lines = content.split('\n')
  const blocks: { content: string; anchor: string; locator: string; score: number; line: number; pointScore: number; evidence: boolean; refs: string[]; matched: string[]; penalty: number; section: string }[] = []
  const attached = new Map<number, string>()
  if (/^[ \t]+\^[a-zA-Z0-9-]+[ \t]*\r?$/m.test(content)) {
    const nodes = parseMarkdown(content).children
    nodes.forEach((node, index) => {
      if (node.type !== 'paragraph' || !node.position) return
      const id = /^\^[a-zA-Z0-9-]+$/.exec(content.slice(node.position.start.offset!, node.position.end.offset!).trim())?.[0]
      const previous = nodes[index - 1]
      if (id && previous?.position) for (let line = previous.position.start.line - 1; line < previous.position.end.line; line++) attached.set(line, id)
    })
  }
  let anchor = '', headingAnchor = '', start = 0, buffer: string[] = [], excludedDepth = 0, sectionName = ''
  let frontmatter = lines[0]?.trim() === '---'
  const flush = () => {
    const raw = buffer.join('\n')
    // 引文只取连续原文；图片及编码在原始位置分隔，不能把替换占位符当成页面引文。
    for (const span of separateImages(raw).mapping.filter(span => !span.replacement)) {
      const piece = raw.slice(span.originalStart, span.originalEnd), text = piece.trim()
      const line = start + raw.slice(0, span.originalStart + piece.length - piece.trimStart().length).split('\n').length - 1
      const vocabulary = passageVocabulary(plainPoint(text)), matched = [...needles.keys()].filter(needle => vocabulary.has(needle))
      const penalty = structural.some(rule => (rule.section.test(sectionName) || rule.point.test(plainPoint(text).replace(/^[-+*]\s*/, ''))) && !rule.intent.test(question)) ? 0.1 : 1
      const refs = [...text.matchAll(/#\^(p[a-zA-Z0-9-]+)/g)].map(match => match[1]!)
      const evidence = /^\^p[a-zA-Z0-9-]+$/.test(anchor)
      if (evidence) refs.push(anchor.slice(1))
      if (text && !/^(?:本节无独立要点。|可信度依据：|主题归属需要向量；)/.test(text)) blocks.push({ content: text, anchor: refs[0] ? '^' + refs[0] : anchor || 'L' + (line + 1), locator: `L${line + 1}-L${line + text.split('\n').length}`, line,
        score: matched.reduce((score, needle) => score + needles.get(needle)!, 0) * penalty, pointScore: 0, evidence, refs, matched, penalty, section: sectionName })
    }
    buffer = []
  }
  lines.forEach((line, index) => {
    if (frontmatter) { if (index && line.trim() === '---') frontmatter = false; return }
    const section = /^(#{1,6})\s+(.+)/.exec(stripBlockIds(line))
    if (section && excludedDepth && section[1]!.length <= excludedDepth) excludedDepth = 0
    if (section && section[1]!.length > 1 && /^(?:(?:来源|章节|子主题|主题|术语)?导航|(?:章节)?目录|(?:提取|覆盖|质量|核对|补标)?缺口(?:清单)?|来源(?:列表|路径)?|未核实)$/.test(section[2]!.trim())
      && !/导航|目录|navigation|contents/i.test(question)) {
      flush(); excludedDepth = section[1]!.length; return
    }
    if (excludedDepth) return
    const attachedId = attached.get(index)
    if (attachedId) {
      if (anchor !== attachedId) flush()
      anchor = attachedId
      if (!buffer.length) start = index
      if (line.trim()) buffer.push(line); else flush()
      return
    }
    const blockId = /[ \t]+(\^[a-zA-Z0-9-]+)[ \t]*\r?$/.exec(line)
    const explicit = /<a\s+id=["']([^"']+)["']/.exec(line), heading = /^#{1,6}\s+(.+)/.exec(stripBlockIds(line))
    if (explicit || heading) {
      flush()
      if (heading) sectionName = heading[1]!
      if (blockId) anchor = blockId[1]!
      else if (explicit) anchor = explicit[1]!
      else if (!/<a\s+id=/.test(lines[index - 1] ?? '')) anchor = heading![1]!.toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').trim().replace(/\s/g, '-')
      headingAnchor = anchor
      return
    }
    // 块尾是摘录边界；不跨过标记拼接正文，摘录仍是页面中的连续原始子串。
    if (!heading && /^\s*(?:[-+*]|\d+\.)\s/.test(line)) flush()
    if (blockId) anchor = blockId[1]!
    if (!line.trim()) { flush(); anchor = headingAnchor }
    else {
      if (!buffer.length) start = index
      buffer.push(blockId ? line.slice(0, blockId.index) : line)
      if (blockId) { flush(); anchor = headingAnchor }
    }
  }); flush()
  // 同一要点的主张段与证据原文共享命中信号，全文与向量都能定位到实际段落。
  // 按页内不同正文的频率降低背景高频词权重；变体词和原话词仍使用同一词项重合规则。
  const texts = new Map(blocks.map(block => [plainPoint(block.content), new Set(block.matched)]))
  for (const [term, weight] of needles) needles.set(term, weight * Math.log(1 + texts.size / (1 + [...texts.values()].filter(words => words.has(term)).length)))
  const referenceTerms = new Map<string, Set<string>>()
  for (const block of blocks) for (const ref of block.refs) {
    const words = referenceTerms.get(ref) ?? new Set<string>()
    for (const term of block.matched) words.add(term)
    referenceTerms.set(ref, words)
  }
  for (const block of blocks) {
    block.matched = [...new Set([...block.matched, ...block.refs.flatMap(ref => [...referenceTerms.get(ref) ?? []])])]
    block.score = block.matched.reduce((sum, term) => sum + needles.get(term)!, 0) * block.penalty
  }
  const lexical = new Map<string, number>(), semantic = new Map<string, number>(), scores = new Map<string, number>()
  for (const block of blocks) for (const ref of block.refs) lexical.set(ref, Math.max(lexical.get(ref) ?? 0, block.score))
  for (const point of pointMatches) {
    const score = Math.max(0, ...point.anchors.map(ref => lexical.get(ref) ?? 0))
    for (const ref of point.anchors) {
      lexical.set(ref, score)
      semantic.set(ref, Math.max(semantic.get(ref) ?? 0, point.score))
    }
  }
  for (const channel of [lexical, semantic]) {
    const ranked = [...channel].filter(([, score]) => score > 0).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    // 同分共用名次，避免锚点字符串决定同等命中的先后。
    let rank = 0
    ranked.forEach(([ref, score], index) => {
      if (index && ranked[index - 1]![1] !== score) rank = index
      scores.set(ref, (scores.get(ref) ?? 0) + 1 / (61 + rank))
    })
  }
  for (const block of blocks) {
    block.pointScore = Math.max(0, ...block.refs.map(ref => scores.get(ref) ?? 0))
    // 原文命中的词项传给对应主张；语义分只用于同词项得分时的次序，不压过问题相关度。
    block.score = Math.max(block.score, ...block.refs.map(ref => (lexical.get(ref) ?? 0) * block.penalty))
  }
  return blocks.sort((a, b) => b.score - a.score || b.pointScore - a.pointScore || Number(a.evidence) - Number(b.evidence) || a.line - b.line)
}
export function excerpts(page: { library: string; path: string; title: string; content: string }, queries: string[], budget: number, pointMatches: PointMatch[] = []): PageExcerpt[] {
  const result: PageExcerpt[] = []
  const blocks = pageParagraphs(page.content, queries, pointMatches)
  // 发布页的证据块同时保存版本、原文定位和锚点；只展开返回文本中的链接，不写回页面。
  const citations = new Map<string, string>()
  for (const block of blocks.filter(block => block.evidence)) {
    const citation = [...block.content.matchAll(citationPattern)][0]?.[1]
    if (citation) citations.set(block.anchor.slice(1), `[${citation}](../sources/${citation.split('@')[0]}.md#${block.anchor})`)
  }
  const expand = (text: string) => page.path.startsWith('sources/')
    ? text.replace(/\[(?:证据|回源)\]\(#\^(p[\w-]+)\)/g, (link, id: string) => citations.get(id) ?? link) : text
  const unique = new Map<string, typeof blocks[number]>()
  for (const block of blocks) {
    const key = plainPoint(block.content)
    const previous = unique.get(key)
    // 同一主张的分类副本沿用含证据链接的版本，避免分类正文和概览重复消耗预算。
    if (!previous || !previous.refs.length && block.refs.length) unique.set(key, block)
  }
  const candidates = [...unique.values()], needles = passageTerms(queries), covered = new Set<string>()
  const matches = candidates.filter(block => block.score > 0 || block.pointScore > 0)
  const claims = matches.filter(block => !block.evidence)
  const pending = claims.length ? claims : matches
  const selected: { block: typeof blocks[number]; content: string; line: number; last: number }[] = []
  const totalBudget = budget
  const locations = (block: typeof blocks[number]) => block.refs.map(ref => citations.get(ref)?.split(']')[0]).filter((value): value is string => !!value)
  // 展开文本、长度与原文定位在选择过程中不变，每块只算一次；排序比较器里反复计算会让大页面的查询变慢数倍。
  const fixed = new Map(pending.map(block => {
    const expanded = expand(block.content)
    return [block, { expanded, root: Math.sqrt(tokenCost(expanded)), locations: locations(block) }] as const
  }))
  const selectedLocations = new Set<string>()
  // 首条按相关度；后续优先增加尚未覆盖的词项，最后按页内顺序合并，每条保留自己的引用。
  const gain = (block: typeof blocks[number]) => block.matched.reduce((sum, term) => sum + (covered.has(term) ? 0 : needles.get(term) ?? 0), 0) * block.penalty
  // 同一原文段拆出的相关要点优先相邻补齐，避免主张措辞不同却被已覆盖词项挡掉。
  const related = (block: typeof blocks[number]) => block.score > 0 && block.penalty === 1 && fixed.get(block)!.locations.some(location => selectedLocations.has(location))
  const distance = (block: typeof blocks[number]) => Math.min(...selected.map(item => Math.abs(item.block.line - block.line)))
  while (pending.length) {
    // 覆盖词项与已选位置只在选中一条后变化：每轮先为每块算一次排序键，比较器只读取键值，排序结果与逐次计算相同。
    const keys = new Map(pending.map(block => {
      const isRelated = related(block)
      return [block, { related: isRelated, distance: isRelated ? distance(block) : 0, ratio: selected.length ? (block.score + gain(block)) / fixed.get(block)!.root : 0 }] as const
    }))
    pending.sort((a, b) => {
      const ka = keys.get(a)!, kb = keys.get(b)!
      return Number(kb.related) - Number(ka.related) || (ka.related && kb.related ? ka.distance - kb.distance || a.line - b.line : 0)
        || kb.ratio - ka.ratio || b.score - a.score || b.pointScore - a.pointScore || a.line - b.line
    })
    const block = pending.shift()!
    if (selected.length && !gain(block) && !keys.get(block)!.related && block.score < selected[0]!.block.score / 2) continue
    const expanded = fixed.get(block)!.expanded, available = budget - (selected.length ? 1 : 0)
    // 预算先按要点边界截断；只有单条自身超过整页预算才取完整句子，不能把余量塞成半个要点。
    if (tokenCost(expanded) > available && tokenCost(expanded) <= totalBudget) continue
    const window = passageWindow(expanded, queries, available)
    if (!window.content) continue
    const line = block.line + expanded.slice(0, window.offset).split('\n').length - 1
    selected.push({ block, content: window.content, line, last: line + window.content.split('\n').length })
    budget -= tokenCost(window.content) + (selected.length > 1 ? 1 : 0)
    for (const term of window.content === expanded ? block.matched : passageVocabulary(plainPoint(window.content))) covered.add(term)
    if (block.score >= selected[0]!.block.score * 0.8) for (const location of locations(block)) selectedLocations.add(location)
  }
  const emit = (items: typeof selected) => {
    items.sort((a, b) => a.line - b.line)
    const content = items.map(item => item.content).join('\n'), first = items[0]!
    result.push({ library: page.library, path: page.path, title: page.title, anchor: first.block.anchor,
      locator: `L${first.line + 1}-L${Math.max(...items.map(item => item.last))}`, quote_hash: signature(content), content, tokens: tokenCost(content) })
  }
  if (selected.length) {
    // 无证据关联的普通段落（含图片两侧的连续文本）仍各自定位，不能跨图片拼出不存在的原文。
    if (selected.every(item => !item.block.refs.length)) for (const item of selected) emit([item])
    else emit(selected)
  }
  // 无词项命中时仍允许语义证据；普通无引用页面保留页首概览补充。
  const supplement = candidates.filter(block => !selected.some(item => item.block === block)
    && (block.score === 0 && block.pointScore === 0 || !needles.size || !selected.some(item => item.block.score > 0) && block.evidence))
    .sort((a, b) => a.line - b.line)
  if (!selected.length || !selected.some(item => item.block.refs.length) || !selected.some(item => item.block.score > 0)) for (const block of supplement) {
    const expanded = expand(block.content)
    if (tokenCost(expanded) > budget && tokenCost(expanded) <= totalBudget) continue
    const window = passageWindow(expanded, queries, budget)
    if (!window.content) continue
    const line = block.line + expanded.slice(0, window.offset).split('\n').length - 1
    emit([{ block, content: window.content, line, last: line + window.content.split('\n').length }])
    budget -= tokenCost(window.content)
  }
  return result
}

// 超长要点只取连续完整句子，并预留全部尾部证据链接；没有一句能放下时跳过，绝不按字节切半句。
function passageWindow(content: string, queries: string[], budget: number): { content: string; offset: number } {
  if (tokenCost(content) <= budget) return { content, offset: 0 }
  const suffix = /\s*(?:[；;]?\[[^\]]+\]\([^)]*\)\s*)+$/.exec(content)?.[0] ?? ''
  const body = content.slice(0, content.length - suffix.length), needles = passageTerms(queries)
  const ends = [...body.matchAll(/[。！？!?](?:[”’"')）]+)?|\.(?=\s|$)(?:[”’"')）]+)?/g)].map(match => match.index! + match[0].length)
  // 窗口词项＝窗口内各句词项之并：每句只取一次词项，避免对每个句窗重新取词（平方级）。
  // 并集只在窗口内没有任何方括号时与整段取词相同：plainPoint 按正则去掉链接，方括号会跨句与别的片段组成链接——
  // 链接文字里的问号、句号会把链接切成两句（英文标题“What do nurses think? A study”），
  // 窗口末尾未闭合的“[”还会与尾部证据链接拼成一个链接被整体去掉。所以窗口只要含方括号，就对整段窗口取词。
  // 其余情况不会跨句成词：句界总在标点处，取词先把非字母数字替换为空格，中文二元组也不会跨过标点。
  const suffixCost = tokenCost(suffix), weights = [...needles]
  const starts = ends.map((_, index) => {
    const start = index ? ends[index - 1]! : 0, tail = body.slice(start)
    return start + tail.length - tail.trimStart().length
  })
  const sentence = ends.map((end, index) => passageVocabulary(plainPoint(body.slice(starts[index]!, end))))
  const cost = ends.map((end, index) => tokenCost(body.slice(starts[index]!, end)))
  // 句与句之间的空白也属于窗口文本，所以按到下一句结尾为止的原文判断，不只看句子本身。
  const bracket = ends.map((end, index) => /[[\]]/.test(body.slice(index ? ends[index - 1]! : 0, end)))
  // 含方括号的窗口要整段取词；同一段文字（如重复句式）的窗口文本常常相同，按文本复用得分，结果不变。
  const windowScores = new Map<string, number>()
  let best = { content: '', offset: 0, score: -1 }
  for (let index = 0; index < ends.length; index++) {
    const offset = starts[index]!
    let words = new Set<string>(), used = suffixCost, exact = true
    for (let next = index; next < ends.length; next++) {
      const end = ends[next]!
      if (end <= offset) continue
      // 句与句之间的空白也计入原文长度，因此按窗口实际文本计费，不累加句子成本。
      used = next === index ? cost[index]! + suffixCost : tokenCost(body.slice(offset, end)) + suffixCost
      if (used > budget) break
      if (bracket[next]) exact = false
      const text = body.slice(offset, end) + suffix
      if (exact) for (const word of sentence[next]!) words.add(word)
      let score = exact ? weights.reduce((sum, [needle, weight]) => sum + (words.has(needle) ? weight : 0), 0) : windowScores.get(text)
      if (score === undefined) {
        const vocabulary = passageVocabulary(plainPoint(text))
        score = weights.reduce((sum, [needle, weight]) => sum + (vocabulary.has(needle) ? weight : 0), 0)
        windowScores.set(text, score)
      }
      if (score > best.score || score === best.score && text.length > best.content.length) best = { content: text, offset, score }
    }
  }
  return best
}
