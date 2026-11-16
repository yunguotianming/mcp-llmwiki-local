import { expect, it, vi } from 'vitest'
import { evidenceBlockIds } from '../src/layered/anchors.js'
import { reviewTopicContent } from '../src/layered/topic-review.js'
import type { BuildLayeredOptions, Point } from '../src/layered/schema.js'

async function fixture(mode: 'protocol' | 'transport' | 'mixed' | 'semantic' | 'blocks') {
  const members: Point[] = Array.from({ length: mode === 'blocks' ? 3 : 1 }, (_, index) => {
    const source = 'S-000' + (index + 1), text = mode === 'blocks' ? '完整成员依据。'.repeat(450) : '成员原文依据。'
    return { point_id: source + ':point', text, text_hash: '原段摘要', section: '主要发现', locator: 'L1-L1', source_version: 'v1',
      evidence: [{ source_id: source, source_version: 'v1', locator: 'L1-L1', quote: text }] }
  })
  const anchors = evidenceBlockIds(members)
  const links = members.map(point => {
    const source = point.point_id.split(':')[0]
    return `[${source}](../sources/${source}.md#^${anchors.get(point.point_id)![0]})`
  }).join('；')
  const content = Array.from({ length: mode === 'blocks' ? 12 : 2 }, (_, index) => `- 条件${index + 1}下观察10次结果。 ${links}`).join('\n')
  const requests: any[] = []
  const call = vi.fn<BuildLayeredOptions['client']['call']>(async (_task, _system, raw) => {
    const input = JSON.parse(raw); requests.push(input)
    if (input.review_stage === 'topic-correction') return JSON.stringify({ sentences: input.sentences.map((item: any) => ({ id: item.id,
      text: item.text, point_ids: input.members.map((point: any) => point.point_id), support: '完整支撑', missing: null })) })
    const final = input.sentences.some((item: any) => item.original_text !== undefined)
    if (mode === 'transport' && !final) throw new Error('离线模拟传输失败')
    const items = input.sentences.flatMap((item: any) => {
      if (!final && (mode === 'protocol' || mode === 'mixed' && item.id === 'S0'
        || mode === 'blocks' && (input.review_stage === 'topic-block' && item.id === 'S0'
          || input.review_stage === 'topic-merge' && item.id !== 'S0'))) return []
      const rejected = !final && (mode === 'mixed' || mode === 'semantic') && item.id === 'S1'
      return [{ id: item.id, support: rejected ? '部分支撑' : '完整支撑', missing: rejected ? '该句仍需补证。' : null,
        ...(input.review_stage === 'topic-block' ? { findings: '本块完整提供相关成员依据。', point_ids: input.members.map((point: any) => point.point_id) } : {}),
        ...(final ? { claim_preserved: true } : {}) }]
    })
    return JSON.stringify({ items })
  })
  const limit = mode === 'blocks' ? 26000 : 120000
  const options: BuildLayeredOptions = { knowledgeRoot: '内存', topics: { topicReview: true, topicReviewInputBudget: limit },
    client: { call, inputBudget: async () => limit, info: async () => ({ provider: '离线', id: '桩', name: '确定性桩' }) } }
  const result = await reviewTopicContent('T-0001', content, members, options)
  return { content, result, requests, corrections: requests.filter(input => input.review_stage === 'topic-correction') }
}

it('初轮所有ID缺项时不发语义纠正，保留原句并明确未完成', async () => {
  const f = await fixture('protocol')
  expect(f.corrections).toEqual([])
  expect(f.result).toMatchObject({ content: f.content, incomplete: true, failure: expect.stringContaining('核对协议缺口') })
  expect(f.result.review?.removed).toEqual([])
})

it('初轮传输错误不发语义纠正，原句与证据链接保持', async () => {
  const f = await fixture('transport')
  expect(f.corrections).toEqual([])
  expect(f.result).toMatchObject({ content: f.content, incomplete: true, failure: expect.stringContaining('离线模拟传输失败') })
  expect(f.result.review?.removed).toEqual([])
})

it('混合缺项仅纠正已完成核对的真实语义拒绝，缺项原句不变', async () => {
  const f = await fixture('mixed')
  expect(f.corrections.flatMap(input => input.sentences.map((item: any) => item.id))).toEqual(['S1'])
  expect(f.result).toMatchObject({ content: f.content, incomplete: true, failure: expect.stringContaining('S0') })
  expect(f.result.review?.removed).toEqual([])
})

it('真实语义拒绝仍纠正并通过最终主张保持核对', async () => {
  const f = await fixture('semantic')
  expect(f.corrections).toHaveLength(1)
  expect(f.requests.some(input => input.sentences.some((item: any) => item.original_text !== undefined))).toBe(true)
  expect(f.result.content).toBe(f.content)
  expect(f.result.failure).toBeUndefined()
})

it('同次分块及合并缺项均保留，不进入语义纠正或删句', async () => {
  const f = await fixture('blocks')
  expect(f.requests.some(input => input.review_stage === 'topic-block')).toBe(true)
  expect(f.requests.some(input => input.review_stage === 'topic-merge')).toBe(true)
  expect(f.corrections).toEqual([])
  expect(f.result).toMatchObject({ content: f.content, incomplete: true, failure: expect.stringContaining('核对协议缺口') })
  expect(f.result.review?.removed).toEqual([])
})
