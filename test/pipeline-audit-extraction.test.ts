import { mockSupportReview } from './layered-fixture.js'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { extractSource, planExtraction } from '../src/layered/extraction.js'
import { readLocalSource } from '../src/layered/snapshot.js'
import { cleanupLayeredFixtures, layeredFixture } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
const processing = { tier: 50 as const, prompt_version: '审查', model: 'mock/extractor' }
async function fixture() {
  const f = await layeredFixture(), file = path.join(f.knowledgeRoot, 'book.md'), requests: any[] = []
  await writeFile(file, '# 全书\n\n' + Array.from({ length: 12 }, (_, i) => `## 章节${i}\n\n第${i}章研究发现成立，证据完整保留。${'x'.repeat(140)}\n\n`).join(''))
  const source = await readLocalSource(file, '审查资料')
  f.call.mockImplementation(async (_task, system, input) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(input))
    if (support) return support
    const r = JSON.parse(input); requests.push({ ...r, bytes: Buffer.byteLength(system + input) })
    if (r.summary_id) return JSON.stringify({ point_ids: r.children.flatMap((child: any) => child.points.map((point: any) => point.point_id)).slice(0, r.point_limit) })
    const points = r.paragraphs.filter((p: any) => !p.text.startsWith('#')).map((p: any) => ({ paragraph_id: p.paragraph_id, text: p.text, section: '主要发现', evidence: [{ locator: p.locator, quote: p.text }] }))
    return JSON.stringify({ tags: ['研究方法', '研究对象', '核心主题'], credibility: 'low', credibility_reason: '测试', points, terms: [], summary_point_indices: points.map((_: any, i: number) => i).slice(0, r.summary_point_limit ?? 8) })
  })
  return { ...f, source, requests }
}

it('P06 打包提取的每个要点可定位章节，全书摘要仅引用已校验要点并按原规则限额', async () => {
  const f = await fixture()
  const result = await extractSource(f.root, 'S-0001', f.source, processing, f.options, 6000)
  expect(result.gaps).toEqual([])
  const points = result.segments.flatMap(segment => segment.points)
  expect(points).toHaveLength(12)
  for (const [index, segment] of result.segments.entries()) if (segment.points.length) expect(result.chapters!.filter(chapter => chapter.paragraph_ids.includes(index))).toHaveLength(1)
  expect(result.summary!.point_ids.length).toBeGreaterThan(0); expect(result.summary!.point_ids.length).toBeLessThanOrEqual(8)
  for (const id of result.summary!.point_ids) expect(points.map(point => point.point_id)).toContain(id)
  expect(f.requests.some(request => request.summary_id)).toBe(true)
  for (const request of f.requests) expect(request.bytes).toBeLessThanOrEqual(6000)
})

it('P07 旧逐章提取缓存不能冒充新打包成果，重提后重复续做零调用', async () => {
  const f = await fixture(), all = planExtraction('S-0001', f.source, processing, 50000).flat()
  const oldPlan = Array.from({ length: 12 }, (_, i) => all.filter(part => part.paragraph_id === 2 * i + 1 || part.paragraph_id === 2 * i + 2 || i === 0 && part.paragraph_id === 0))
  const old = await extractSource(f.root, 'S-0001', f.source, processing, f.options, 6000, undefined, [], undefined, oldPlan)
  // 旧协议缓存没有分包计划或提示词正文哈希，不能当作本版可复用计划。
  delete old.processing.prompt_hash; delete old.chunk_plan; delete old.plan_config_fingerprint
  f.requests.splice(0)
  const next = await extractSource(f.root, 'S-0001', f.source, processing, f.options, 6000, old)
  expect(next.grouping_fingerprint).not.toBe(old.grouping_fingerprint)
  expect(f.requests.some(request => request.paragraphs?.length > 3)).toBe(true)
  expect(next.segments.flatMap(segment => segment.points)).toHaveLength(12)
  f.requests.splice(0)
  await extractSource(f.root, 'S-0001', f.source, processing, f.options, 6000, next)
  expect(f.requests).toHaveLength(0)
})

it('P08 图片打包调整不能放宽逐字引文校验', async () => {
  const f = await fixture()
  f.call.mockImplementation(async () => JSON.stringify({ tags: ['研究方法', '研究对象', '核心主题'], credibility: 'low', credibility_reason: '测试', points: [{ paragraph_id: 2, text: '编造结果', section: '主要发现', evidence: [{ locator: f.source.segments[2]!.locator, quote: '原文从未出现的引文' }] }], terms: [] }))
  const result = await extractSource(f.root, 'S-0001', f.source, processing, f.options, 50000)
  expect(result.segments.flatMap(segment => segment.points)).toEqual([])
  expect(result.gaps!.length).toBeGreaterThan(0)
})
