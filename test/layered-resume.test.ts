import * as fs from 'node:fs/promises'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { extractSource } from '../src/layered/extraction.js'
import { readLocalSource } from '../src/layered/snapshot.js'
import { versionPage } from '../src/layered/objects.js'
import { hydrateVectors } from '../src/layered/vectors.js'
import { legacyTopicInputFingerprint, legacyTopicPointHashes, restoreTopicInputs, topicPageInputMatches, topicPointHashes, prepareTopics, topicHeader, topicInputFingerprint, topicBelowThresholdMessage } from '../src/layered/topics.js'
import { childrenOf, effectiveChildren, refreshTree, splitTopic } from '../src/layered/hierarchy.js'
import { layeredSettings } from '../src/domain/config.js'
import type { Extraction, PendingBuild, Point, Topic, TopicState } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, layeredIncrementalFixture, snapshotManifest } from './layered-fixture.js'

import { hash, writeJson } from '../src/layered/files.js'
import type { TopicEvidenceSource } from '../src/layered/topic-metadata.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

async function fixture() {
  const f = await layeredIncrementalFixture()
  f.options.topics = { topicMergeMinSources: 1, topicMaxSources: 1, topicMaxDepth: 1 }
  for (const [name, text] of [['a', '甲组证据一。'], ['b', '甲组证据二。'], ['c', '乙组证据一。'], ['d', '乙组证据二。']]) {
    await writeFile(path.join(f.knowledgeRoot, name + '.md'), text!)
  }
  await buildLayeredLibrary(f.options)
  const committed = await hydrateVectors(f.root, await snapshotManifest(f.root), true)
  f.options.vectorIdentity = committed.topics!.embedding.identity!
  const pending: PendingBuild = { format_version: 2, base_version: committed.version, version: null, manifest: structuredClone(committed),
    card: committed.card!, added: [], model_calls: 0, started_at: '2026-11-14T00:00:00Z',
    topics: { fingerprint: '', state: structuredClone(committed.topics!), pages: {}, rewritten: [], model_calls: 0 } }
  for (const topic of pending.topics!.state.topics) {
    const content = await versionPage(f.root, committed, topic.path)
    pending.topics!.pages[topic.path] = { content, dependencies: structuredClone(committed.deps!.pages[topic.path]!), input_fingerprint: String(topicHeader(content).input_fingerprint) }
  }
  await prepareTopics(f.root, pending, committed, f.options, undefined)
  f.call.mockClear(); f.topicRequests.length = 0
  const run = () => prepareTopics(f.root, pending, committed, f.options, undefined)
  const extraction = async () => JSON.parse(await readFile(path.join(f.root, pending.manifest.sources[0]!.extract.path), 'utf8')) as Extraction
  const save = async (value: Extraction) => {
    const entry = pending.manifest.sources[0]!
    entry.extract.path = 'work/resume-extract.json'
    await writeFile(path.join(f.root, entry.extract.path), JSON.stringify(value))
  }
  return { ...f, pending, committed, run, extraction, save }
}

it('摘要单独失败只补摘要，连续失败和成功都保留要点且主题链零调用', async () => {
  const f = await fixture(), previous = await f.extraction()
  const [key, group] = Object.entries(previous.group_cache!)[0]!
  const historicalSummaryCall = { input_bytes: 9999, input_limit: 64000 }
  previous.calls.push(historicalSummaryCall); (previous.summary_calls ??= []).push(historicalSummaryCall)
  group.missing_summary = true
  previous.group_summaries![key]!.missing = [key]
  previous.gaps = [{ kind: 'summary', segment_hashes: group.parts.map(part => part.text_hash), item: [], reasons: [] }]
  const source = await readLocalSource(path.join(f.knowledgeRoot, 'a.md'), 'Markdown 资料')
  const original = f.call.getMockImplementation()!
  let fail = true
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (input.summary_id) return fail ? '{"point_ids":["不存在"]}' : JSON.stringify({ point_ids: input.children[0].points.slice(0, 1).map((point: { point_id: string }) => point.point_id) })
    return original(...args)
  })
  const failed = await extractSource(f.root, previous.source_id, source, previous.processing, f.options, 64000, previous)
  expect(failed.segments).toEqual(previous.segments)
  expect(failed.group_cache![key]!.raw).toBe(group.raw)
  expect(failed.group_cache![key]!.missing_summary).toBe(true)
  fail = false
  const completed = await extractSource(f.root, previous.source_id, source, previous.processing, f.options, 64000, failed)
  expect(completed.segments).toEqual(previous.segments)
  expect(completed.group_cache![key]!.missing_summary).toBe(false)
  expect(completed.calls).toHaveLength(previous.calls.length + 2)
  expect(completed.calls.filter(call => call.input_bytes === 9999)).toHaveLength(1)
  expect(f.call.mock.calls).toHaveLength(2)
  expect(f.call.mock.calls.every(call => JSON.parse(call[2]).summary_id)).toBe(true)
  await f.save(completed); f.call.mockClear()
  await f.run()
  expect(f.call).not.toHaveBeenCalled()
})

it('单点正文变化只重做相关叶页，子摘要不变时父页只重核；子摘要变化才重生成', async () => {
  const f = await fixture(), extraction = await f.extraction()
  const point = extraction.segments.flatMap(segment => segment.points)[0]!
  const leaf = f.pending.topics!.state.topics.find(topic => !effectiveChildren(f.pending.topics!.state, topic).length && topic.point_ids.includes(point.point_id))!
  const parent = f.pending.topics!.state.topics.find(topic => topic.id === leaf.parent_id)!
  expect(parent).toBeDefined()
  const before = structuredClone(f.pending.topics!.pages)
  point.text += '研究条件改变。'
  await f.save(extraction); await f.run()
  expect(f.topicRequests.map(request => request.input.topic_id)).toEqual([leaf.id])
  const reviews = f.call.mock.calls.map(call => JSON.parse(call[2])).filter(input => input.review_stage === 'topic').map(input => input.topic_id)
  expect(reviews).toContain(parent.id)
  expect(reviews.every(id => id === leaf.id || id === parent.id)).toBe(true)
  for (const [name, page] of Object.entries(before)) if (name !== leaf.path && name !== parent.path) expect(f.pending.topics!.pages[name]).toEqual(page)
  f.call.mockClear(); f.topicRequests.length = 0
  const original = f.call.getMockImplementation()!
  f.call.mockImplementation(async (...args) => {
    const output = JSON.parse(await original(...args)), input = JSON.parse(args[2])
    if (input.topic_id === leaf.id && !input.review_stage) output.summary = '新的子页范围'
    return JSON.stringify(output)
  })
  point.text += '适用对象改变。'
  await f.save(extraction); await f.run()
  expect(f.topicRequests.map(request => request.input.topic_id)).toEqual([leaf.id, parent.id])
})

it('更换模型记账、来源非正文元数据和重启均零调用，来源标题变化仍失效', async () => {
  const f = await fixture()
  f.options.taskModelIdentity = { provider: '另一个供应商', model: '另一个模型' }
  f.library.models.unified = { provider: 'mock', model: '另一个模型' }
  const entry = f.pending.manifest.sources[0]!
  entry.metadata.credibility_reason = '更新记账说明'; entry.metadata.credibility = 'high'; entry.updated_at = '2099-01-01'
  await f.run(); await f.run()
  expect(f.call).not.toHaveBeenCalled()
  entry.metadata.title = '新来源标题'
  await f.run()
  expect(f.topicRequests).toHaveLength(1)
})

it('失败子页和无关拆分交错后，父页始终只含 313 个成功成员', () => {
  const state: TopicState = { format_version: 1, version: null, next_topic_number: 3, embedding: { url: '', model: '' }, topics: [], vectors: {} }
  const make = (id: string, parent_id: string | null, count: number, status: Topic['page_status'] = 'ready') => {
    const topic: Topic = { id, parent_id, path: 'topics/' + id + '.md', title: id, summary: id, sources: [], point_ids: [], centroid: [], revisions: 0, page_status: status }
    for (let i = 0; i < count; i++) { const point = `S-${id}:${i}`; topic.point_ids.push(point); state.vectors[point] = { input_hash: point, vector: [1] } }
    state.topics.push(topic); return topic
  }
  const parent = make('T-0001', null, 0)
  for (let i = 0; i < 13; i++) make('T-0001-' + i, parent.id, i === 12 ? 25 : 24)
  const failed = make('T-0001-99', parent.id, 8, 'failed')
  const other = make('T-0002', null, 4)
  refreshTree(state)
  const fingerprint = topicInputFingerprint(parent, state, {})
  expect(parent.point_ids).toHaveLength(313)
  splitTopic(state, other, layeredSettings({ topicMergeMinSources: 1 }), new Set(state.topics.map(topic => topic.id)))
  refreshTree(state)
  expect(parent.point_ids).toHaveLength(313)
  expect(topicInputFingerprint(parent, state, {})).toBe(fingerprint)
  expect(state.topics).toContain(failed)
  const restored = structuredClone(state); refreshTree(restored)
  expect(topicInputFingerprint(restored.topics.find(topic => topic.id === parent.id)!, restored, {})).toBe(fingerprint)
})

it('普通续跑保留门槛缺口，显式重试后的偶发失败仍会续做', async () => {
  const f = await fixture(), leaf = f.pending.topics!.state.topics.find(topic => topic.parent_id)!
  delete f.pending.topics!.pages[leaf.path]
  f.pending.topics!.gaps = [{ topic_id: leaf.id, point_ids: [...leaf.point_ids], kind: 'below-threshold', message: '模拟已确认门槛不足' }]
  f.pending.topics!.retry_topics = [structuredClone(leaf)]
  f.pending.retry_gaps = true; f.pending.retry_units = []
  await f.run(); await f.run()
  expect(f.topicRequests.some(request => request.input.topic_id === leaf.id)).toBe(false)
  f.call.mockClear(); f.topicRequests.length = 0
  f.pending.retry_units = ['topic:' + leaf.id, 'topic:已被替代的旧主题']
  f.options.taskModelIdentity = '本次缺口重试'
  const original = f.call.getMockImplementation()!
  f.call.mockImplementation(async (...args) => {
    if (JSON.parse(args[2]).topic_id === leaf.id) throw new Error('再次失败')
    return original(...args)
  })
  await f.run()
  const attempts = () => f.call.mock.calls.filter(call => JSON.parse(call[2]).topic_id === leaf.id).length
  expect(attempts()).toBe(1); expect(f.pending.retry_units).toEqual([])
  await f.run(); expect(attempts()).toBe(2)
  const extraction = await f.extraction()
  const point = extraction.segments.flatMap(segment => segment.points).find(point => leaf.point_ids.includes(point.point_id))!
  point.text += '输入确实改变。'
  await f.save(extraction); await f.run()
  expect(attempts()).toBe(3)
})

it('子页成功后解除父页旧失败结论，恢复后不重复调用', async () => {
  const f = await fixture(), build = f.pending.topics!
  const parent = build.state.topics.find(topic => childrenOf(build.state, topic).length)!
  const children = childrenOf(build.state, parent)
  for (const topic of [parent, ...children]) delete build.pages[topic.path]
  build.gaps = [{ topic_id: parent.id, point_ids: [...parent.point_ids], message: '子主题均有生成缺口。' }]
  build.retry_topics = [structuredClone(parent)]
  build.fingerprint = '旧版指纹'
  await f.run()
  expect(f.pending.topics!.pages[parent.path]).toBeDefined()
  expect(f.pending.topics!.pages[parent.path]!.dependencies.review).toBeDefined()
  expect(f.pending.topics!.state.topics.find(topic => topic.id === parent.id)!.archived).not.toBe(true)
  expect(f.pending.topics!.gaps?.some(gap => gap.topic_id === parent.id)).toBe(false)
  f.call.mockClear(); await f.run()
  expect(f.call).not.toHaveBeenCalled()
})

it('旧版原指纹验证后独立保存生成依赖，连续恢复零调用且证据上下文变化失效', async () => {
  const f = await fixture(), build = f.pending.topics!, points = new Map<string, Point>()
  for (const source of f.pending.manifest.sources) {
    const extraction = JSON.parse(await readFile(path.join(f.root, source.extract.path), 'utf8')) as Extraction
    for (const point of extraction.segments.flatMap(segment => segment.points)) points.set(point.point_id, point)
  }
  const legacyHashes = legacyTopicPointHashes(points, f.pending.manifest.sources)
  build.point_hashes = legacyHashes; delete build.point_hash_version; build.fingerprint = '旧版指纹'
  const originals = Object.fromEntries(build.state.topics.map(topic => {
    const page = build.pages[topic.path]!, fingerprint = legacyTopicInputFingerprint(topic, build.state, legacyHashes)
    page.input_fingerprint = fingerprint; delete page.generation_input_fingerprint
    page.content = page.content.replace(/^input_fingerprint: .*$/m, 'input_fingerprint: ' + fingerprint)
    return [topic.path, fingerprint]
  }))
  await f.run(); await f.run()
  expect(f.call).not.toHaveBeenCalled()
  for (const [name, fingerprint] of Object.entries(originals)) {
    const page = f.pending.topics!.pages[name]!
    expect(page.input_fingerprint).toBe(fingerprint)
    expect(topicHeader(page.content).input_fingerprint).toBe(fingerprint)
    expect(topicHeader(page.content).generation_input_fingerprint).toBe(page.generation_input_fingerprint)
  }
  const point = [...points.values()][0]!, source = f.pending.manifest.sources[0]!
  const evidence = point.evidence[0]!
  const context = (suffix: string): TopicEvidenceSource => {
    const text = evidence.quote.replace(/。$/, '') + suffix + '。'
    return { title: source.metadata.title, source_version: evidence.source_version, text,
      segments: [{ ...source.segments[0]!, start: 0, end: text.length }] }
  }
  const inputPoint = { ...point, evidence: [{ ...evidence, quote: evidence.quote.replace(/。$/, ''), locator: 'L1-L1' }] }
  const one = new Map([[point.point_id, inputPoint]])
  expect(topicPointHashes(one, [source], new Map([[source.source_id, context('条件甲')]])))
    .not.toEqual(topicPointHashes(one, [source], new Map([[source.source_id, context('条件乙')]])))
})

it('入口显式重试在发布前中断后保存消费状态，普通续跑仍补偶发缺口', async () => {
  const f = await fixture(), leaf = f.pending.topics!.state.topics.find(topic => topic.parent_id)!
  delete f.pending.topics!.pages[leaf.path]
  f.pending.topics!.gaps = [{ topic_id: leaf.id, point_ids: [...leaf.point_ids], message: '模拟失败' }]
  f.pending.topics!.retry_topics = [structuredClone(leaf)]
  await writeJson(f.root, 'work/pending.json', f.pending)
  const original = f.call.getMockImplementation()!
  f.call.mockImplementation(async (...args) => {
    if (JSON.parse(args[2]).topic_id === leaf.id) throw new Error('重试仍失败')
    return original(...args)
  })
  const rename = fs.rename
  const stop = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith('current.json')) throw new Error('模拟发布前中断')
    return rename(from, to)
  })
  await expect(buildLayeredLibrary({ ...f.options, retryGaps: true, taskModelIdentity: '显式重试' })).rejects.toThrow('模拟发布前中断')
  stop.mockRestore()
  expect(JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8')).retry_units).toEqual([])
  const attempts = () => f.call.mock.calls.filter(call => JSON.parse(call[2]).topic_id === leaf.id).length
  expect(attempts()).toBe(1)
  f.call.mockImplementation(original)
  await buildLayeredLibrary({ ...f.options, taskModelIdentity: '显式重试' })
  expect(attempts()).toBeGreaterThan(1)
  expect((await snapshotManifest(f.root)).topic_gaps?.some(gap => gap.topic_id === leaf.id)).toBe(false)
})

it('假模型快照恢复有效依赖并统计剩余调用单元，原检查点保持只读', async () => {
  const sample = await fixture(), original = sample.pending.topics!, points = new Map<string, Point>()
  const contexts = new Map<string, TopicEvidenceSource>()
  for (const source of sample.pending.manifest.sources) {
    const extraction = JSON.parse(await readFile(path.join(sample.root, source.extract.path), 'utf8')) as Extraction
    for (const point of extraction.segments.flatMap(segment => segment.points)) points.set(point.point_id, point)
    const bytes = await readFile(path.join(sample.root, source.files.source))
    expect(hash(bytes)).toBe(source.content_hash)
    contexts.set(source.source_id, { title: source.metadata.title, source_version: source.source_version, text: bytes.toString('utf8'), segments: source.segments })
  }
  const legacy = legacyTopicPointHashes(points, sample.pending.manifest.sources)
  const hashes = topicPointHashes(points, sample.pending.manifest.sources, contexts)
  for (const topic of original.state.topics) original.pages[topic.path]!.input_fingerprint = legacyTopicInputFingerprint(topic, original.state, legacy)
  original.point_hashes = legacy; delete original.point_hash_version
  const parent = original.state.topics.find(topic => childrenOf(original.state, topic).length > 1)!
  const failed = childrenOf(original.state, parent)[0]!
  const unfinished = original.state.topics.find(topic => topic.id !== failed.id && !childrenOf(original.state, topic).length)!
  delete original.pages[failed.path]; delete original.pages[unfinished.path]
  original.gaps = [{ topic_id: failed.id, point_ids: [...failed.point_ids], kind: 'below-threshold', message: topicBelowThresholdMessage }]
  await writeJson(sample.root, 'work/pending.json', sample.pending)
  const file = path.join(sample.root, 'work/pending.json'), bytes = await readFile(file)
  const pending = await hydrateVectors(sample.root, JSON.parse(bytes.toString('utf8'))) as PendingBuild, build = pending.topics!
  const fingerprints = Object.fromEntries(Object.entries(build.pages).map(([name, page]) => [name, page.input_fingerprint]))
  const compatible = restoreTopicInputs(build, hashes, legacy)
  const restored = build.state.topics.find(topic => topic.id === parent.id)!
  expect(restored.point_ids.some(id => failed.point_ids.includes(id))).toBe(false)
  expect(effectiveChildren(build.state, restored).every(topic => build.pages[topic.path])).toBe(true)
  expect(compatible.get(parent.path)).toBe(topicInputFingerprint(restored, build.state, hashes))
  let leafUnits = 0, parentUnits = 0, terminalGaps = 0
  const invalidGeneration: string[] = []
  for (const topic of build.state.topics) {
    const page = build.pages[topic.path]
    if (!page) {
      if (build.gaps?.some(gap => gap.topic_id === topic.id && gap.kind === 'below-threshold')) terminalGaps++
      else if (childrenOf(build.state, topic).length) parentUnits++
      else leafUnits++
    } else if (!topicPageInputMatches(topic, build.state, hashes, page.input_fingerprint, legacy)
      && compatible.get(topic.path) !== topicInputFingerprint(topic, build.state, hashes)) invalidGeneration.push(topic.id)
  }
  expect([leafUnits, parentUnits, terminalGaps]).toEqual([1, 0, 1])
  expect(invalidGeneration).toEqual([])
  expect(Object.fromEntries(Object.entries(build.pages).map(([name, page]) => [name, page.input_fingerprint]))).toEqual(fingerprints)
  expect(await readFile(file)).toEqual(bytes)
  expect(sample.call).not.toHaveBeenCalled()
})
