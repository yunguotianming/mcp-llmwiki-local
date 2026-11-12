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
export function pageParagraphs(content: string, queries: string[], pointMatches: PointMatch[] = []) {
  const needles = [...new Set(passageQueries(queries).flatMap(query => [...terms(query)]))], lines = content.split('\n')
  const blocks: { content: string; anchor: string; locator: string; score: number; line: number; pointScore: number; evidence: boolean; refs: string[] }[] = []
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
  let anchor = '', headingAnchor = '', start = 0, buffer: string[] = [], excludedDepth = 0
  let frontmatter = lines[0]?.trim() === '---'
  const flush = () => {
    const raw = buffer.join('\n')
    // 引文只取连续原文；图片及编码在原始位置分隔，不能把替换占位符当成页面引文。
    for (const span of separateImages(raw).mapping.filter(span => !span.replacement)) {
      const piece = raw.slice(span.originalStart, span.originalEnd), text = piece.trim()
      const line = start + raw.slice(0, span.originalStart + piece.length - piece.trimStart().length).split('\n').length - 1
      const vocabulary = terms(text)
      const refs = [...text.matchAll(/#\^(p[a-zA-Z0-9-]+)/g)].map(match => match[1]!)
      const evidence = /^\^p[a-zA-Z0-9-]+$/.test(anchor)
      if (evidence) refs.push(anchor.slice(1))
      if (text && !/^(?:本节无独立要点。|可信度依据：|主题归属需要向量；)/.test(text)) blocks.push({ content: text, anchor: refs[0] ? '^' + refs[0] : anchor || 'L' + (line + 1), locator: `L${line + 1}-L${line + text.split('\n').length}`, line,
        score: needles.reduce((score, needle) => score + Number(vocabulary.has(needle)), 0), pointScore: 0, evidence, refs })
    }
    buffer = []
  }
  lines.forEach((line, index) => {
    if (frontmatter) { if (index && line.trim() === '---') frontmatter = false; return }
    const section = /^(#{1,6})\s+(.+)/.exec(stripBlockIds(line))
    if (section && excludedDepth && section[1]!.length <= excludedDepth) excludedDepth = 0
    if (section && section[1]!.length > 1 && /^(?:(?:来源|章节|子主题|主题|术语)?导航|(?:章节)?目录|(?:提取|覆盖|质量|核对|补标)?缺口(?:清单)?|来源(?:列表|路径)?|未核实)$/.test(section[2]!.trim())) {
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
  for (const block of blocks) block.pointScore = Math.max(0, ...block.refs.map(ref => scores.get(ref) ?? 0))
  return blocks.sort((a, b) => b.pointScore - a.pointScore || Number(a.evidence) - Number(b.evidence) || b.score - a.score || a.line - b.line)
}
export function excerpts(page: { library: string; path: string; title: string; content: string }, queries: string[], budget: number, pointMatches: PointMatch[] = []): PageExcerpt[] {
  const result: PageExcerpt[] = []
  const blocks = pageParagraphs(page.content, queries, pointMatches)
  // 标题用于定位；优先提供命中正文，再用页首正文补充概览。
  const paragraphs = blocks.filter(block => !block.content.split('\n').every(line => /^(?:#{1,6}\s|<a\s+id=)/.test(line)))
  const candidates = paragraphs.length ? paragraphs : blocks
  // 已有主张段时先提供不同事实，再用原文证据补充，避免同一点的重复展示耗尽预算。
  const matches = candidates.filter(block => block.pointScore > 0 || block.score > 0).sort((a, b) => Number(a.evidence) - Number(b.evidence))
  const overview = candidates.filter(block => block.pointScore === 0 && block.score === 0).sort((a, b) => a.line - b.line)
  const seen = new Set<string>()
  for (const block of [...matches, ...overview]) {
    if (budget < 1) break
    const key = block.content.replace(/\[(?:证据|回源)\]/g, '[]')
    if (seen.has(key)) continue
    seen.add(key)
    const window = passageWindow(block.content, passageQueries(queries), budget)
    const content = window.content, tokens = tokenCost(content), line = block.line + block.content.slice(0, window.offset).split('\n').length - 1
    if (!content) break
    result.push({ library: page.library, path: page.path, title: page.title, anchor: block.anchor, locator: `L${line + 1}-L${line + content.split('\n').length}`, quote_hash: signature(content), content, tokens })
    budget -= tokens
  }
  return result
}

// 超长单元在句界选择命中窗口，输出始终是未改写的连续子串。
function passageWindow(content: string, queries: string[], budget: number): { content: string; offset: number } {
  if (tokenCost(content) <= budget) return { content, offset: 0 }
  const needles = [...new Set(queries.flatMap(query => [...terms(query)]))]
  const starts = [0, ...[...content.matchAll(/[。！？!?；;\n]|\.(?=\s)/g)].map(match => match.index! + match[0].length)]
  let best = { content: tokenSlice(content, budget), offset: 0, score: -1, complete: false }
  for (const start of starts) {
    const tail = content.slice(start), offset = start + tail.length - tail.trimStart().length
    const text = tokenSlice(content.slice(offset), budget), vocabulary = terms(text)
    const score = needles.reduce((sum, needle) => sum + Number(vocabulary.has(needle)), 0)
    const complete = /[。！？!?；;.]\s*$/.test(text)
    if (text && (score > best.score || score === best.score && complete && !best.complete)) best = { content: text, offset, score, complete }
  }
  return best
}
