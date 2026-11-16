// 不同标题区分独立来源，证据正文与完整输入预算、共识及逐字断言保持。
import { afterEach, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { topicInputBudget } from '../src/llm/context.js'
import { layeredSettings } from '../src/domain/config.js'
import { completeInputBlocks, topicBudget } from '../src/layered/input-budget.js'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { reviewTopicContent } from '../src/layered/topic-review.js'
import { cleanupLayeredFixtures, layeredTopicFixture, snapshotManifest, mockSupportReview } from './layered-fixture.js'
import { readExtraction } from '../src/layered/publication.js'
import type { Point } from '../src/layered/schema.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => { vi.useRealTimers(); cleanupLayeredFixtures() })

it('预算按当前阶段模型上下文、输出额度和安全预留计算，0 自动且覆盖不能越过模型上限', async () => {
  expect(topicInputBudget(262144, 32768)).toBe(203161)
  expect(topicInputBudget(256000, 4096)).toBe(226304)
  expect(topicInputBudget(1048576, 256000)).toBe(687718)
  expect(layeredSettings().leafInputBudget).toBe(0)
  expect(layeredSettings().parentInputBudget).toBe(0)
  expect(() => layeredSettings({ leafInputBudget: -1 })).toThrow()
  const f = await layeredTopicFixture()
  f.options.client = { call: f.call, info: vi.fn(async (_task, _signal, _required, operation) => ({ provider: '测试', id: '模型', name: '模型',
    context: { contextWindow: operation === 'parent' ? 1048576 : 262144 }, defaultMaxTokens: 32768 })) }
  expect(await topicBudget(f.options, 'topic')).toBe(203161)
  expect(await topicBudget(f.options, 'parent')).toBe(910950)
  expect(await topicBudget(f.options, 'topic', 50000)).toBe(50000)
  expect(await topicBudget(f.options, 'topic', 9999999)).toBe(203161)
})

async function largeFixture(fail = false) {
  const f = await layeredTopicFixture(), requests: any[] = [], original = f.call.getMockImplementation()!
  for (const name of ['a', 'b', 'c']) await writeFile(path.join(f.knowledgeRoot, name + '.md'), '# 来源' + name + '\n\n' + '甲组完整依据。'.repeat(120))
  f.options.topics = { topicMergeMinSources: 3, leafInputBudget: 8500, topicMaxChars: 1700, topicMaxPoints: 100, topicReview: false }
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (!input.topic_id) return original(...args)
    requests.push(input)
    expect(Buffer.byteLength(args[1] + args[2])).toBeLessThanOrEqual(8500)
    if (fail && input.synthesis_stage === 'member-merge') throw new Error('模拟合并失败')
    return JSON.stringify({ title: '合并主题', summary: '全部成员', aliases: [], removed_members: [], consensus: [], differences: [],
      conditions: [{ text: '完整依据。', point_ids: input.points.map((point: any) => point.point_id) }] })
  })
  return { ...f, requests }
}

it('三来源拆不开时完整分块，合并输入覆盖所有要点，30/3/1 路页面及依赖逐字节一致', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-10T00:00:00Z'))
  const outputs: string[] = []
  for (const concurrency of [30, 3, 1]) {
    const f = await largeFixture(); f.policy.pageGenerationConcurrency = concurrency
    await buildLayeredLibrary(f.options)
    const manifest = await snapshotManifest(f.root)
    expect(manifest.topic_gaps ?? []).toEqual([])
    const points = (await Promise.all(manifest.sources.map(source => readExtraction(f.root, source.extract.path)))).flatMap(extraction => extraction.segments.flatMap(segment => segment.points))
    const blocks = f.requests.filter(input => input.synthesis_stage === 'member-block')
    expect(blocks.length).toBeGreaterThan(1)
    const ids = manifest.topics!.topics.flatMap(topic => topic.point_ids)
    const expected = points.map(point => ({ point_id: 'P' + (ids.indexOf(point.point_id) + 1), ref: 'P' + (ids.indexOf(point.point_id) + 1), source_id: point.evidence[0]!.source_id,
      // 研究归属提示新增来源标题，完整要点与逐字引文的精确比较继续保留。
      source_title: manifest.sources.find(source => source.source_id === point.evidence[0]!.source_id)!.metadata.title,
      text: point.text, evidence: point.evidence.map(({ source_id, locator, quote }) => ({ source_id, locator, quote })) }))
    expect(blocks.flatMap(input => input.points).sort((a, b) => a.point_id.localeCompare(b.point_id))).toEqual(expected.sort((a, b) => a.point_id.localeCompare(b.point_id)))
    expect(f.requests.at(-1).points.map((point: any) => point.point_id).sort()).toEqual(expected.map(point => point.point_id).sort())
    const { readVersion, versionPage } = await import('../src/layered/objects.js')
    const version = await readVersion(f.root, manifest.version!)
    const pages = Object.keys(version.deps.pages).filter(page => page.startsWith('topics/'))
    outputs.push(JSON.stringify([await Promise.all(pages.map(page => versionPage(f.root, version, page))), pages.map(page => version.deps.pages[page])]))
  }
  expect(outputs[1]).toBe(outputs[0]); expect(outputs[2]).toBe(outputs[0])
})

it('合并仍失败时发布来源和其他成果，缺口保留全部成员且不重试整个批次', async () => {
  const f = await largeFixture(true)
  for (const name of ['d', 'e', 'f']) await writeFile(path.join(f.knowledgeRoot, name + '.md'), '# 来源' + name + '\n\n' + '乙组独立的完整依据。')
  const result = await buildLayeredLibrary(f.options)
  expect(result.version).toBe('v000001')
  const manifest = await snapshotManifest(f.root)
  expect(manifest.sources).toHaveLength(6)
  expect(manifest.topic_gaps).toEqual([expect.objectContaining({ message: '模拟合并失败' })])
  const points = (await Promise.all(manifest.sources.slice(0, 3).map(source => readExtraction(f.root, source.extract.path)))).flatMap(extraction => extraction.segments.flatMap(segment => segment.points))
  expect(manifest.topic_gaps![0]!.point_ids.sort()).toEqual(points.map(point => point.point_id).sort())
  expect(f.requests.filter(input => input.synthesis_stage === 'member-merge')).toHaveLength(1)
  const { readVersion } = await import('../src/layered/objects.js')
  expect(Object.keys((await readVersion(f.root, result.version)).deps.pages).filter(page => page.startsWith('topics/'))).toHaveLength(1)
})

it('分块核对逐句覆盖全部成员及完整引文，并合并跨块结论后保留正文', async () => {
  const f = await layeredTopicFixture(), requests: any[] = []
  const members = Array.from({ length: 6 }, (_, index) => ({ point_id: 'S-0001:p' + index, text: '完整事实。'.repeat(180), section: '主要发现', locator: 'L1-L1',
    evidence: [{ source_id: 'S-0001', source_version: 'v1', locator: 'L1-L1', quote: '完整引文。'.repeat(180) }] })) as Point[]
  f.options.topics = { topicReviewInputBudget: 8500 }
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2]); requests.push(input)
    expect(Buffer.byteLength(args[1] + args[2])).toBeLessThanOrEqual(8500)
    if (input.review_stage === 'topic-block') return JSON.stringify({ items: input.sentences.map((item: any) => ({ id: item.id, support: '部分支撑', missing: '其余块的事实',
      findings: '当前块完整引文支持一个条件。', point_ids: input.members.map((member: any) => member.point_id) })) })
    return mockSupportReview({ ...input, review_stage: 'topic' })!
  })
  const content = '# 主题\n\n范围：成员联合支撑。\n\n## 适用条件\n\n- 完整事实。'
  const checked = await reviewTopicContent('T-1', content, members, f.options)
  expect(checked.content).toBe(content); expect(checked.review!.removed).toEqual([])
  const merged = requests.filter(input => input.review_stage === 'topic-merge')
  expect(merged.length).toBeGreaterThan(0)
  for (const request of merged) {
    expect(request.blocks.flatMap((block: any) => block.member_ids).sort()).toEqual(members.map((_point, index) => 'P' + (index + 1)).sort())
    const blocks = requests.filter(input => input.review_stage === 'topic-block' && input.sentences[0].id === request.sentences[0].id)
    expect(blocks.flatMap(input => input.members)).toEqual(members.map((point, index) => ({ point_id: 'P' + (index + 1), text: point.text,
      evidence: point.evidence.map(({ source_id, source_version, locator, quote }) => ({ source_id, source_version, locator, quote })) })))
    expect(request.navigation).toEqual({ sections: [], children: [] })
    expect(request.source_versions).toEqual([{ source_id: 'S-0001', source_version: 'v1' }])
    expect(blocks.every(block => JSON.stringify(block.navigation) === JSON.stringify(request.navigation)
      && JSON.stringify(block.source_versions) === JSON.stringify(request.source_versions))).toBe(true)
  }
})

it('单成员超预算明确留缺口，完整引文不可截断成伪成功输入', () => {
  expect(() => completeInputBlocks(['完整引文'.repeat(100)], items => JSON.stringify(items).length < 50)).toThrow('不截断事实或引文')
})
