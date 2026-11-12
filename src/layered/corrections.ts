import { locatorRange } from './schema.js'
import { matchQuotation, normalizeQuotation } from './quotation.js'
import type { EvidenceParagraph } from './evidence.js'

export const sameClaim = (original: unknown, corrected: unknown): boolean => typeof original === 'string'
  && typeof corrected === 'string' && normalizeQuotation(original) === normalizeQuotation(corrected)

// 综合句可以改措辞、删除完整分句，但保留分句的否定、数量与归属锚点必须不变。
// 无法证明锚点一致就拒收，由主题核对的既有删句/缺口路径处理。
export function preservesClaimFacts(original: string, corrected: string): boolean {
  if (sameClaim(original, corrected)) return true
  const clauses = (text: string) => normalizeQuotation(text).split(/[，,；;。！？!?]|\.(?=\s|$)|并且|而且|但是|然而|\band\b(?=\s+(?:did|does|do|is|are|was|were|has|have)\b)/u).map(value => value.trim()).filter(Boolean)
  const anchors = (text: string) => {
    const negatives = text.match(/没有|不得|不能|不曾|从未|并非|未|不|无|非|\b(?:not|no|never|neither|without)\b|n['’]t/giu) ?? []
    const quantities = text.match(/\d+(?:[.,]\d+)*(?:%|％)?|[零〇一二三四五六七八九十百千万亿两]+|全部|部分|多数|少数|\b(?:all|some|many|few|one|two|three|four|five|six|seven|eight|nine|ten)\b/giu) ?? []
    // 谓语之前的对象及“某研究/作者的”归属保持逐字；不把措辞变化当作对象替换。
    const predicate = /没有|未|不|无|并非|采用|使用|参与|纳入|包括|包含|发现|显示|表明|报告|认为|指出|提出|负责|实施|开展|进行|接受|提供|完成|作出|作贡献|贡献|提高|降低|增加|减少|改善|导致|属于|是|为|有|\b(?:is|are|was|were|has|have|had|did|does|do|used?|participat\w*|includ\w*|report\w*|found|show\w*|suggest\w*|conduct\w*|receiv\w*)\b/iu.exec(text)
    const subject = predicate ? text.slice(0, predicate.index).trim() : ''
    const head = predicate ? text.slice(0, predicate.index) : text
    const attribution = [
      ...(text.match(/[\p{L}\p{N}]+(?:研究|团队|作者|组|机构|医院|大学)(?:中|内)?的|\b[\p{L}\p{N}]+['’]s\b/giu) ?? []),
      ...(head.match(/[\p{L}\p{N}]+?(?:研究|团队|组|机构|医院|大学)/gu) ?? []),
      ...(text.match(/\b[A-Z][\p{L}\p{N}-]*\b/gu) ?? []),
    ]
    return { facts: JSON.stringify([negatives, quantities, attribution]), subject }
  }
  const before = clauses(original), after = clauses(corrected)
  let offset = 0
  return after.every(clause => {
    const next = anchors(clause)
    const index = before.findIndex((value, i) => {
      const previous = anchors(value)
      // 无主语的概括可补明对象；已有归属不可替换或删除。
      return i >= offset && previous.facts === next.facts && (!previous.subject || previous.subject === next.subject)
    })
    if (index < 0) return false
    offset = index + 1
    return true
  })
}

// 只改同一来源内唯一逐字命中的定位；歧义和未命中继续交给原有纠正流程。
export function repairParagraphs(parts: EvidenceParagraph[], item: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(item.evidence)) return item
  const evidence = item.evidence.map(value => {
    if (!value || typeof value !== 'object' || typeof value.quote !== 'string' || !value.quote.trim()) return value
    if (evidenceParagraph(parts, value)) return value
    const matches = parts.filter(part => matchQuotation(part.text, value.quote))
    if (matches.length !== 1) return value
    const part = matches[0]!
    return { ...value, paragraph_id: part.paragraph_id, locator: part.locator }
  })
  const ids = new Set(evidence.map(value => value?.paragraph_id))
  return { ...item, evidence, ...(ids.size === 1 && typeof evidence[0]?.paragraph_id === 'number' ? { paragraph_id: evidence[0].paragraph_id } : {}) }
}

export function evidenceParagraph(parts: EvidenceParagraph[], evidence: { paragraph_id?: number | undefined; locator?: string | undefined; quote?: string | undefined }): EvidenceParagraph | undefined {
  let candidates = parts
  if (evidence.paragraph_id !== undefined) candidates = candidates.filter(part => part.paragraph_id === evidence.paragraph_id)
  if (evidence.locator) candidates = candidates.filter(part => {
    if (part.locator.startsWith('block:')) return part.locator === evidence.locator
    try { const [start, end] = locatorRange(evidence.locator!), [first, last] = locatorRange(part.locator); return start >= first && end <= last }
    catch { return false }
  })
  if (evidence.quote) candidates = candidates.filter(part => matchQuotation(part.text, evidence.quote!))
  return candidates.length === 1 ? candidates[0] : undefined
}

// 每项独立附自己的引文段及前后两段；找不到锚点时交回缺口，禁止退回整包。
export function correctionContext(parts: EvidenceParagraph[], item: Record<string, unknown>): EvidenceParagraph[] {
  const anchors = new Set<number>()
  for (const evidence of Array.isArray(item.evidence) ? item.evidence : []) {
    if (!evidence || typeof evidence !== 'object') continue
    const found = evidenceParagraph(parts, evidence) ?? (typeof evidence.quote === 'string' ? evidenceParagraph(parts, { quote: evidence.quote }) : undefined)
    if (found) anchors.add(parts.indexOf(found))
  }
  if (typeof item.paragraph_id === 'number') parts.forEach((part, index) => { if (part.paragraph_id === item.paragraph_id) anchors.add(index) })
  if (typeof item.locator === 'string') {
    const found = evidenceParagraph(parts, { locator: item.locator })
    if (found) anchors.add(parts.indexOf(found))
  }
  return parts.filter((_, index) => [...anchors].some(anchor => Math.abs(anchor - index) <= 2))
}

export function correctionBatches<T>(items: T[], fits: (batch: T[]) => boolean, maxBatches = 2): { batches: T[][]; overflow: T[] } {
  const batches: T[][] = [], overflow: T[] = []
  for (const item of items) {
    if (!maxBatches || !fits([item])) { overflow.push(item); continue }
    if (!batches.length || !fits([...batches.at(-1)!, item])) {
      if (batches.length === maxBatches) { overflow.push(item); continue }
      batches.push([])
    }
    batches.at(-1)!.push(item)
  }
  return { batches, overflow }
}
