import { expect, it } from 'vitest'
import { reviewExtraction } from '../src/layered/review.js'
import { point, reviewFixture } from './quality-fix2-audit-fixture.js'

it('A11 标准仅结果方法，一次含全部选点且上下各两行，精细全选低档关闭', async () => {
  for (const tier of [50, 100, 10, 5]) {
    const f = reviewFixture([point(), point('方法', '方法', 'P2'), point('背景', '对象与条件', 'P3')]); f.options.tier = tier
    await reviewExtraction(f.extraction, f.source, f.options, 100000)
    expect(f.call).toHaveBeenCalledTimes(tier >= 50 ? 1 : 0)
    if (tier < 50) continue
    const input = JSON.parse(f.call.mock.calls[0]![2])
    expect(input.points).toHaveLength(tier === 50 ? 2 : 3)
    expect(input.contexts[input.points[0].evidence[0].context_ref].text).toBe('前二\n前一\n结果提高。\n后一\n后二')
  }
})
it('A12 纠正偷改主张拒绝且同项至多一次纠正', async () => {
  const f = reviewFixture()
  f.call.mockImplementation(async (_t, _s, raw) => {
    const input = JSON.parse(raw)
    return JSON.stringify(input.review_stage === 'extraction' ? { items: [{ id: 'P1', support: '部分支撑', missing: '缺对象' }] } : { ...input.validationFeedback.item, text: '改写主张', support: '完整支撑', missing: '' })
  })
  await reviewExtraction(f.extraction, f.source, f.options, 100000)
  await reviewExtraction(f.extraction, f.source, f.options, 100000)
  expect(f.call).toHaveBeenCalledTimes(2)
  expect(f.extraction.segments[0]!.points[0]).toMatchObject({ text: '结果提高。', verification: { status: 'unverified' } })
})
it('A13 已核实且主张引文不变再次调用为零，变化项单独核对', async () => {
  const f = reviewFixture([point(), point('另一主张', '方法', 'P2')])
  await reviewExtraction(f.extraction, f.source, f.options, 100000); f.call.mockClear()
  await reviewExtraction(f.extraction, f.source, f.options, 100000); expect(f.call).not.toHaveBeenCalled()
  f.extraction.segments[0]!.points[1]!.text = '变化主张'
  await reviewExtraction(f.extraction, f.source, f.options, 100000)
  expect(JSON.parse(f.call.mock.calls[0]![2]).points.map((p: any) => p.id)).toEqual(['P2'])
})
it('A14 单来源核对异常不中止但必须登记缺口', async () => {
  const f = reviewFixture(); f.call.mockRejectedValue(new Error('模拟服务失败'))
  await expect(reviewExtraction(f.extraction, f.source, f.options, 100000)).resolves.toBe(1)
  expect(f.extraction.segments[0]!.points[0]!.verification?.status).toBe('unverified')
  expect(f.extraction.gaps?.length ?? 0).toBeGreaterThan(0)
  expect(f.extraction.gaps).toEqual([expect.objectContaining({ kind: 'unverified_claim',
    item: { source_id: 'S-0001', point_id: 'P1', reason: expect.stringContaining('模拟服务失败') },
    reasons: [expect.objectContaining({ rule: 'semantic-support', actual: expect.stringContaining('模拟服务失败') })] })])
  await expect(reviewExtraction(f.extraction, f.source, f.options, 100000)).resolves.toBe(1)
  await expect(reviewExtraction(f.extraction, f.source, f.options, 100000)).resolves.toBe(0)
  expect(f.extraction.gaps).toHaveLength(1)
})
it('A15 引文未变仅重排或扩充为相同内容不能自称纠正成功', async () => {
  const f = reviewFixture()
  f.call.mockImplementation(async (_t, _s, raw) => {
    const input = JSON.parse(raw)
    if (input.review_stage === 'extraction') return JSON.stringify({ items: [{ id: 'P1', support: '不支撑', missing: '缺样本数' }] })
    const original = input.validationFeedback.item
    return JSON.stringify({ ...original, evidence: [...original.evidence, ...original.evidence], support: '完整支撑', missing: '' })
  })
  await reviewExtraction(f.extraction, f.source, f.options, 100000)
  expect(f.extraction.segments[0]!.points[0]!.verification?.status).toBe('unverified')
})
