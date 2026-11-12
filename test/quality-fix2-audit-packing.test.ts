import { afterEach, expect, it, vi } from 'vitest'
import { cleanupLayeredFixtures } from './layered-fixture.js'
import { extractionFixture, output, processing } from './quality-fix2-audit-fixture.js'
import { planExtraction } from '../src/layered/extraction.js'
import { layeredSettings } from '../src/domain/config.js'
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
const article = '# 方法\n\n' + '样本采用随机分组。'.repeat(110) + '\n\n# 结果\n\n' + '实验结果改善。'.repeat(110) + '\n\n# 局限\n\n短章局限。'
it('A06 50%和25%等于阈值不切，超过阈值切2至4包', async () => {
  const f = await extractionFixture(article, { sourcePackRatio: 0 }); await f.run()
  const args = f.call.mock.calls[0]!, bytes = Buffer.byteLength(args[1] + args[2])
  for (const ratio of [0.5, 0.25]) {
    const settings = layeredSettings({ sourcePackRatio: ratio }, 50)
    expect(planExtraction('S-0001', f.source, processing, bytes / ratio, settings)).toHaveLength(1)
    const packed = planExtraction('S-0001', f.source, processing, bytes / ratio - 1, settings)
    expect(packed.length).toBeGreaterThanOrEqual(2); expect(packed.length).toBeLessThanOrEqual(4)
  }
})
it('A07 短章随相邻包，分包并发且未丢任何段落', async () => {
  const f = await extractionFixture(article, { sourcePackRatio: 0.25 }); f.policy.pageGenerationConcurrency = 4
  let active = 0, peak = 0
  f.call.mockImplementation(async (_t, _s, raw) => { active++; peak = Math.max(peak, active); await Promise.resolve(); const result = output(JSON.parse(raw)); active--; return JSON.stringify(result) })
  const plan = planExtraction('S-0001', f.source, processing, 18000, layeredSettings(f.options.topics || {}))
  expect(plan.length).toBeGreaterThan(1)
  const tail = plan.find(p => p.some(s => s.text === '短章局限。'))!
  expect(tail.some(p => p.text.includes('实验结果改善'))).toBe(true)
  await f.run(undefined, 18000); expect(peak).toBeGreaterThan(1)
  expect(plan.flat().map(p => p.text).join('')).toBe(f.source.segments.map(s => f.source.text.slice(s.start, s.end)).join(''))
})
it('A08 单章超长切片完整且粗放极简普通文章保持整篇', async () => {
  const f = await extractionFixture('# 长章\n\n' + '随机样本123。'.repeat(1000))
  const plan = planExtraction('S-0001', f.source, processing, 11000)
  expect(plan.length).toBeGreaterThan(1)
  expect(plan.flat().map(p => p.text).join('')).toBe(f.source.segments.map(s => f.source.text.slice(s.start, s.end)).join(''))
  for (const tier of [5, 10]) expect(planExtraction('S-0001', f.source, { ...processing, tier }, 100000, layeredSettings({}, tier))).toHaveLength(1)
})
it('A09 只去图片base64，普通图片链接与非图片data及表格代码完整保留', async () => {
  const text = '# 资料\n\n![图片](data:image/png;base64,YWJj)\n\n![外链](plot.png)\n\n[data](data:text/plain;base64,YWJj)\n\n|值|单位|\n|-|-|\n|5|mg|\n\n```txt\n原样代码\n```'
  const f = await extractionFixture(text)
  const body = planExtraction('S-0001', f.source, processing, 100000).flat().map(p => p.text).join('\n\n')
  expect(body).not.toContain('data:image/png;base64'); for (const original of ['![外链](plot.png)', '[data](data:text/plain;base64,YWJj)', '|5|mg|', '```txt\n原样代码\n```']) expect(body).toContain(original)
})
it('A10 微短多章节超过阈值也必须至少2包', async () => {
  const f = await extractionFixture('# 一\n\n甲。\n\n# 二\n\n乙。', { sourcePackRatio: 0 }); await f.run()
  const args = f.call.mock.calls[0]!, bytes = Buffer.byteLength(args[1] + args[2])
  const plan = planExtraction('S-0001', f.source, processing, bytes * 2 - 1, layeredSettings())
  expect(plan.length).toBeGreaterThanOrEqual(2)
})
