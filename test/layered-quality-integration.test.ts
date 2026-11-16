import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary, readLayeredPage } from '../src/layered/index.js'
import { cleanupLayeredFixtures, layeredTopicFixture, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
const inputs = (f: Awaited<ReturnType<typeof layeredTopicFixture>>) => f.call.mock.calls.map(args => JSON.parse(args[2]))

it('改档重提全部来源，未变化主题复用；概览和核对单项修改不重提来源', async () => {
  const f = await layeredTopicFixture()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组结论成立。')
  await buildLayeredLibrary({ ...f.options, granularity: 'standard' })
  f.call.mockClear(); f.topicRequests.length = 0
  await buildLayeredLibrary({ ...f.options, tier: 100, granularity: 'fine' })
  expect(inputs(f).filter(input => input.paragraphs && !input.validationFeedback)).toHaveLength(1)
  expect(inputs(f).filter(input => input.review_stage === 'extraction')).toHaveLength(1)
  expect(f.topicRequests).toEqual([])
  f.call.mockClear()
  const options = { ...f.options, tier: 100, granularity: 'fine' as const, topics: { ...f.options.topics as object, sourceOverviewChineseChars: 6 } }
  await buildLayeredLibrary(options)
  expect(f.call).not.toHaveBeenCalled()
  expect(await readLayeredPage(f.knowledgeRoot, 'sources/S-0001.md')).toContain('## 概览')
  f.call.mockClear()
  await buildLayeredLibrary({ ...options, topics: { ...options.topics, contradictionReview: false } })
  expect(inputs(f).map(input => input.review_stage)).toEqual(['topic'])
})

it('核对服务失败隔离单来源，未核实标记入来源页且禁止进入主题，重复建库零调用', async () => {
  const f = await layeredTopicFixture(), original = f.call.getMockImplementation()!
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组证据。')
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '乙组证据。')
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (input.review_stage === 'extraction' && input.source_id === 'S-0001') throw new Error('核对服务暂时不可用')
    return original(...args)
  })
  const options = { ...f.options, topics: { ...f.options.topics as object, extractionReview: 'all' as const } }
  await buildLayeredLibrary(options)
  const manifest = await snapshotManifest(f.root)
  expect(await readLayeredPage(f.knowledgeRoot, 'sources/S-0001.md')).toContain('## 未核实')
  const topics = Object.entries(manifest.pages!).filter(([name]) => name.startsWith('topics/'))
  expect(topics).toHaveLength(1)
  for (const [name] of topics) expect(await readLayeredPage(f.knowledgeRoot, name)).not.toContain('sources/S-0001.md')
  // 已发布的核对未完成项不在普通生成中自动重试；显式重试缺口时只重发该来源的核对。
  f.call.mockClear()
  expect(await buildLayeredLibrary(options)).toMatchObject({ modelCalls: 0, unchanged: true })
  expect(f.call).not.toHaveBeenCalled()
  await buildLayeredLibrary({ ...options, retryGaps: true })
  expect(inputs(f).map(input => [input.review_stage, input.source_id])).toEqual([['extraction', 'S-0001']])
  f.call.mockClear()
  expect(await buildLayeredLibrary(options)).toMatchObject({ modelCalls: 0, unchanged: true })
  expect(f.call).not.toHaveBeenCalled()
})

it('主题核对删光无依据句后发布其余主题并登记缺口，补证仍不足不能发布', async () => {
  const f = await layeredTopicFixture(), original = f.call.getMockImplementation()!
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组证据。')
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '乙组证据。')
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (input.topic_id === 'T-0001' && input.review_stage === 'topic') return JSON.stringify({ items: input.sentences.map((s: any) => ({ id: s.id, support: '不支撑', missing: '把转述写成作者结论' })) })
    if (input.topic_id === 'T-0001' && input.review_stage === 'topic-correction') return JSON.stringify({ sentences: input.sentences.map((s: any) => ({ ...s, point_ids: input.members.map((p: any) => p.point_id), support: '不支撑', missing: '补充证据仍不支持原主张' })) })
    return original(...args)
  })
  await buildLayeredLibrary(f.options)
  const manifest = await snapshotManifest(f.root)
  expect(manifest.pages).not.toHaveProperty('topics/T-0001.md')
  expect(manifest.pages).toHaveProperty('topics/T-0002.md')
  expect(manifest.topic_gaps?.find(gap => gap.topic_id === 'T-0001')?.message).toContain('重生成预算耗尽')
  const targetInputs = inputs(f).filter(input => input.topic_id === 'T-0001')
  // 首稿加两次再生，每稿均完整核对和纠正；持续无据后保持失败，不再发布该主题。
  expect(targetInputs.filter(input => !input.review_stage).map(input => input.regeneration)).toEqual([undefined, 1, 2])
  expect(targetInputs.filter(input => input.review_stage === 'topic')).toHaveLength(3)
  expect(targetInputs.filter(input => input.review_stage === 'topic-correction')).toHaveLength(3)
  expect(manifest.topic_recovery?.repairs['T-0001']).toMatchObject({ stage: 'generate', regenerations: 3 })
  expect(manifest.topic_recovery?.topics.find(topic => topic.id === 'T-0001')?.page_status).toBe('failed')
})

it('同名且向量相同的不同指称术语保持独立', async () => {
  const f = await layeredTopicFixture(), original = f.call.getMockImplementation()!
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组研究设计。')
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '乙组研究结果。')
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2]), raw = await original(...args)
    if (!input.paragraphs || input.validationFeedback) return raw
    const output = JSON.parse(raw)
    output.terms = [{ paragraph_id: input.paragraphs[0].paragraph_id, name: '指标', category: '概念', aliases: [], note: '同名歧义指标', locator: input.paragraphs[0].locator, referent: input.source_id === 'S-0001' ? '研究设计' : '研究结果' }]
    return JSON.stringify(output)
  })
  await buildLayeredLibrary(f.options)
  const deps = (await snapshotManifest(f.root)).deps!
  const terms = Object.values(deps.pages).flatMap(page => page.terms ?? [])
  expect(terms).toHaveLength(2)
  expect(terms.map(term => term.contributions.length)).toEqual([1, 1])
})
