import { fromMarkdown } from 'mdast-util-from-markdown'
import { extractSource, processingFingerprint } from '../src/layered/extraction.js'
import { hash } from '../src/layered/files.js'
import type { BuildLayeredOptions, Extraction, Processing } from '../src/layered/schema.js'
import type { LocalSource } from '../src/layered/snapshot.js'

export function customBook(chars: number): LocalSource {
  const text = '# 合成书籍\n\n' + Array.from({ length: 3 }, (_, i) => `## 第${i + 1}章\n\n第${i + 1}章结论成立。\n${'正文事实与条件。'.repeat(Math.ceil(chars / 8)).slice(0, chars)}\n`).join('\n')
  return { path: 'book.md', bytes: Buffer.from(text), text, contentHash: hash(text),
    segments: fromMarkdown(text).children.map(node => ({ start: node.position!.start.offset!, end: node.position!.end.offset!,
      locator: `L${node.position!.start.line}-L${node.position!.end.line}`, text_hash: hash(text.slice(node.position!.start.offset!, node.position!.end.offset!)) })),
    metadata: { title: '合成书籍', source_type: '书籍', credibility: 'low', credibility_reason: '假模型夹具', source_date: '', source_date_basis: '原文日期' } }
}
export function customBookFixture(granularity: NonNullable<Processing['granularity']> = 'custom') {
  const requests: any[] = [], processing: Processing = { tier: 50, granularity, prompt_version: '自定义书籍上限测试' }
  const options: BuildLayeredOptions = { knowledgeRoot: '离线内存', tier: 50, topics: { sourceChapterMinPoints: 0, sourceLongChapterChars: 0 }, client: {
    info: async () => ({ provider: 'mock', id: 'extractor', name: '假模型' }), concurrency: () => 1,
    call: async (_task, _system, input) => {
      const request = JSON.parse(input); requests.push(request)
      if (request.summary_id) return JSON.stringify({ point_ids: request.children.flatMap((child: any) => child.points.map((point: any) => point.point_id)).slice(0, request.point_limit) })
      if (request.validationFeedback) return JSON.stringify(request.validationFeedback.item)
      const part = request.paragraphs.find((part: any) => !/^#{1,6}\s/.test(part.text ?? request.evidence_dictionary[part.evidence_ref].quote))
      const text = part && (part.text ?? request.evidence_dictionary[part.evidence_ref].quote), quote = text?.match(/[^。]+。/)?.[0]
      // 每包至多返回一项有据事实，不用配额凑满结果。
      const points = quote ? [{ paragraph_id: part.paragraph_id, text: quote, section: '主要发现', evidence: [{ locator: part.locator, quote }] }] : []
      return JSON.stringify({ tags: ['研究方法', '研究对象', '核心主题'], credibility: 'low', credibility_reason: '假模型夹具', points, terms: [], summary_point_indices: points.map((_, i) => i) })
    },
  } }
  const run = (source: LocalSource, previous?: Extraction) => extractSource('离线内存', 'S-0001', source, processing, options, 6500, previous)
  return { processing, options, requests, run, extracts: () => requests.filter(request => request.paragraphs && !request.validationFeedback) }
}
export function legacyCustom(result: Extraction, promptHash: string): Extraction {
  const previous = structuredClone(result)
  previous.processing.prompt_hash = promptHash
  delete previous.plan_hard_limit
  for (const segment of previous.segments) segment.processing_fingerprint = processingFingerprint(previous.processing, segment.resource_hashes)
  return previous
}
