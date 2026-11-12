import { expect, it } from 'vitest'
import { reviewExtraction } from '../src/layered/review.js'
import { point, reviewFixture } from './quality-fix2-audit-fixture.js'

it('R6：纠正响应单项坏字段不污染同批好项，改主张及非逐字引文拒收', async () => {
  const f = reviewFixture(['P1', 'P2', 'P3', 'P4'].map(id => point('结果提高。', '主要发现', id)))
  f.call.mockImplementation(async (_task, _system, raw) => {
    const d = JSON.parse(raw)
    if (d.review_stage === 'extraction') return '{"items":[]}'
    return JSON.stringify({ items: d.items.map((p: any, i: number) => ({ id: p.id, support: i === 1 ? 9 : '完整支撑', missing: null,
      ...(i === 2 ? { text: '结果降低。' } : {}), evidence: i === 3 ? [{ locator: 'L4-L4', quote: '结果 提高。' }] : p.validationFeedback.item.evidence })) })
  })
  await reviewExtraction(f.extraction, f.source, f.options, 100000)
  expect(f.extraction.segments[0]!.points.map(p => p.verification?.status)).toEqual(['verified', 'unverified', 'unverified', 'unverified'])
  expect(f.extraction.segments[0]!.points.map(p => p.text)).toEqual(Array(4).fill('结果提高。'))
})

it('R7：篇级纠正额度耗尽后续做不重发，另一篇仍有额度', async () => {
  const a = reviewFixture(), b = reviewFixture()
  a.extraction.correction_batches = { semantic: 2 }
  for (const f of [a, b]) f.call.mockImplementation(async (_task, _system, raw) => {
    const d = JSON.parse(raw)
    return JSON.stringify({ items: d.review_stage === 'extraction' ? [] : d.items.map((p: any) => ({ id: p.id, support: '完整支撑', missing: null, evidence: p.validationFeedback.item.evidence })) })
  })
  await reviewExtraction(a.extraction, a.source, a.options, 100000)
  await reviewExtraction(a.extraction, a.source, a.options, 100000)
  await reviewExtraction(b.extraction, b.source, b.options, 100000)
  expect(a.call).toHaveBeenCalledTimes(1)
  expect(b.call).toHaveBeenCalledTimes(2)
  expect(b.extraction.segments[0]!.points[0]!.verification?.status).toBe('verified')
})

it('R8：核对传输失败后续做应重试失败核对，不把未核实永久缓存', async () => {
  const f = reviewFixture()
  f.call.mockRejectedValueOnce(new Error('临时网络失败'))
  await reviewExtraction(f.extraction, f.source, f.options, 100000)
  expect(f.extraction.gaps).toHaveLength(1)
  await reviewExtraction(f.extraction, f.source, f.options, 100000)
  expect(f.call).toHaveBeenCalledTimes(2)
  expect(f.extraction.segments[0]!.points[0]!.verification?.status).toBe('verified')
})
