import { afterEach, expect, it, vi } from 'vitest'
import { cleanupLayeredFixtures } from './layered-fixture.js'
import { extractionFixture, output } from './quality-fix2-audit-fixture.js'
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
it('A21 零点章只送该章补一次，仍零点留缺口，参考致谢资助免补', async () => {
  const f = await extractionFixture('# 方法\n\n样本随机。\n\n# 结果\n\n结果改善。\n\n# 参考文献\n\n某文献。\n\n# 致谢\n\n感谢团队。\n\n# 资助声明\n\n资金支持。')
  f.call.mockImplementation(async (_t, _s, raw) => { const input = JSON.parse(raw), value = output(input); if (input.coverage) value.points = []; else value.points = value.points.filter((p: any) => p.text === '样本随机。'); return JSON.stringify(value) })
  const result = await f.run(), calls = f.call.mock.calls.map(c => JSON.parse(c[2])), supplements = calls.filter(c => c.coverage)
  expect(supplements).toHaveLength(1); expect(supplements[0].paragraphs.map((p: any) => p.text)).toEqual(['# 结果', '结果改善。'])
  expect(result.gaps?.some(g => g.reasons.some(r => r.rule === 'chapter-coverage'))).toBe(true)
})
it('A22 长章补提请求提供已有要点，防止只靠一句提示重复提取', async () => {
  const f = await extractionFixture('# 结果\n\n结果提高。结果降低。', { sourceChapterMinPoints: 2 })
  f.call.mockImplementation(async (_t, _s, raw) => { const input = JSON.parse(raw), value = output(input); value.points = [{ ...value.points[0], text: '结果提高。', evidence: [{ locator: input.paragraphs.at(-1).locator, quote: '结果提高。' }] }]; return JSON.stringify(value) })
  const result = await f.run()
  const claims = result.segments.flatMap(s => s.points).map(p => p.text)
  expect.soft(new Set(claims).size).toBe(claims.length)
  const supplement = f.call.mock.calls.find(c => JSON.parse(c[2]).coverage)!
  const request = JSON.parse(supplement[2]); delete request.paragraphs; delete request.evidence_dictionary
  expect(JSON.stringify(request)).toContain('结果提高。')
})
it('A23 模型超额背景在前，硬截断应保留结果再方法并留下截断记录', async () => {
  const f = await extractionFixture('背景依据。方法依据。结果依据。', { sourceChapterMinPoints: 0 }, 2)
  f.options.granularity = 'custom'
  f.call.mockImplementation(async (_t, _s, raw) => { const input = JSON.parse(raw), p = input.paragraphs[0]; return JSON.stringify({ ...output(input), points: ['对象与条件', '方法', '主要发现'].map((section, i) => ({ paragraph_id: p.paragraph_id, text: ['背景依据。', '方法依据。', '结果依据。'][i], section, evidence: [{ locator: p.locator, quote: p.text }] })) }) })
  const result = await f.run()
  expect(result.segments.flatMap(s => s.points).map(p => p.section).sort()).toEqual(['主要发现', '方法'].sort())
  expect(result.truncations?.reduce((n, t) => n + t.count, 0)).toBeGreaterThan(0)
})
it('A24 五档上限选择性实际注入，单项覆盖优先', async () => {
  const f = await extractionFixture('有实质的资料正文。', { sourceChapterMinPoints: 0 })
  const { extractSource } = await import('../src/layered/extraction.js')
  const { granularityTier } = await import('../src/domain/granularity.js')
  const { defaultPolicy } = await import('../src/domain/policy.js')
  const { layeredSettings } = await import('../src/domain/config.js')
  for (const name of ['fine', 'standard', 'coarse', 'minimal', 'custom'] as const) {
    const tier = granularityTier({ ...defaultPolicy(), extractionGranularity: name, customPointLimit: 17 }); f.call.mockClear()
    await extractSource(f.root, name, f.source, { tier: tier.value, granularity: name, model: 'mock', prompt_version: 'audit' }, { ...f.options, tier: tier.value, granularity: name }, 100000)
    // 单包配额沿用扩额前规则：精细、标准短文降额；篇级扩额只放宽截断阈值，不加大单次输出。
    const input = JSON.parse(f.call.mock.calls[0]![2]); expect(input.selectivity).toBe(tier.selectivity); expect(input.point_limit).toBe(name === 'fine' || name === 'standard' ? 5 : tier.value)
    expect(layeredSettings({ extractionReview: 'off', sourcePackRatio: 0 }, tier.value)).toMatchObject({ extractionReview: 'off', sourcePackRatio: 0 })
  }
})
it('A25 核对未核实点来源页标注且不进入主题', async () => {
  const { buildLayeredLibrary, readLayeredPage } = await import('../src/layered/index.js')
  const { snapshotManifest } = await import('./layered-fixture.js')
  const f = await extractionFixture('证据没有支撑夸大结论。', { topicMergeMinSources: 1 })
  f.options.embeddingClient = { embed: async texts => texts.map(() => [1, 0]) }
  f.call.mockImplementation(async (_t, _s, raw) => { const input = JSON.parse(raw); if (input.review_stage === 'extraction') return JSON.stringify({ items: input.points.map((p: any) => ({ id: p.id, support: '不支撑', missing: '夸大' })) }); if (input.review_stage === 'extraction-correction') return JSON.stringify({ ...input.validationFeedback.item, support: '不支撑', missing: '夸大' }); return JSON.stringify(output(input)) })
  await buildLayeredLibrary(f.options)
  expect(await readLayeredPage(f.knowledgeRoot, 'sources/S-0001.md')).toContain('未核实')
  expect((await snapshotManifest(f.root)).topics?.topics ?? []).toHaveLength(0)
})
