import { expect, it, vi } from 'vitest'
import { extractSource } from '../src/layered/extraction.js'
import { hash } from '../src/layered/files.js'
import type { BuildLayeredOptions } from '../src/layered/schema.js'
import type { LocalSource } from '../src/layered/snapshot.js'

// 本用例计模型调用与逐项验收；真实原子存储由30路状态与完整发布用例验证。
vi.mock('../src/layered/files.js', async original => ({ ...await original<typeof import('../src/layered/files.js')>(), writeJson: async () => {}, appendLog: async () => {} }))
it('20篇320条结构缺失压到20次批纠正，所有320条逐字验收且不改主张', async () => {
  const text = '研究结果增加20%。', source: LocalSource = { path: '公开夹具.md', text, bytes: Buffer.from(text), contentHash: hash(text),
    segments: [{ start: 0, end: text.length, locator: 'L1-L1', text_hash: hash(text) }],
    metadata: { title: '研究', source_type: '论文', credibility: 'high', credibility_reason: '公开论文', source_date: '2026-11-09', source_date_basis: '原文日期' } }
  let corrections = 0, initial = 0
  const options: BuildLayeredOptions = { knowledgeRoot: '只读输入的内存夹具', topics: false, client: { concurrency: () => 30,
    info: async () => ({ provider: 'mock', id: 'mock', name: 'mock' }), call: async (_task, prompt, input) => {
      const data = JSON.parse(input)
      if (data.correction_stage) {
        corrections++; expect(data.items).toHaveLength(16)
        return JSON.stringify({ items: data.items.map((item: any) => ({ id: item.id, paragraph_id: 0, section: '主要发现', evidence: item.validationFeedback.item.evidence })) })
      }
      initial++; expect(prompt).toContain('合法JSON示例')
      return JSON.stringify({ tags: ['研究方法', '研究结果', '研究对象'], credibility: 'high', credibility_reason: '公开论文', terms: [],
        points: Array.from({ length: 16 }, (_, i) => ({ text: '研究主张' + i, evidence: [{ locator: 'L1-L1', quote: text }] })) })
    } } }
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => extractSource('内存测试根', 'S-' + i, source,
    { tier: 50, granularity: 'custom', prompt_version: '测试', model: 'mock/mock' }, options, 64000)))
  expect(initial).toBe(20); expect(corrections).toBe(20)
  for (const result of results) {
    expect(result.gaps).toEqual([])
    expect(result.segments[0]!.points.map(point => point.text)).toEqual(Array.from({ length: 16 }, (_, i) => '研究主张' + i))
    expect(result.segments[0]!.points.every(point => point.evidence[0]!.quote === text)).toBe(true)
  }
})
