import { expect, it } from 'vitest'
import { reviewExtraction, reviewNeedsRetry } from '../src/layered/review.js'
import type { Point } from '../src/layered/schema.js'
import { reviewFixture } from './quality-fix2-audit-fixture.js'

it.each([
  ['错来源', (p: Point) => { p.evidence[0]!.source_id = 'S-0002' }],
  ['旧引文版本', (p: Point) => { p.evidence[0]!.source_version = '旧版本' }],
  ['旧要点版本', (p: Point) => { p.source_version = '旧版本' }],
  ['错定位', (p: Point) => { p.evidence[0]!.locator = 'L1-L1' }],
  ['非逐字引文', (p: Point) => { p.evidence[0]!.quote = '结果没有提高。' }],
] as const)('%s不能被模型的完整支撑洗成已核实，保留原主张和引文', async (_name, change) => {
  const f = reviewFixture(), p = f.extraction.segments[0]!.points[0]!
  change(p)
  f.extraction.correction_batches = { semantic: 2 }
  const original = { text: p.text, section: p.section, evidence: structuredClone(p.evidence) }
  expect(await reviewExtraction(f.extraction, f.source, f.options, 100000)).toBe(0)
  expect(f.call).not.toHaveBeenCalled()
  expect(p.verification).toMatchObject({ status: 'unverified', missing: expect.stringContaining('核对证据无效：') })
  expect({ text: p.text, section: p.section, evidence: p.evidence }).toEqual(original)
  expect(f.extraction.gaps).toMatchObject([{ kind: 'unverified_claim', item: { point_id: p.point_id } }])
  expect(reviewNeedsRetry(f.extraction), '证据校验未完成不受语义纠正额度影响').toBe(true)
})
