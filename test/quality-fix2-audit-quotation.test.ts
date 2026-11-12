import { expect, it } from 'vitest'
import { matchQuotation } from '../src/layered/quotation.js'
import { ordinaryPointLimit, granularityTier } from '../src/domain/granularity.js'
import { defaultPolicy } from '../src/domain/policy.js'
import { policySchema } from '../src/domain/policy-schema.js'

it('A01 排版宽容返回原始片段，不改页面待展示引文', () => {
  const original = '“ＡＢ”\r\n**提高** — inter-\nnational'
  expect(matchQuotation(original, '"AB" 提高 - international')?.quote).toBe(original)
})
it('A02 否定词数字小数百分号正负号与单位变化全部拒绝', () => {
  for (const [original, changed] of [['效果不增加。', '效果增加。'], ['尚未改善。', '尚已改善。'], ['无变化。', '有变化。'], ['is not good', 'is good'], ['has no effect', 'has effect'], ['值为12.5%。', '值为125%。'], ['值为12.5%。', '值为12.5。'], ['值为+5 mg。', '值为-5 mg。'], ['值为5 mg。', '值为5 g。']]) expect.soft(matchQuotation(original!, changed!), original).toBeUndefined()
})
it('A03 科学单位上标不是排版：m²不能等同m2', () => {
  expect(matchQuotation('面积为5 m²。', '面积为5 m2。')).toBeUndefined()
})
it('A04 普通论文短文按档位上限，自定义仍按用户填值', () => {
  // 新规则统一为档位上限乘篇幅倍数；不足25000字的倍数为1，旧短文降额不再适用。
  expect([ordinaryPointLimit(19999, 100), ordinaryPointLimit(20000, 100), ordinaryPointLimit(19999, 50), ordinaryPointLimit(20000, 50), ordinaryPointLimit(1, 100), ordinaryPointLimit(1, 100, 'custom')]).toEqual([100, 100, 50, 50, 100, 100])
})
it('A05 自定义1和500可用，0/501/小数/非有限值拒绝，七个档位名各自对应', () => {
  for (const value of [1, 500]) expect(policySchema.parse({ ...defaultPolicy(), customPointLimit: value }).customPointLimit).toBe(value)
  for (const value of [0, 501, 1.5, NaN, Infinity]) expect(policySchema.safeParse({ ...defaultPolicy(), customPointLimit: value }).success).toBe(false)
  for (const [old, name, value] of [['minimal', 'minimal', 5], ['coarse', 'coarse', 10], ['balanced', 'balanced', 25], ['standard', 'standard', 50], ['detailed', 'detailed', 75], ['fine', 'fine', 100], ['custom', 'custom', 37]] as const) expect(granularityTier({ ...defaultPolicy(), extractionGranularity: old, customEntityLimit: 17, customConceptLimit: 20 })).toMatchObject({ name, value })
})
