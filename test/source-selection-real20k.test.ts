import { existsSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { ordinaryPointLimit } from '../src/domain/granularity.js'
import { selectSourcePoints } from '../src/layered/extraction.js'
import type { Point } from '../src/layered/schema.js'

const hasFixture = existsSync(new URL('./fixtures/real20k/source-selection.json', import.meta.url))
const cases = (hasFixture ? JSON.parse(readFileSync(new URL('./fixtures/real20k/source-selection.json', import.meta.url), 'utf8')) : [{"id": "S-0012", "question": "S-0012"}, {"id": "S-0014", "question": "S-0014"}, {"id": "S-0019", "question": "S-0019"}, {"id": "S-0001", "question": "S-0001"}, {"id": "S-0003", "question": "S-0003"}, {"id": "S-0017", "question": "S-0017"}]) as {
  id: string; question: string; chars: number; source: string; points: Point[]; chapters: { ids: string[]; minimum: number }[]
}[]
const facts: Record<string, string[]> = {
  'C-027': ['虚构档案条件e0c20a5f29', '虚构档案条件42daf24271'],
  'C-029': ['虚构档案条件c021ecbd78', '虚构档案条件690ef7c1ac', '虚构档案条件baa022411a'],
  'C-036': ['虚构档案条件4e2993b1d9', '虚构档案条件90942853ea'],
  'C-001': ['虚构档案条件e114cf8dcb', '虚构档案条件529e43a229', '虚构档案条件a816dc086d'],
  'C-002': ['虚构档案条件a714e6aa0a', '虚构档案条件8ee7aa6fde'],
  'C-038': ['虚构档案条件70492d02e3', '虚构档案条件821120ed28'],
}
it.skipIf(!hasFixture).each(cases)('$question 首提事实经扩额选点保留，关键引文仍逐字成立（夹具含第三方论文原文，未随公开仓库发布）', fixture => {
  const limit = ordinaryPointLimit(fixture.chars, 100, 'fine')
  const selected = selectSourcePoints(fixture.points, limit, fixture.chapters.map(chapter => ({ ...chapter, ids: new Set(chapter.ids) })))
  const kept = fixture.points.filter(point => selected.has(point.point_id))
  expect(kept.length).toBeLessThanOrEqual(limit)
  for (const fact of facts[fixture.question]!) {
    const point = kept.find(point => point.text.includes(fact))
    expect(point, fact).toBeDefined()
    for (const evidence of point!.evidence) expect(fixture.source).toContain(evidence.quote)
  }
})

it('六个数值档都按每25000字扩额至四倍，自定义按原值', () => {
  expect([1, 25000, 25001, 50000, 75001, 200000].map(chars => ordinaryPointLimit(chars, 100, 'fine'))).toEqual([100, 100, 200, 200, 400, 400])
  expect([1, 25001, 50001, 100001].map(chars => ordinaryPointLimit(chars, 50, 'standard'))).toEqual([50, 100, 150, 200])
  // 用户 2026-11-11 定：各档都按篇幅扩额，只放宽篇级截断；自定义按用户填值。
  expect([1, 25001, 100001].map(chars => ordinaryPointLimit(chars, 75, 'detailed'))).toEqual([75, 150, 300])
  expect([1, 25001, 100001].map(chars => ordinaryPointLimit(chars, 25, 'balanced'))).toEqual([25, 50, 100])
  expect([ordinaryPointLimit(100001, 10, 'coarse'), ordinaryPointLimit(100001, 5, 'minimal'), ordinaryPointLimit(100001, 137, 'custom')]).toEqual([40, 20, 137])
})

it('超额先去同证据近重复，再按事实类别保留且守章节底线，不合并不同数值条件', () => {
  const point = (id: string, text: string, section: Point['section'], quote = text): Point => ({ point_id: id, text, section, text_hash: 'hash', locator: 'L1-L1', source_version: 'v1', evidence: [{ source_id: 'S-0001', source_version: 'v1', locator: 'L1-L1', quote }] })
  const points = [
    point('背景', '背景资料。', '证据位置'), point('结果', '研究显示，结果成立。', '主要发现', '结果成立。'),
    point('重复', '研究结果表明，结果成立。', '主要发现', '结果成立。'), point('限制', '仅限本地。', '限制'),
    point('方法', '主题编码。', '方法'), point('样本', '样本12人。', '对象与条件'),
    point('异数值', '样本13人。', '对象与条件'),
  ]
  expect([...selectSourcePoints(points, 6, [])]).toEqual(['结果', '方法', '样本', '异数值', '限制', '背景'])
  expect([...selectSourcePoints(points, 3, [{ ids: new Set(['背景']), minimum: 1 }])]).toEqual(['背景', '结果', '方法'])
  expect(points[1]!.text).toBe('研究显示，结果成立。')
})
