import { parseModelJson } from '../llm/json.js'
import { createHash } from 'node:crypto'

// 仅合并同一来源版本、同一范围的原文；短键由请求内的稳定遍历顺序确定。
export function reviewContextTable() {
  const contexts: Record<string, { source_id: string; source_version: string; range: string; text: string }> = {}
  const keys = new Map<string, string>()
  return { contexts, reference(source_id: string, source_version: string, range: string, text: string) {
    const identity = JSON.stringify([source_id, source_version, range])
    const existing = keys.get(identity)
    if (existing) {
      if (contexts[existing]!.text !== text) throw new Error('同一来源版本及范围的核对上下文不一致。')
      return existing
    }
    const key = 'C' + (keys.size + 1)
    keys.set(identity, key)
    contexts[key] = { source_id, source_version, range, text }
    return key
  } }
}

export interface EvidenceParagraph { paragraph_id: number; locator: string; text_hash: string; text: string }
export interface EvidenceDictionary {
  paragraphs: (Omit<EvidenceParagraph, 'text'> & { text?: string; evidence_ref?: string })[]
  dictionary: Record<string, { quote: string; references: { paragraph_id: number; locator: string }[] }>
}
export function evidenceDictionary(paragraphs: EvidenceParagraph[]): EvidenceDictionary {
  const dictionary: EvidenceDictionary['dictionary'] = {}, counts = new Map<string, number>()
  const values: EvidenceDictionary['paragraphs'] = paragraphs.map(paragraph => {
    const ref = 'E-' + createHash('sha256').update(paragraph.text.replaceAll('\r\n', '\n')).digest('hex').slice(0, 16)
    const item = dictionary[ref] ??= { quote: paragraph.text, references: [] }
    item.references.push({ paragraph_id: paragraph.paragraph_id, locator: paragraph.locator })
    counts.set(ref, (counts.get(ref) ?? 0) + 1)
    return { ...paragraph, evidence_ref: ref }
  })
  for (const [index, value] of values.entries()) {
    const ref = value.evidence_ref!
    if (counts.get(ref)! > 1) {
      const { text: _text, ...paragraph } = value
      values[index] = paragraph
    } else {
      delete value.evidence_ref
      delete dictionary[ref]
    }
  }
  return { paragraphs: values, dictionary }
}
export function expandEvidenceReferences(raw: string, dictionary: EvidenceDictionary['dictionary']): string {
  const output = parseModelJson(raw) as { points?: { paragraph_id?: number; evidence?: Record<string, unknown>[] }[] }
  for (const point of output.points ?? []) for (const evidence of point.evidence ?? []) {
    const ref = evidence.evidence_ref
    if (typeof ref !== 'string') continue
    const item = dictionary[ref], location = item?.references.find(value => value.paragraph_id === (evidence.paragraph_id ?? point.paragraph_id))
      ?? (item?.references.length === 1 ? item.references[0] : undefined)
    if (!item || !location) throw new Error('模型引用了不属于本次请求的证据编号。')
    delete evidence.evidence_ref
    evidence.locator = location.locator
    evidence.quote = item.quote
  }
  return JSON.stringify(output)
}
