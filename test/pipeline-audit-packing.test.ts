import { mockSupportReview } from './layered-fixture.js'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { extractSource, groupingFingerprint, planExtraction } from '../src/layered/extraction.js'
import { readLocalSource } from '../src/layered/snapshot.js'
import { sourceQuotas } from '../src/layered/longdoc.js'
import { layeredSettings } from '../src/domain/config.js'
import { cleanupLayeredFixtures, layeredFixture } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
const processing = { tier: 50 as const, prompt_version: '审查', model: 'mock/extractor' }
async function fixture(text: string) {
  const f = await layeredFixture(), file = path.join(f.knowledgeRoot, 'book.md')
  await writeFile(file, text)
  return { ...f, source: await readLocalSource(file, '审查资料') }
}
function preserve(f: Awaited<ReturnType<typeof fixture>>, plan: ReturnType<typeof planExtraction>) {
  expect(plan.flat().map(part => part.text).join('')).toBe(f.source.segments.map(part => f.source.text.slice(part.start, part.end)).join(''))
  const ids = plan.flat().map(part => part.paragraph_id)
  expect(ids).toEqual([...ids].sort((a, b) => a - b))
}

it('P01 输入恰好上限及上限减一整篇，超过上限一字节才切分', async () => {
  const f = await fixture('# 论文\n\n正文证据。' + 'x'.repeat(5000) + '\n\n## 结论\n\n结论成立。')
  let bytes = 0
  const original = f.call.getMockImplementation()
  f.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
    if (!JSON.parse(args[2]).coverage) bytes = Buffer.byteLength(args[1] + args[2])
    return original ? original(...args) : Reflect.apply(Object.getPrototypeOf(f.client).call, f.client, args)
  })
  // 关闭主动分包，保留本用例精确输入边界；默认分包另验。
  f.options.topics = { sourcePackRatio: 0 }
  const settings = layeredSettings({ sourcePackRatio: 0 })
  await extractSource(f.root, 'S-0001', f.source, processing, f.options, 50000)
  expect(planExtraction('S-0001', f.source, processing, bytes, settings)).toHaveLength(1)
  expect(planExtraction('S-0001', f.source, processing, bytes + 1, settings)).toHaveLength(1)
  const split = planExtraction('S-0001', f.source, processing, bytes - 1, settings)
  expect(split.length).toBeGreaterThan(1); preserve(f, split)
})

it('P02 单章单段超过上限再次切分，Unicode及全部正文保持', async () => {
  const f = await fixture('# 唯一章节\n\n' + '超长证据😀'.repeat(900))
  const plan = planExtraction('S-0001', f.source, processing, 6000)
  expect(plan.length).toBeGreaterThan(1); preserve(f, plan)
  expect(plan.every(parts => parts.some(part => !part.text.startsWith('#')))).toBe(true)
})

it('P03 大量短章相邻打包，章节归属与原文顺序保持', async () => {
  const f = await fixture('# 全书\n\n' + Array.from({ length: 35 }, (_, i) => `## 第${i}章\n\n第${i}条证据，完整保留。\n\n`).join(''))
  const plan = planExtraction('S-0001', f.source, processing, 6500)
  expect(plan.length).toBeGreaterThan(1); expect(plan.length).toBeLessThan(15); preserve(f, plan)
  const allocation = sourceQuotas(f.source, plan, 50, layeredSettings())
  for (const part of plan.flat().filter(part => !part.text.startsWith('#'))) expect(allocation.chapters.filter(chapter => chapter.paragraph_ids.includes(part.paragraph_id))).toHaveLength(1)
  for (const group of plan.slice(0, -1)) expect(group.filter(part => !part.text.startsWith('#')).length).toBeGreaterThan(1)
})

it('P04 无章节标题的长文也切分且不丢内容', async () => {
  const f = await fixture(Array.from({ length: 20 }, (_, i) => `第${i}段。${'正文'.repeat(80)}`).join('\n\n'))
  const plan = planExtraction('S-0001', f.source, processing, 6000)
  expect(plan.length).toBeGreaterThan(1); preserve(f, plan)
  expect(sourceQuotas(f.source, plan, 50, layeredSettings()).chapters).toEqual([])
})

it('P05 只移除图片base64，附件base64及图片前后正文保留', async () => {
  const f = await fixture('# 单章\n\n前文证据。\n\n![图](data:image/png;base64,' + 'A'.repeat(15000) + ')\n\n后文证据。\n\n[附件](data:application/pdf;base64,JVBERi0xLjQ=)')
  const plan = planExtraction('S-0001', f.source, processing, 8000), input = plan.flat().map(part => part.text).join('')
  expect(plan).toHaveLength(1)
  expect(input).not.toContain('data:image'); expect(input).not.toContain('A'.repeat(100))
  expect(input).toContain('前文证据。'); expect(input).toContain('后文证据。')
  expect(input).toContain('data:application/pdf;base64,JVBERi0xLjQ=')
  expect(groupingFingerprint(plan)).toBe(groupingFingerprint(planExtraction('S-0001', f.source, processing, 9000)))
})
