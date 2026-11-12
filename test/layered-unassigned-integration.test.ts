import { afterEach, expect, it, vi } from 'vitest'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildLayeredLibrary, readLayeredPage } from '../src/layered/index.js'
import { prepareTopics } from '../src/layered/topics.js'
import { memberContentHash } from '../src/layered/membership.js'
import { hash } from '../src/layered/files.js'
import { cleanupLayeredFixtures, hydratedState, layeredIncrementalFixture, restoreFixture, snapshotFixture, snapshotManifest } from './layered-fixture.js'
import { pendingFixture } from './pipeline-audit-fixture.js'
import type { TopicState } from '../src/layered/schema.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('首次核对移出的成员持久保存，无关增量保持旧主题成员和页面字节', async () => {
  const f = await layeredIncrementalFixture(), original = f.call.getMockImplementation()!
  f.options.topics = { topicMergeMinSources: 2 }
  for (const [name, text] of [['a', '甲组护士冲突。'], ['b', '甲组护士协作。'], ['c', '甲组研究者偏倚。']]) {
    await writeFile(path.join(f.knowledgeRoot, name + '.md'), text!)
  }
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (!input.topic_id || input.review_stage) return original(...args)
    const members = [...input.points, ...input.current_points ?? []]
    return JSON.stringify({ title: '护士团队', summary: '护士协作与冲突', aliases: [], consensus: [], differences: [],
      conditions: members.filter(item => !item.text.includes('偏倚')).map(item => ({ text: item.text, point_ids: [item.point_id] })),
      removed_members: members.filter(item => item.text.includes('偏倚')).map(item => ({ point_id: item.point_id, reason: '不同问题' })) })
  })
  await buildLayeredLibrary(f.options)
  const first = await snapshotManifest(f.root), topic = first.topics!.topics[0]!
  const rejected = Object.keys(first.topics!.excluded_members![topic.id]!)[0]!
  expect(first.topics!.candidates?.flat()).toContain(rejected)
  expect((await hydratedState<TopicState>(f.root)).candidates?.flat()).toContain(rejected)
  const page = await readLayeredPage(f.knowledgeRoot, topic.path)
  // 删除可重建的状态文件，增量仍须从发布清单恢复候选身份。
  await unlink(path.join(f.root, 'state/topics.json'))
  await writeFile(path.join(f.knowledgeRoot, 'd.md'), '乙组与护士无关的新问题。')
  f.call.mockClear()
  await buildLayeredLibrary(f.options)
  const next = await snapshotManifest(f.root)
  expect(next.topics!.topics.find(item => item.id === topic.id)).toEqual(topic)
  expect(next.topics!.candidates?.flat()).toContain(rejected)
  expect(await readLayeredPage(f.knowledgeRoot, topic.path)).toBe(page)
  expect(f.call.mock.calls.filter(args => JSON.parse(args[2]).topic_id)).toHaveLength(0)
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ unchanged: true, modelCalls: 0 })
})

it('主题已删除使排除记录失效，未变要点可以重新归属', async () => {
  const f = await pendingFixture(), build = f.pending.topics!, topic = build.state.topics[0]!, id = topic.point_ids[0]!
  const source = f.pending.manifest.sources.find(source => id.startsWith(source.source_id + ':'))!
  const extract = JSON.parse(await readFile(path.join(f.root, source.extract.path), 'utf8'))
  const point = extract.segments.flatMap((segment: any) => segment.points).find((point: any) => point.point_id === id)
  build.state.excluded_members = { 'T-0999': { [id]: { content_hash: memberContentHash(point), reason: '旧主题已删除' } } }
  topic.point_ids = topic.point_ids.filter(value => value !== id)
  build.state.candidates = [[id]]; build.fingerprint = ''
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(f.pending.topics!.state.excluded_members!['T-0999']).toBeUndefined()
  expect(f.pending.topics!.state.topics.flatMap(topic => topic.point_ids)).toContain(id)
})

it('排除内容哈希失效后未改向量的要点也会恢复归属', async () => {
  const f = await pendingFixture(), build = f.pending.topics!, topic = build.state.topics[0]!, id = topic.point_ids[0]!
  build.state.excluded_members = { [topic.id]: { [id]: { content_hash: '过期内容哈希', reason: '旧内容不适用' } } }
  topic.point_ids = topic.point_ids.filter(value => value !== id)
  build.state.candidates = [[id]]; build.fingerprint = ''
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(f.pending.topics!.state.excluded_members![topic.id]![id]).toBeUndefined()
  expect(f.pending.topics!.state.topics.find(item => item.id === topic.id)!.point_ids).toContain(id)
})

it('失败主题留下的全部未归属点写回候选，显式重试仍恢复原身份', async () => {
  const f = await pendingFixture(), build = f.pending.topics!, topic = build.state.topics[0]!
  delete build.pages[topic.path]
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (input.topic_id === topic.id) throw new Error('模拟主题暂时失败')
    return f.original(...args)
  })
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(f.pending.topics!.state.candidates?.flat()).toEqual(expect.arrayContaining(topic.point_ids))
  const checkpoint = JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8'))
  expect(checkpoint.topics.state.candidates.flat()).toEqual(expect.arrayContaining(topic.point_ids))
  f.call.mockImplementation(f.original)
  await prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryGaps: true }, undefined)
  expect(f.pending.topics!.state.topics.some(item => item.id === topic.id)).toBe(true)
  expect(f.pending.topics!.state.candidates?.flat().some(id => topic.point_ids.includes(id))).toBe(false)
})

it('同一输入冷建两次逐字节一致，v0.1.1 页面正文保持', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-09T00:00:00Z'))
  try {
    const f = await pendingFixture()
    for (const source of f.pending.manifest.sources) {
      source.updated_at = '2026-11-09T00:00:00.000Z'
      source.metadata.source_date = '2026-11-09'; source.metadata.source_date_basis = '原文日期'
    }
    const input = await snapshotFixture(f.knowledgeRoot)
    const cold = async () => {
      await restoreFixture(input, f.knowledgeRoot)
      const pending = structuredClone(f.pending)
      delete pending.topics; delete pending.manifest.topic_sequence
      await prepareTopics(f.root, pending, f.committed, f.options, undefined)
      return { bytes: JSON.stringify({ state: pending.topics!.state, pages: pending.topics!.pages }),
        pages: Object.entries(pending.topics!.pages).map(([name, page]) => [name, page.content]) }
    }
    const first = await cold(), second = await cold()
    expect(first.bytes).toBe(second.bytes)
    // 合并后的共享核对上下文会改变协议指纹；其余字节仍与独立 v0.1.1 基线比较。
    expect(hash(JSON.stringify(first.pages.map(([name, content]) => [name,
      content!.replace(/^generation_hash: .*\n|^input_fingerprint: .*\n/gm, '')]))))
      .toBe('sha256:06b2e97dbfd2f41288e46cebc52144cc7ebf7982206c0172f7c7466aae191f8e')
  } finally { vi.useRealTimers() }
})
