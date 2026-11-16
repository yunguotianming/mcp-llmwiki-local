import { expect, it } from 'vitest'
import { reviewTopicContent, topicSentences } from '../src/layered/topic-review.js'
import { point, reviewFixture } from './quality-fix2-audit-fixture.js'

const body = '# 结果\n范围：实验。\n## 共识\n提高1.5%。下降2%。 [证据](sources/a.md#p)\n## 来源导航\n[来源](a.md)'
it('A16 主题每主题一次逐句，精细含归属，未变主题零调用', async () => {
  const f = reviewFixture(); f.options.tier = 100
  const first = await reviewTopicContent('T1', body, [point()], f.options)
  expect(first.calls).toBe(1)
  const input = JSON.parse(f.call.mock.calls[0]![2])
  expect(input.contradiction_attribution).toBe(true)
  expect(input.sentences.map((s: any) => s.text)).toContain('提高1.5%。')
  expect(input.sentences.some((s: any) => s.text.includes('[来源]'))).toBe(true)
  const second = await reviewTopicContent('T1', first.content, [point()], f.options, first.review)
  expect(second.calls).toBe(0)
})
it('A17 主题纠正失败删句留痕且成员不可变', async () => {
  const f = reviewFixture(), members = [point()], before = structuredClone(members)
  f.call.mockImplementation(async (_t, _s, raw) => { const input = JSON.parse(raw); return JSON.stringify(input.review_stage === 'topic' ? { items: input.sentences.map((s: any) => ({ id: s.id, support: s.text.includes('下降') ? '不支撑' : '完整支撑', missing: s.text.includes('下降') ? '无依据' : '' })) } : { sentences: input.validationFeedback.map((s: any) => ({ id: s.id, text: '', point_ids: [], support: '不支撑', missing: '无依据' })) }) })
  const result = await reviewTopicContent('T1', body, members, f.options)
  expect(result.calls).toBe(2); expect(result.content).not.toContain('下降2%'); expect(result.review?.removed).toHaveLength(1); expect(members).toEqual(before)
})
it('A18 单主题调用异常不抛出且保留失败记录', async () => {
  const f = reviewFixture(); f.call.mockRejectedValue(new Error('模拟主题失败'))
  const result = await reviewTopicContent('T1', body, [point()], f.options)
  // 核对调用失败即为核对未完成，不再派发注定失败的纠正（43415e2），只计初轮 1 次。
  expect(result.calls).toBe(1); expect(result.incomplete).toBe(true); expect(result.failure!.length).toBeGreaterThan(0)
  expect(result.failure).toContain('模拟主题失败')
  expect(result.content).toBe(body)
  expect(result.review?.removed).toEqual([])
})
it('A19 标题中的不支撑主张不得纠正成普通正文', async () => {
  const f = reviewFixture()
  f.call.mockImplementation(async (_t, _s, raw) => { const input = JSON.parse(raw); return JSON.stringify(input.review_stage === 'topic' ? { items: [{ id: 'S0', support: '不支撑', missing: '标题夸大' }] } : { sentences: [{ id: 'S0', text: '普通正文失去标题', point_ids: ['P1'], support: '完整支撑', missing: '' }] }) })
  const result = await reviewTopicContent('T1', '# 夸大标题', [point()], f.options)
  expect(result.content.startsWith('# ')).toBe(true)
})
it('A20 同行英文紧接的两个句子也逐句核对', () => {
  expect(topicSentences('It improves!It harms.').map(s => s.text)).toEqual(['It improves!', 'It harms.'])
})
