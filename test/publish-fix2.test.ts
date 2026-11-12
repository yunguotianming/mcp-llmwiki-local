import { afterEach, expect, it, vi } from 'vitest'
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { prepareTerms } from '../src/layered/terms.js'
import { prepareTopics, topicBelowThresholdMessage } from '../src/layered/topics.js'
import { canonicalTags } from '../src/layered/tags.js'
import { publishLibrary } from '../src/layered/publication.js'
import { readVersion } from '../src/layered/objects.js'
import { writeJson } from '../src/layered/files.js'
import { storageJson } from '../src/layered/vectors.js'
import type { PendingBuild } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, hydratedState, versionFile } from './layered-fixture.js'
import { pendingFixture, changeExtraction } from './pipeline-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

async function thresholdFixture(kind = false) {
  const f = await pendingFixture(), build = f.pending.topics!, topic = structuredClone(build.state.topics[0]!)
  delete build.pages[topic.path]
  build.state.topics = build.state.topics.filter(item => item.id !== topic.id)
  build.retry_topics = [topic]
  const gap = { topic_id: topic.id, point_ids: [...topic.point_ids], message: kind ? '门槛提示已调整' : topicBelowThresholdMessage,
    ...(kind ? { kind: 'below-threshold' as const } : {}) }
  build.gaps = [gap]
  f.call.mockClear(); f.topicRequests.splice(0)
  return { ...f, topic, gap }
}

it('续做从51类旧索引切到数量分页，发布与阅读目录移除旧页', async () => {
  const f = await pendingFixture()
  await changeExtraction(f, extraction => {
    const segment = extraction.segments[0]!
    segment.terms = Array.from({ length: 51 }, (_, i) => ({ name: '词' + i, category: '类别' + String(i).padStart(3, '0'),
      aliases: [], locator: segment.locator, note: '' }))
  })
  const options = { ...f.options, tier: 5, topics: { ...f.options.topics || {}, termIndexMaxPages: 100 } }
  await prepareTerms(f.root, f.pending, f.committed, options)
  const oldVersion = await publishLibrary(f.root, f.pending)
  expect((await readdir(path.join(f.root, 'wiki/terms'))).filter(page => page.startsWith('index-'))).toHaveLength(51)
  const committed = await readVersion(f.root, oldVersion)
  f.pending.base_version = oldVersion
  const fingerprint = f.pending.terms!.fingerprint
  await prepareTerms(f.root, f.pending, committed, { ...options, topics: { ...options.topics, termIndexMaxPages: 50 } })
  expect(f.pending.terms!.fingerprint).toBe(fingerprint)
  expect(Object.keys(f.pending.terms!.pages)).toEqual(['terms/index-01.md'])
  const next = await publishLibrary(f.root, f.pending), manifest = await readVersion(f.root, next)
  expect(Object.keys(manifest.pages!).filter(page => page.startsWith('terms/'))).toEqual(['terms/index-01.md'])
  expect(Object.keys(manifest.deps!.pages).filter(page => page.startsWith('terms/'))).toEqual(['terms/index-01.md'])
  expect(await readdir(path.join(f.root, 'wiki/terms'))).toEqual(['index-01.md'])
  expect(await versionFile(f.root, next, 'index.md')).not.toContain('terms/index-02.md')
})

it('同一数量分页模式页数减少时清理尾页', async () => {
  const f = await pendingFixture()
  await changeExtraction(f, extraction => {
    const segment = extraction.segments[0]!
    segment.terms = Array.from({ length: 7 }, (_, i) => ({ name: '词' + i, category: '类别' + i, aliases: [], locator: segment.locator, note: '' }))
  })
  const options = { ...f.options, tier: 5, topics: { ...f.options.topics || {}, termIndexMaxPages: 1, termIndexPageSize: 2 } }
  await prepareTerms(f.root, f.pending, f.committed, options)
  expect(Object.keys(f.pending.terms!.pages)).toHaveLength(4)
  await prepareTerms(f.root, f.pending, f.committed, { ...options, topics: { ...options.topics, termIndexPageSize: 200 } })
  expect(Object.keys(f.pending.terms!.pages)).toEqual(['terms/index-01.md'])
})

it('标签别名包含分隔符后原地拆成两项仍使缓存失效', () => {
  const terms = [{ name: '主名', aliases: ['甲\u0002乙'] }]
  expect(canonicalTags(['甲'], terms)).toEqual(['甲'])
  terms[0]!.aliases = ['甲', '乙']
  expect(canonicalTags(['甲'], terms)).toEqual(['主名'])
  expect(canonicalTags(['甲'], terms)).toEqual(canonicalTags(['甲'], structuredClone(terms)))
})

it('失败主题成员变化后生成新主题并清除旧门槛缺口', async () => {
  const f = await thresholdFixture()
  await changeExtraction(f, extraction => {
    for (const segment of extraction.segments) for (const point of segment.points) if (f.topic.point_ids.includes(point.point_id)) point.text += '新条件'
  })
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(f.topicRequests.some(request => request.input.topic_id !== f.topic.id)).toBe(true)
  expect(f.pending.manifest.topic_gaps?.some(gap => gap.topic_id === f.topic.id)).toBe(false)
})

it('显式重试旧格式门槛缺口调用模型并移除旧结论', async () => {
  const f = await thresholdFixture()
  await prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryGaps: true }, undefined)
  expect(f.topicRequests.some(request => request.input.topic_id === f.topic.id)).toBe(true)
  expect(f.pending.topics!.pages).toHaveProperty(f.topic.path)
  expect(f.pending.manifest.topic_gaps).toEqual([])
})

it('类别识别不依赖提示文本，自动续做保留缺口且显式重试调用模型', async () => {
  const f = await thresholdFixture(true)
  await writeJson(f.root, 'work/pending.json', f.pending)
  f.pending = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(f.call).not.toHaveBeenCalled()
  expect(f.pending.manifest.topic_gaps).toEqual([f.gap])
  await prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryGaps: true }, undefined)
  expect(f.topicRequests.some(request => request.input.topic_id === f.topic.id)).toBe(true)
})

it('其他分支变化时旧格式门槛缺口与重试身份保留', async () => {
  const f = await thresholdFixture()
  const other = f.pending.topics!.state.topics[0]!
  await changeExtraction(f, extraction => {
    for (const segment of extraction.segments) for (const point of segment.points) if (other.point_ids.includes(point.point_id)) point.text += '另一分支条件'
  })
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(f.topicRequests.some(request => request.input.topic_id === f.topic.id)).toBe(false)
  expect(f.pending.manifest.topic_gaps).toContainEqual(f.gap)
  expect(f.pending.topics!.retry_topics?.map(topic => topic.id)).toContain(f.topic.id)
})

it('原主题成员消失或被新主题替代时旧门槛缺口清除', async () => {
  const f = await thresholdFixture()
  f.pending.topics!.state.topics.push({ ...f.topic, id: 'T-0003', path: 'topics/T-0003.md' })
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(f.pending.manifest.topic_gaps?.some(gap => gap.topic_id === f.topic.id)).toBe(false)
  const removed = await thresholdFixture()
  await changeExtraction(removed, extraction => {
    for (const segment of extraction.segments) segment.points = segment.points.filter(point => !removed.topic.point_ids.includes(point.point_id))
  })
  await prepareTopics(removed.root, removed.pending, removed.committed, removed.options, undefined)
  expect(removed.pending.manifest.topic_gaps?.some(gap => gap.topic_id === removed.topic.id)).toBe(false)
})

it('新门槛失败保存类别并能从持久化检查点显式重试', async () => {
  const f = await pendingFixture(), topic = f.pending.topics!.state.topics[0]!
  delete f.pending.topics!.pages[topic.path]
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2]), output = JSON.parse(await f.original(...args))
    if (input.topic_id === topic.id && !input.review_stage) {
      const removed = input.points[0].point_id
      output.removed_members = [{ point_id: removed, reason: '不同对象' }]
      for (const kind of ['consensus', 'differences', 'conditions']) output[kind] = output[kind].map((item: { point_ids: string[] }) =>
        ({ ...item, point_ids: item.point_ids.filter(id => id !== removed) })).filter((item: { point_ids: string[] }) => item.point_ids.length)
    }
    return JSON.stringify(output)
  })
  const options = { ...f.options, topics: { ...f.options.topics || {}, topicMergeMinSources: 3 } }
  // 保持已保存的候选树，仅验证模型移出成员后的失败路径。
  delete f.pending.topics!.configuration_fingerprint; delete f.pending.topics!.point_hashes
  f.pending.topics!.fingerprint = ''
  await prepareTopics(f.root, f.pending, f.committed, options, undefined)
  expect(f.pending.manifest.topic_gaps).toContainEqual(expect.objectContaining({ topic_id: topic.id, kind: 'below-threshold' }))
  await writeJson(f.root, 'work/pending.json', f.pending)
  f.pending = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
  f.call.mockImplementation(f.original); f.topicRequests.splice(0)
  await prepareTopics(f.root, f.pending, f.committed, { ...options, retryGaps: true }, undefined)
  expect(f.topicRequests.some(request => request.input.topic_id === topic.id)).toBe(true)
})

it('主题状态比较不序列化原始向量和质心，仍保存非向量变化', async () => {
  const f = await pendingFixture()
  const version = await publishLibrary(f.root, f.pending), committed = await readVersion(f.root, version)
  f.pending.base_version = version
  f.pending.topics!.rewritten = []
  f.pending.topics!.state.next_topic_number += 1
  const stringify = JSON.stringify
  let stateComparisons = 0
  // 只监测真实主题状态的序列化入口，避免为字符串上限反例分配数 GB 内存。
  const guard = vi.spyOn(JSON, 'stringify').mockImplementation(((value: unknown, replacer?: never, space?: never) => {
    if (value && typeof value === 'object' && 'vectors' in value && 'topics' in value) {
      stateComparisons++
      expect(typeof replacer).toBe('function')
      const encoded = stringify(value, replacer, space)
      expect(encoded).not.toMatch(/"(?:vector|centroid)":/)
      return encoded
    }
    return stringify(value, replacer, space)
  }) as typeof JSON.stringify)
  const result = await prepareTopics(f.root, f.pending, committed, f.options, undefined)
  expect(result.changed).toBe(false)
  expect(guard).toHaveBeenCalled()
  expect(stateComparisons).toBeGreaterThanOrEqual(2)
  const saved = JSON.parse(await readFile(path.join(f.root, 'state/topics.json'), 'utf8'))
  expect(saved.next_topic_number).toBe(f.pending.topics!.state.next_topic_number)
  expect(storageJson(f.pending.topics!.state)).not.toMatch(/"(?:vector|centroid)":/)
})

it('主题模型身份和向量引用变化仍要求发布', async () => {
  const f = await pendingFixture()
  const version = await publishLibrary(f.root, f.pending), committed = await readVersion(f.root, version)
  f.pending.base_version = version
  f.pending.topics!.rewritten = []
  const embedding = f.pending.topics!.state.embedding
  embedding.model += '-new'
  expect((await prepareTopics(f.root, f.pending, committed, f.options, undefined)).changed).toBe(true)
  f.pending.topics!.state.embedding = structuredClone(committed.topics!.embedding)
  const id = Object.keys(committed.topics!.vectors)[0]!
  committed.topics!.vectors[id]!.vector_id = 'previous-vector-id'
  expect((await prepareTopics(f.root, f.pending, committed, f.options, undefined)).changed).toBe(true)
})

it('未受影响的失败子主题不因父主题包含相同成员而重试', async () => {
  const f = await thresholdFixture(), build = f.pending.topics!
  const child = { ...f.topic, id: f.topic.id + '-01', parent_id: f.topic.id, path: 'topics/' + f.topic.id + '/' + f.topic.id + '-01.md' }
  build.state.topics.push({ ...f.topic, direct_point_ids: [] }, child)
  build.retry_topics = [child]
  build.gaps = [{ topic_id: child.id, point_ids: child.point_ids, message: topicBelowThresholdMessage }]
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(f.topicRequests.some(request => request.input.topic_id === child.id)).toBe(false)
  expect(f.pending.manifest.topic_gaps).toContainEqual(expect.objectContaining({ topic_id: child.id, message: topicBelowThresholdMessage }))
})

it('仅移出成员的输入变化也清除旧门槛结论', async () => {
  const f = await thresholdFixture(), build = f.pending.topics!, removed = f.topic.point_ids[0]!
  build.state.excluded_members = { [f.topic.id]: { [removed]: { content_hash: '旧成员哈希', reason: '不同对象' } } }
  f.gap.point_ids = f.gap.point_ids.filter(id => id !== removed)
  build.retry_topics![0]!.point_ids = [...f.gap.point_ids]
  await changeExtraction(f, extraction => {
    for (const segment of extraction.segments) for (const point of segment.points) if (point.point_id === removed) point.text += '新条件'
  })
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(f.pending.manifest.topic_gaps?.some(gap => gap.topic_id === f.topic.id)).toBe(false)
})

it('显式重试遇成员变化或新主题接替时不恢复过期失败主题', async () => {
  const f = await thresholdFixture()
  await changeExtraction(f, extraction => {
    for (const segment of extraction.segments) for (const point of segment.points) if (f.topic.point_ids.includes(point.point_id)) point.text += '新条件'
  })
  await prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryGaps: true }, undefined)
  expect(f.pending.manifest.topic_gaps?.some(gap => gap.topic_id === f.topic.id)).toBe(false)
  expect(f.topicRequests.some(request => request.input.topic_id !== f.topic.id)).toBe(true)
  expect(f.topicRequests.some(request => request.input.topic_id === f.topic.id)).toBe(false)
  const replaced = await thresholdFixture()
  replaced.pending.topics!.state.topics.push({ ...replaced.topic, id: 'T-0003', path: 'topics/T-0003.md' })
  await prepareTopics(replaced.root, replaced.pending, replaced.committed, { ...replaced.options, retryGaps: true }, undefined)
  expect(replaced.topicRequests.some(request => request.input.topic_id === replaced.topic.id)).toBe(false)
  expect(replaced.pending.manifest.topic_gaps?.some(gap => gap.topic_id === replaced.topic.id)).toBe(false)
})

it('显式重试未变门槛缺口不被旧重建标记跳过', async () => {
  const f = await thresholdFixture()
  f.committed.rebuild_pages = [f.topic.path]
  await prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryGaps: true }, undefined)
  expect(f.topicRequests.some(request => request.input.topic_id === f.topic.id)).toBe(true)
  expect(f.pending.manifest.topic_gaps).toEqual([])
})
