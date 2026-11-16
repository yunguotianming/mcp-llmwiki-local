import { fromMarkdown } from 'mdast-util-from-markdown'
import { beforeEach, expect, it, vi } from 'vitest'
import { extractSource } from '../src/layered/extraction.js'
import { hash } from '../src/layered/files.js'
import type { LocalSource } from '../src/layered/snapshot.js'
import type { BuildLayeredOptions, Extraction, Processing } from '../src/layered/schema.js'

const saved = vi.hoisted(() => new Map<string, unknown>())
vi.mock('../src/layered/files.js', async original => ({ ...await original<typeof import('../src/layered/files.js')>(),
  writeJson: async (_root: string, name: string, value: unknown) => { saved.set(name, structuredClone(value)) }, appendLog: async () => {},
}))
beforeEach(() => saved.clear())
const processing: Processing = { tier: 50, granularity: 'custom', prompt_version: '长文测试', model: 'mock/extractor' }
function source(text: string): LocalSource {
  return { path: 'book.md', bytes: Buffer.from(text), text, contentHash: hash(text),
    segments: fromMarkdown(text).children.map(node => ({ start: node.position!.start.offset!, end: node.position!.end.offset!,
      locator: `L${node.position!.start.line}-L${node.position!.end.line}`, text_hash: hash(text.slice(node.position!.start.offset!, node.position!.end.offset!)) })),
    metadata: { title: '合成长书', source_type: '书籍', credibility: 'low', credibility_reason: '假模型资料', source_date: '2026-11-08', source_date_basis: '原文日期' } }
}
function book(chapters = 9, chars = 700): string {
  return '# 合成长书\n\n' + Array.from({ length: chapters }, (_, index) => `## 第${index + 1}章\n\n第${index + 1}章结论成立。\n${'正文事实与条件。'.repeat(Math.ceil(chars / 8)).slice(0, chars)}\n`).join('\n')
}
function fixture(limit = 6500, overrides: Partial<BuildLayeredOptions> = {}) {
  const requests: any[] = []
  const client: BuildLayeredOptions['client'] = {
    info: async () => ({ provider: 'mock', id: 'extractor', name: '假模型' }), concurrency: () => 1,
    call: async (_task, _system, input) => {
      const request = JSON.parse(input); requests.push(request)
      if (request.summary_id) return JSON.stringify({ point_ids: request.children.flatMap((child: any) => child.points.map((point: any) => point.point_id)).slice(0, request.point_limit) })
      if (request.validationFeedback) return JSON.stringify(request.validationFeedback.item)
      const parts = request.paragraphs.filter((part: any) => !/^#{1,6}\s/.test(part.text ?? request.evidence_dictionary[part.evidence_ref].quote))
      const points = Array.from({ length: parts.length ? request.point_limit : 0 }, (_, index) => {
        const part = parts[index % parts.length], text = part.text ?? request.evidence_dictionary[part.evidence_ref].quote
        const facts = text.split('\n').filter((line: string) => /第\d+章第\d+项结论成立。/.test(line))
        const quote = facts.length ? facts[index % facts.length] : text.split('\n')[0]
        const line = 'L' + (Number(part.locator.split('-')[0].slice(1)) + text.slice(0, text.indexOf(quote)).split('\n').length - 1)
        return { paragraph_id: part.paragraph_id, text: quote, section: '主要发现', evidence: [{ locator: `${line}-${line}`, quote }] }
      })
      return JSON.stringify({ tags: ['研究方法', '研究对象', '核心主题'], credibility: 'low', credibility_reason: '假模型资料', points, terms: [], summary_point_indices: points.slice(0, request.summary_point_limit).map((_, index) => index) })
    },
  }
  const options: BuildLayeredOptions = { knowledgeRoot: '离线内存', client, topics: false, ...overrides }
  const run = (input: LocalSource, previous?: Extraction) => extractSource('离线内存', 'S-0001', input, processing, options, limit, previous)
  return { options, requests, run, extracts: () => requests.filter(request => request.paragraphs && !request.validationFeedback), summaries: () => requests.filter(request => request.summary_id) }
}

it('修复B2：组摘要失败不缓存为成功，下次只补摘要后清除缺口', async () => {
  const input = source(book()), first = fixture(), original = first.options.client.call
  first.options.client.call = async (...args) => {
    const output = JSON.parse(await original(...args))
    if (JSON.parse(args[2]).paragraphs?.some((part: any) => part.text?.includes('第2章结论'))) output.summary_point_indices = [999]
    return JSON.stringify(output)
  }
  const a = await first.run(input), next = fixture(), b = await next.run(input, a)
  const missing = Object.entries(a.group_cache!).filter(([, group]) => group.missing_summary).map(([key]) => key)
  expect(missing).toHaveLength(1)
  expect(a.summary!.missing.length).toBeGreaterThan(0); expect(next.extracts()).toHaveLength(0)
  expect(next.summaries().filter(request => missing.includes(request.summary_id))).toHaveLength(1)
  expect(b.segments.flatMap(segment => segment.points)).toEqual(a.segments.flatMap(segment => segment.points))
  expect(missing.every(key => b.group_cache![key]!.missing_summary === false)).toBe(true)
  expect(b.summary!.missing).toEqual([]); expect(b.gaps).toEqual([])
})
