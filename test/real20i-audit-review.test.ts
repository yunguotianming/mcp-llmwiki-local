import { expect, it } from 'vitest'
import { reviewExtraction } from '../src/layered/review.js'
import { point, reviewFixture } from './quality-fix2-audit-fixture.js'

const good = (id: string) => ({ id, support: '完整支撑', missing: null })
const cases = [
  ['错 ID', [good('P1'), good('错号')], ['P2']],
  ['重复 ID', [good('P1'), good('P2'), good('P2')], ['P2']],
  ['漏项', [good('P1')], ['P2']],
  ['多出项', [good('P1'), good('P2'), good('额外项')], []],
  ['字段非法', [good('P1'), { id: 'P2', support: 7, missing: null }], ['P2']],
] as const

it.each(cases)('R-%s：只纠正问题项，正常项保持已核实', async (_name, items, repaired) => {
  const f = reviewFixture([point(), point('结果提高。', '方法', 'P2')])
  const claims = f.extraction.segments[0]!.points.map(p => [p.point_id, p.text, p.section])
  f.call.mockImplementation(async (_task, _system, raw) => {
    const input = JSON.parse(raw)
    if (input.review_stage === 'extraction') return JSON.stringify({ items })
    expect(input.items.map((p: any) => p.id)).toEqual(repaired)
    return JSON.stringify({ items: input.items.map((p: any) => ({ ...good(p.id), evidence: p.validationFeedback.item.evidence })) })
  })
  await reviewExtraction(f.extraction, f.source, f.options, 100000)
  expect(f.call).toHaveBeenCalledTimes(repaired.length ? 2 : 1)
  expect(f.extraction.segments[0]!.points.map(p => p.verification?.status)).toEqual(['verified', 'verified'])
  expect(f.extraction.segments[0]!.points.map(p => [p.point_id, p.text, p.section])).toEqual(claims)
  expect(f.extraction.gaps).toEqual([])
})
