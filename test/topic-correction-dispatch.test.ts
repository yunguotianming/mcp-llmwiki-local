import { expect, it, vi } from 'vitest'
import { evidenceBlockIds } from '../src/layered/anchors.js'
import { reviewTopicContent } from '../src/layered/topic-review.js'
import type { BuildLayeredOptions, Point } from '../src/layered/schema.js'

async function fixture(mode: 'candidate' | 'changed' | 'later' | 'final-failed' | 'none') {
  const members: Point[] = Array.from({ length: 3 }, (_, index) => {
    const source = 'S-000' + (index + 1), text = '完整成员依据。'.repeat(450)
    return { point_id: source + ':point', text, text_hash: '成员哈希', section: '主要发现', locator: 'L1-L1', source_version: 'v1',
      evidence: [{ source_id: source, source_version: 'v1', locator: 'L1-L1', quote: text }] }
  })
  const anchors = evidenceBlockIds(members)
  const content = '- 条件甲下观察10次结果。 ' + members.map(point => {
    const source = point.point_id.split(':')[0]
    return `[${source}](../sources/${source}.md#^${anchors.get(point.point_id)![0]})`
  }).join('；')
  const requests: any[] = []
  let corrections = 0
  const call = vi.fn<BuildLayeredOptions['client']['call']>(async (_task, _system, raw) => {
    const input = JSON.parse(raw); requests.push(input)
    if (input.review_stage === 'topic-correction') {
      corrections++
      if (mode === 'none' || mode === 'later' && corrections === 1) return JSON.stringify({ sentences: [] })
      return JSON.stringify({ sentences: input.sentences.map((item: any) => ({ id: item.id,
        text: mode === 'changed' ? item.text.replace('10次', '20次') : item.text,
        point_ids: input.members.map((point: any) => point.point_id), support: '完整支撑', missing: null })) })
    }
    const final = input.sentences.some((item: any) => item.original_text !== undefined)
    const supported = final && mode !== 'final-failed'
    return JSON.stringify({ items: input.sentences.map((item: any) => ({ id: item.id,
      support: supported ? '完整支撑' : '部分支撑', missing: supported ? null : '仍需补充证据。',
      ...(input.review_stage === 'topic-block' ? { findings: '本块提供已有成员证据。', point_ids: input.members.map((point: any) => point.point_id) } : {}),
      ...(final ? { claim_preserved: mode !== 'final-failed' } : {}) })) })
  })
  const options: BuildLayeredOptions = { knowledgeRoot: '内存', topics: { topicReview: true, topicReviewInputBudget: 26000 },
    client: { call, inputBudget: async () => 26000, info: async () => ({ provider: '离线', id: '桩', name: '确定性桩' }) } }
  const result = await reviewTopicContent('T-0001', content, members, options)
  return { content, members, requests, corrections, result }
}

it('已有候选后不再派发必然忽略的成员块，仍执行最终核对', async () => {
  const f = await fixture('candidate')
  expect(f.corrections).toBe(1)
  expect(f.requests.some(input => input.sentences.some((item: any) => item.original_text !== undefined))).toBe(true)
  expect(f.result.review?.removed).toEqual([])
  expect(f.result.content).toBe(f.content)
})

it('事实改变成为终态后不再派发后续块，也不能保留改写', async () => {
  const f = await fixture('changed')
  expect(f.corrections).toBe(1)
  expect(f.result.review?.reasons).toEqual([expect.objectContaining({ reason: '改变原主张' })])
  expect(f.result.content).not.toContain('20次')
})

it('尚无候选时继续下一个成员块，找到候选后才停止', async () => {
  const f = await fixture('later')
  expect(f.corrections).toBe(2)
  expect(f.result.review?.removed).toEqual([])
  expect(f.result.content).toBe(f.content)
})

it('首候选最终核对不通过仍删除原句，不把候选当作已接受', async () => {
  const f = await fixture('final-failed')
  expect(f.corrections).toBe(1)
  expect(f.result.review?.removed).toHaveLength(1)
  expect(f.result.content).not.toContain('观察10次')
})

it('纠正节流不减少首轮证据遍历，无候选仍遍历全部纠正块', async () => {
  const f = await fixture('none')
  const initial = f.requests.filter(input => input.review_stage === 'topic-block' && input.sentences.every((item: any) => item.original_text === undefined))
  expect(initial).toHaveLength(3)
  expect(initial.flatMap(input => input.members.map((point: any) => point.point_id))).toEqual(['P1', 'P2', 'P3'])
  expect(f.corrections).toBe(3)
})
