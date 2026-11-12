import { expect, it } from 'vitest'
import { auditFixture, envelope, point } from './speed-fix-audit-fixture.js'
import { evidenceParagraph } from '../src/layered/corrections.js'
import { reviewExtraction } from '../src/layered/review.js'

it('A06 跨段分别逐字验收，跳过元数据的拼接引文和一字替换均拒绝', async () => {
  const f = auditFixture('样本为20人。\n\nORCID: 0000-0001。\n\n结果增加20%。')
  const good = point(f.parts[0]!, '样本与结果'); good.evidence.push(point(f.parts[2]!).evidence[0]!)
  f.call.mockImplementation(async (_t, _s, raw) => JSON.stringify(JSON.parse(raw).correction_stage ? { items: [] }
    : envelope([good, { ...good, text: '拼接', evidence: [{ locator: 'L1-L5', quote: '样本为20人。结果增加20%。' }] },
      { ...good, text: '篡字', evidence: [{ locator: 'L5-L5', quote: '结果增加30%。' }] }])))
  const result = await f.run()
  expect(result.segments.flatMap(s => s.points).map(p => p.text)).toEqual(['样本与结果'])
  expect(result.gaps).toHaveLength(2)
})

it('A07 重复引文只有显式唯一定位才能归属，不凭第一个命中猜测', () => {
  const f = auditFixture('重复的研究事实。\n\n中间段落。\n\n重复的研究事实。')
  expect(evidenceParagraph(f.parts, { quote: '重复的研究事实。' })).toBeUndefined()
  expect(evidenceParagraph(f.parts, { quote: '重复的研究事实。', locator: 'L5-L5' })?.paragraph_id).toBe(2)
  expect(evidenceParagraph(f.parts, { paragraph_id: 0, quote: '重复的研究事实。', locator: 'L5-L5' })).toBeUndefined()
})

it('A08 同一长行新增跨度可补证，复制旧跨度不能冒充新增，语义各最多一次', async () => {
  const f = auditFixture('方法A。结果20%。')
  f.call.mockResolvedValue(JSON.stringify(envelope([0, 1].map(i => ({ ...point(f.parts[0]!, '原主张' + i), evidence: [{ locator: 'L1-L1', quote: '方法A。' }] })))))
  const result = await f.run(); f.call.mockClear()
  f.options.topics = { extractionReview: 'all' }
  f.call.mockImplementation(async (_t, _s, raw) => {
    const data = JSON.parse(raw)
    return JSON.stringify({ items: data.review_stage === 'extraction'
      ? data.points.map((p: any) => ({ id: p.id, support: '部分支撑', missing: '结果' }))
      : data.items.map((p: any, i: number) => ({ id: p.id, evidence: i === 0 ? [{ locator: 'L1-L1', quote: '方法A。结果20%。' }] : [{ locator: 'L1-L1', quote: '方法A。' }, { locator: 'L1-L1', quote: '方法A。' }], support: '完整支撑', missing: '' })) })
  })
  expect(await reviewExtraction(result, f.source, f.options, 64000)).toBe(2)
  expect(result.segments[0]!.points.map(p => [p.text, p.verification?.status])).toEqual([['原主张0', 'verified'], ['原主张1', 'unverified']])
  expect(Object.values(result.correction_attempts!).filter(a => a.semantic === 1)).toHaveLength(2)
  expect(await reviewExtraction(result, f.source, f.options, 64000)).toBe(0)
})

it('A09 语义纠正将别项原主张换成新事实必须拒绝该项', async () => {
  const f = auditFixture('治疗组改善20%。对照组改善5%。')
  f.call.mockResolvedValue(JSON.stringify(envelope([{ ...point(f.parts[0]!, '治疗组改善50%。'), evidence: [{ locator: 'L1-L1', quote: '治疗组改善20%。' }] }])))
  const result = await f.run(); f.options.topics = { extractionReview: 'all' }
  f.call.mockImplementation(async (_t, _s, raw) => {
    const data = JSON.parse(raw), id = (data.points ?? data.items)[0].id
    return JSON.stringify({ items: data.review_stage === 'extraction' ? [{ id, support: '不支撑', missing: '原文没有50%' }]
      : [{ id, text: '对照组改善5%。', evidence: [{ locator: 'L1-L1', quote: f.source.text }], support: '完整支撑', missing: '' }] })
  })
  await reviewExtraction(result, f.source, f.options, 64000)
  expect(result.segments[0]!.points[0]!.text).toBe('治疗组改善50%。')
  expect(result.segments[0]!.points[0]!.verification?.status).toBe('unverified')
})

it('A10 提取后核对缺项只纠正该项并记缺口，同批完整项保持已核实', async () => {
  const f = auditFixture('第一事实。\n\n第二事实。'), result = await f.run()
  f.options.topics = { extractionReview: 'all' }
  // 新口径逐项校验：单项缺失只纠正或记录该项缺口，不影响同批正常项。
  f.call.mockClear(); f.call.mockImplementation(async (_t, _s, raw) => {
    const data = JSON.parse(raw)
    return JSON.stringify({ items: data.review_stage === 'extraction' ? [{ id: data.points[0].id, support: '完整支撑', missing: '' }] : [] })
  })
  await reviewExtraction(result, f.source, f.options, 64000)
  const points = result.segments.flatMap(s => s.points)
  expect(points.map(p => p.verification?.status)).toEqual(['verified', 'unverified'])
  expect(points[1]!.verification?.missing).toContain('核对协议缺口')
  const gaps = result.gaps?.filter(g => g.kind === 'unverified_claim')
  expect(gaps).toHaveLength(1)
  expect(gaps![0]!.item).toMatchObject({ point_id: points[1]!.point_id, reason: points[1]!.verification!.missing })
  expect(f.call).toHaveBeenCalledTimes(2)
  const correction = JSON.parse(f.call.mock.calls[1]![2])
  expect(correction.review_stage).toBe('extraction-correction')
  const initial = JSON.parse(f.call.mock.calls[0]![2])
  expect(correction.items.map((p: { id: string }) => p.id)).toEqual([initial.points[1].id])
  expect(initial.points[1]).toMatchObject({ id: 'P2', text: points[1]!.text })
})
