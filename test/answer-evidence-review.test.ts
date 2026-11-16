import { expect, it } from 'vitest'
import { selectAnswerEvidence } from '../src/wiki/answer-evidence.js'
import { evidenceHit } from './answer-evidence-fixture.js'

const first = '编码访谈条件' + '甲'.repeat(331) + '。', second = '编码条件' + '乙'.repeat(211) + '。'
const budgetHits = () => [evidenceHit('sources/S-0001.md', [first]), evidenceHit('sources/S-0002.md', [second])]

it('平均预留失败时回收预算，保留能完整放入的1014字节最高相关事实', () => {
  expect(Buffer.byteLength(first)).toBe(1014)
  expect(Buffer.byteLength(second)).toBe(648)
  const selected = selectAnswerEvidence('编码访谈条件', budgetHits(), 'v000001', { budget: 1019, limit: 2 })
  expect(selected).toHaveLength(1)
  expect(selected[0]).toMatchObject({ path: 'sources/S-0001.md', content: first, truncated: false })
})

it('总预算足够时仍完整保留两页事实', () => {
  const selected = selectAnswerEvidence('编码访谈条件', budgetHits(), 'v000001', { budget: 1662, limit: 2 })
  expect(selected.map(item => item.content)).toEqual([first, second])
  expect(selected.every(item => !item.truncated)).toBe(true)
  expect(selected.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0)).toBe(1662)
})

it('正文引用与当前来源版本不符时整段隔离，不能只去掉来源绑定', () => {
  const hit = evidenceHit('topics/T-0001.md', ['编码条件已确认。[S-0001@sha256:other#L7-L7]'], [{ sourceId: 'S-0001', sourceVersion: 'sha256:current' }])
  expect(selectAnswerEvidence('编码条件', [hit], 'v000001', { budget: 4000, limit: 3 })).toEqual([])
})

it('正文引用版本与当前来源一致时保留事实和来源绑定', () => {
  const hit = evidenceHit('topics/T-0001.md', ['编码条件已确认。[S-0001@sha256:current#L7-L7]'], [{ sourceId: 'S-0001', sourceVersion: 'sha256:current' }])
  const selected = selectAnswerEvidence('编码条件', [hit], 'v000001', { budget: 4000, limit: 3 })
  expect(selected).toHaveLength(1)
  expect(selected[0]!.content).toContain('编码条件已确认。')
  expect(selected[0]!.sources).toEqual([{ sourceId: 'S-0001', sourceVersion: 'sha256:current', path: 'sources/S-0001.md', title: 'S-0001' }])
})
