import { expect, it } from 'vitest'
import { hash } from '../src/layered/files.js'
import { reviewExtraction } from '../src/layered/review.js'
import { reviewFixture } from './quality-fix2-audit-fixture.js'

it.each([
  ['否定', '甲组没有参与研究。', '甲组参与研究。'],
  ['数量', '甲研究纳入30人。', '甲研究纳入31人。'],
  ['条件', '仅在干预组中结果提高。', '结果提高。'],
  ['研究归属', '甲研究由护士实施访谈。', '乙研究由护士实施访谈。'],
  ['强度', '该结果可能适用于该样本。', '该结果必然适用于该样本。'],
] as const)('语义纠正不能改变%s后获得完整支撑', async (_name, original, changed) => {
  const f = reviewFixture(), p = f.extraction.segments[0]!.points[0]!
  f.source.text = f.source.text.replace('结果提高。', original).replace('后一', '补充原文。')
  f.source.contentHash = f.extraction.source_hash = hash(f.source.text)
  f.source.segments[0]!.end = f.source.text.length
  p.text = original; p.text_hash = hash(original); p.evidence[0]!.quote = original
  const before = structuredClone({ text: p.text, evidence: p.evidence })
  f.call.mockImplementation(async (_task, _system, raw) => {
    const data = JSON.parse(raw)
    return JSON.stringify(data.review_stage === 'extraction'
      ? { items: [{ id: 'P1', support: '部分支撑', missing: '需补充邻文' }] }
      : { items: [{ id: 'P1', text: changed, support: '完整支撑', missing: null,
        evidence: [...data.items[0].validationFeedback.item.evidence, { locator: 'L5-L5', quote: '补充原文。' }] }] })
  })
  expect(await reviewExtraction(f.extraction, f.source, f.options, 100000)).toBe(2)
  expect(p.verification).toMatchObject({ status: 'unverified', missing: '纠正改变主张，已拒收。' })
  expect({ text: p.text, evidence: p.evidence }).toEqual(before)
  expect(f.extraction.gaps).toMatchObject([{ kind: 'unverified_claim' }])
})
