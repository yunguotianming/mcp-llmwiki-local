import { locatorRange } from './schema.js'
import { matchQuotation, normalizeQuotation } from './quotation.js'
import type { EvidenceParagraph } from './evidence.js'

export const sameClaim = (original: unknown, corrected: unknown): boolean => typeof original === 'string'
  && typeof corrected === 'string' && normalizeQuotation(original) === normalizeQuotation(corrected)

// 词法层只给出硬拒收信号；返回 true 仍须逐句核对证据与原主张，不能作为语义等价证明。
// 来源标题是身份：只按提供的 source_id＋source_title 绑定，不把标题中的词当正文事实。
export function preservesClaimFacts(original: string, corrected: string,
  sources: readonly { source_id: string; source_title: string }[] = []): boolean {
  const normalize = (text: string) => {
    let value = normalizeQuotation(text).replace(/(?<![A-Za-z0-9])P\d+(?![A-Za-z0-9])/g, '').replace(/[（(][、,，\s]*[）)]/g, '')
    for (const source of [...sources].sort((a, b) => b.source_title.length - a.source_title.length)) {
      if (source.source_title.trim()) value = value.replaceAll(normalizeQuotation(source.source_title), source.source_id)
    }
    // 只规范已知单复数，不推断陌生缩写或角色称谓的等价关系。
    return value.replace(/\bCRNs\b/g, 'CRN').replace(/\b(nurse|researcher|student|participant|patient)s\b/gi, '$1')
      .replace(/不一定/g, '未必').replace(/\s+/g, ' ').trim()
  }
  const beforeText = normalize(original), afterText = normalize(corrected)
  // P 编号变动是补证；正文相同不作事实比较，引用有效性仍由调用方校验。
  if (beforeText === afterText) return true
  const clauses = (text: string) => text.split(/[，,；;。！？!?]|\.(?=\s|$)|并且|而且|但是|然而|\band\b(?=\s+(?:did|does|do|is|are|was|were|has|have)\b)/u).map(value => value.trim()).filter(Boolean)
  const dependency = /(?:如果|仅当|只有|除非|前提|条件下|期间|范围内|之后|之前|后方可|除.+外|与.+相比|经.+后|在.+时|相对于|回复邀请且|符合.+(?:条件|标准)|仅限)/u
  const predicates = /参与(?!者)|参加|使用|采用|提供|纳入|包括|包含|贡献|负责|实施|开展|进行|接受|完成|提高|降低|增加|减少|改善|导致|属于|存在|代表|支持|反对|签署|申请|\b(?:participat\w*|provid\w*|includ\w*|use[ds]?|support\w*|oppose[ds]?|increas\w*|decreas\w*)\b/giu
  const anchors = (text: string) => {
    // 否定必须作用于谓词；不把“一无所知”“非临床”的单字当整句否定。
    const negatives = [...text.matchAll(predicates)].flatMap(match => {
      const prefix = text.slice(0, match.index)
      return /(?:没有|不能|不得|不曾|从未|并非|未|不)(?:再|曾|曾经|直接|明确)?$|\b(?:not|no|never|neither|without)\s+$|n['’]t\s*$/iu.test(prefix) ? [match[0]] : []
    })
    const quantities = text.match(/\d+(?:[.,]\d+)*(?:%|％)?|首次|第[零〇一二三四五六七八九十百千万亿两\d]+(?:次|轮|期|位|名)|[零〇一二三四五六七八九十百千万亿两]+(?=名|人|项|个|组|场|次|轮|年|月|天|分钟|小时|篇|位|种|份|类|周)|全部|所有|部分|多数|少数|许多|\b(?:all|some|many|few|one|two|three|four|five|six|seven|eight|nine|ten)\b/giu) ?? []
    const attribution = text.match(/\bS-\d+\b|[甲乙丙丁戊己庚辛壬癸](?:研究|团队|组|机构|医院|大学)|[\p{L}\p{N}]+(?:研究|团队|作者|组|机构|医院|大学)(?:中|内)?的|\b[A-Z][\p{L}\p{N}-]*\b/gu) ?? []
    const modal = text.match(/可能|或许|也许|未必|一定|必然|必须|应当|须|可(?=以|在|向|由|被|获得|获取|提供|使用|参与|签署|申请)|\b(?:may|might|must|should|could)\b/giu) ?? []
    const bounds = text.match(/少于|多于|至少|至多|超过|不足|不超过|不低于|大于|小于|等于|[<>≤≥]=?/gu) ?? []
    const directions = (text.match(/提高|提升|升高|上升|降低|下降|增加|增多|减少|支持|赞成|反对|参与(?!者)|参加|使用|采用/gu) ?? [])
      .map(word => /提高|提升|升高|上升/.test(word) ? '提高' : /降低|下降/.test(word) ? '降低' : /增加|增多/.test(word) ? '增加'
        : /支持|赞成/.test(word) ? '支持' : /参与|参加/.test(word) ? '参与' : /使用|采用/.test(word) ? '使用' : word)
    const restrictions = text.match(/回复邀请且|符合[^，；。]*?(?:条件|标准)|仅限[^，；。]*|除[^，；。]+外|与[^，；。]+相比|(?<=在)[^，；。]*?期间|(?:研究|随访|治疗|观察|干预)期间|经[^，；。]+后/g) ?? []
    return JSON.stringify([negatives, quantities, attribution, modal, bounds, directions, restrictions])
  }
  const before = clauses(beforeText), after = clauses(afterText)
  if (!after.length) return false
  let offset = 0
  for (const clause of after) {
    let index = before.findIndex((value, i) => i >= offset && value === clause)
    if (index < 0) index = before.findIndex((value, i) => i >= offset && anchors(value) === anchors(clause))
    if (index < 0 || before.slice(offset, index).some(value => dependency.test(value))) return false
    offset = index + 1
  }
  // 删除独立无据断言可以保留其余部分；被删条件、时间、比较或例外不能放宽保留主张。
  return !before.slice(offset).some(value => dependency.test(value))
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
