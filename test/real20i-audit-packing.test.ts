import { expect, it, vi } from 'vitest'
import { layeredSettings } from '../src/domain/config.js'
import { planExtraction, renderSource } from '../src/layered/extraction.js'
import { sourceChapters, sourceQuotas } from '../src/layered/longdoc.js'
import { chapterBlockId } from '../src/layered/anchors.js'
import { auditFixture, envelope, makeSource } from './speed-fix-audit-fixture.js'
import type { SourceEntry } from '../src/layered/schema.js'

// 本文件只测分包与渲染；持久化由发布反例覆盖，内存根不写入工作区。
vi.mock('../src/layered/files.js', async original => ({
  ...await original<typeof import('../src/layered/files.js')>(), writeJson: async () => {}, appendLog: async () => {},
}))

it('B1：预算切包后30/3/1路逐字节一致，段落顺序证据完整且要点不重复', async () => {
  const text = Array.from({ length: 4 }, (_, c) => '# 章' + c + '\n\n' + Array.from({ length: 3 }, (_, p) => `第${c}章第${p}项结果。`.repeat(120)).join('\n\n')).join('\n\n')
  const products: string[] = []
  for (const cap of [30, 3, 1]) {
    const f = auditFixture(text)
    f.options.client.concurrency = () => cap
    f.options.topics = { sourceChapterMinPoints: 0 }
    const settings = layeredSettings(f.options.topics, 50), plan = planExtraction('S-audit', f.source, f.processing, 18000, settings)
    expect(plan.length).toBeGreaterThan(1)
    const ids = plan.flat().map(p => p.paragraph_id)
    expect(ids).toEqual([...ids].sort((a, b) => a - b))
    for (const [id, segment] of f.source.segments.entries()) expect(plan.flat().filter(p => p.paragraph_id === id).map(p => p.text).join('')).toBe(f.source.text.slice(segment.start, segment.end))
    const quotas = sourceQuotas(f.source, plan, 50, settings)
    expect(quotas.quotas.reduce((a, b) => a + b, 0)).toBe(quotas.limit)
    f.call.mockImplementation(async (_task, _system, raw) => {
      const d = JSON.parse(raw)
      // 固定逆序延后首包，验证合并顺序不受调度影响。
      for (let i = 0; i < (d.paragraphs?.[0]?.paragraph_id === 0 ? 4 : 1); i++) await Promise.resolve()
      if (d.review_stage) return JSON.stringify({ items: d.points.map((p: any) => ({ id: p.id, support: '完整支撑', missing: null })) })
      if (d.summary_id) return JSON.stringify({ point_ids: d.children.flatMap((c: any) => c.points.map((p: any) => p.point_id)).slice(0, d.point_limit) })
      return JSON.stringify(envelope(d.paragraphs.filter((p: any) => !p.text.startsWith('#')).map((p: any) => ({ paragraph_id: p.paragraph_id, text: p.text.slice(0, 10), section: '主要发现', evidence: [{ locator: p.locator, quote: p.text }] }))))
    })
    const result = await f.run(undefined, plan, 18000), points = result.segments.flatMap(s => s.points)
    expect(points).toHaveLength(12)
    expect(new Set(points.map(p => p.point_id)).size).toBe(12)
    expect(points.every(p => p.evidence.length && p.evidence.every(e => f.source.text.includes(e.quote)))).toBe(true)
    const entry = { source_id: 'S-audit', metadata: f.source.metadata, current_path: 'a.md', updated_at: '2026-11-10T00:00:00Z', source_version: f.source.contentHash, files: { assets: [] } } as unknown as SourceEntry
    products.push(JSON.stringify(result) + '\n' + renderSource(entry, result))
  }
  expect(products[0]).toBe(products[1]); expect(products[1]).toBe(products[2])
})

it('B2：单章单段超限按字符无损切片，Unicode与行号证据不丢失', () => {
  const source = makeSource('# 超长章\n\n' + '结果😀甲乙丙丁。\n'.repeat(1600))
  const settings = layeredSettings({ sourceChapterMinPoints: 0 }, 100)
  const plan = planExtraction('S-0001', source, { tier: 100, granularity: 'fine', model: 'mock', prompt_version: 'audit' }, 18000, settings)
  expect(plan.length).toBeGreaterThan(1)
  for (const [id, segment] of source.segments.entries()) expect(plan.flat().filter(p => p.paragraph_id === id).map(p => p.text).join('')).toBe(source.text.slice(segment.start, segment.end))
  const lines = source.text.split('\n')
  for (const p of plan.flat()) {
    const range = /^L(\d+)-L(\d+)$/.exec(p.locator)!
    expect(lines.slice(Number(range[1]) - 1, Number(range[2])).join('\n')).toContain(p.text)
    expect(p.text).not.toContain('\uFFFD')
  }
})

it('B3：同名同内容章节块去重，导航每一项均指向实际章节', async () => {
  const f = auditFixture('# 总题\n\n## 方法\n\n相同结果。\n\n## 方法\n\n相同结果。')
  const chapters = sourceChapters(f.source)
  expect(new Set(chapters.map(c => chapterBlockId(c.id))).size).toBe(chapters.length)
  expect(chapters.slice(1).map(c => c.parent_id)).toEqual([chapters[0]!.id, chapters[0]!.id])
  const result = await f.run()
  const entry = { source_id: 'S-audit', metadata: f.source.metadata, current_path: 'a.md', updated_at: '2026-11-10T00:00:00Z', source_version: f.source.contentHash, files: { assets: [] } } as unknown as SourceEntry
  const content = renderSource(entry, result)
  for (const chapter of chapters) {
    const id = chapterBlockId(chapter.id)
    expect(content).toContain('](#^' + id + ')')
    expect(content.match(new RegExp('\\^' + id + '(?=\\n)', 'g'))).toHaveLength(1)
  }
})

it('B4：精细档高配额大包进一步拆小且篇级额度与全部正文保留', () => {
  const source = makeSource(Array.from({ length: 16 }, (_, i) => `# 章节${i}\n\n` + `第${i}章研究结果与条件。`.repeat(400)).join('\n\n'))
  const settings = layeredSettings({}, 100)
  const plan = planExtraction('S-0001', source, { tier: 100, granularity: 'fine', model: 'mock', prompt_version: 'audit' }, 98304, settings)
  expect(plan.length).toBeGreaterThan(4)
  for (const [id, segment] of source.segments.entries()) expect(plan.flat().filter(p => p.paragraph_id === id).map(p => p.text).join('')).toBe(source.text.slice(segment.start, segment.end))
  const quotas = sourceQuotas(source, plan, 100, settings)
  expect(quotas.quotas.reduce((a, b) => a + b, 0)).toBe(quotas.limit)
  expect(quotas.limit).toBe(300)
})
