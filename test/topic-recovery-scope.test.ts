import { afterEach, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import { prepareTopics, topicHeader } from '../src/layered/topics.js'
import { selectTopicGaps } from '../src/layered/topic-recovery.js'
import { hash } from '../src/layered/files.js'
import { putPage } from '../src/layered/objects.js'
import { topicPath } from '../src/layered/schema.js'
import type { PendingBuild, Topic, TopicBuild } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, hydratedState } from './layered-fixture.js'
import { pendingFixture, changeExtraction } from './pipeline-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

async function oldPage(root: string, build: TopicBuild, topic: Topic, verified = true) {
  const page = build.pages[topic.path]!, generation = hash('旧写作协议的实际生产身份')
  const fingerprint = hash(JSON.stringify(['topic-input-v2', generation, topic.id, topic.path,
    [...topic.point_ids].sort().map(id => [id, build.point_hashes![id]]), []]))
  const header = { ...topicHeader(page.content), generation_hash: generation, input_fingerprint: verified ? fingerprint : hash('无法验证的旧算法') }
  page.content = page.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, `---\n${stringify(header).trimEnd()}\n---\n`)
  page.input_fingerprint = header.input_fingerprint
  delete page.dependencies.review
  Object.assign(page, { content_id: await putPage(root, page.content) })
  return structuredClone(page)
}

it('显式空主题和未命中筛选为零任务，空对象仍选择全部', async () => {
  const f = await pendingFixture(), topic = f.pending.topics!.state.topics[0]!
  f.pending.topics!.gaps = [{ topic_id: topic.id, point_ids: topic.point_ids, message: '删除未支撑句：审计' }]
  expect(selectTopicGaps(f.pending.manifest, f.pending.topics, { topicIds: [] })).toEqual([])
  expect(selectTopicGaps(f.pending.manifest, f.pending.topics, {})).toHaveLength(1)
  const before = structuredClone(f.pending.topics!.pages)
  f.call.mockClear()
  await prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryTopics: { topicIds: [] } }, undefined)
  await prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryTopics: { topicIds: ['T-不存在'] } }, undefined)
  expect(f.call).not.toHaveBeenCalled()
  expect(f.pending.topics!.pages).toEqual(before)
})

it('定向缺页只生成所选主题，范围外旧页依赖及其他缺口逐字保持', async () => {
  const f = await pendingFixture(), build = f.pending.topics!, [target, other] = build.state.topics
  const stable = await oldPage(f.root, build, other!)
  const missing = { ...structuredClone(other!), id: 'T-0099', path: topicPath('T-0099') }
  build.state.topics.push(missing)
  delete build.pages[target!.path]
  const outsideGap = { topic_id: missing.id, point_ids: missing.point_ids, message: 'Connection error.' }
  build.gaps = [{ topic_id: target!.id, point_ids: target!.point_ids, message: 'Connection error.' }, outsideGap]
  f.call.mockClear(); f.topicRequests.splice(0)
  await prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryTopics: { topicIds: [target!.id] } }, undefined)
  expect(f.topicRequests.map(request => request.input.topic_id)).toEqual([target!.id])
  expect(f.pending.topics!.pages[other!.path]).toEqual(stable)
  expect(f.pending.topics!.gaps).toContainEqual(outsideGap)
  expect(f.call.mock.calls.every(call => JSON.parse(call[2]).topic_id === target!.id)).toBe(true)
})

it('可验证旧正文只做新核对，原生成身份及输入指纹保持', async () => {
  const f = await pendingFixture(), build = f.pending.topics!, [target, other] = build.state.topics
  const old = await oldPage(f.root, build, target!), stable = await oldPage(f.root, build, other!)
  build.gaps = [{ topic_id: target!.id, point_ids: target!.point_ids, message: '删除未支撑句：需要新规则复核' }]
  f.call.mockClear(); f.topicRequests.splice(0)
  await prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryTopics: { topicIds: [target!.id] } }, undefined)
  const page = f.pending.topics!.pages[target!.path]!
  expect(f.topicRequests).toEqual([])
  expect(f.call.mock.calls.length).toBeGreaterThan(0)
  expect(f.call.mock.calls.every(call => JSON.parse(call[2]).review_stage)).toBe(true)
  expect(topicHeader(page.content).generation_hash).toBe(topicHeader(old.content).generation_hash)
  expect(topicHeader(page.content).input_fingerprint).toBe(topicHeader(old.content).input_fingerprint)
  expect(page.dependencies.review).toBeDefined()
  expect(f.pending.topics!.pages[other!.path]).toEqual(stable)
})

it('定向暂停后无名单续跑承接原范围，不重复已完成目标', async () => {
  const f = await pendingFixture(), build = f.pending.topics!, [first, second] = build.state.topics
  const extra = { ...structuredClone(second!), id: 'T-0099', path: topicPath('T-0099') }
  build.state.topics.push(extra)
  for (const topic of [first!, second!, extra]) delete build.pages[topic.path]
  build.gaps = [first!, second!, extra].map(topic => ({ topic_id: topic.id, point_ids: topic.point_ids, message: 'Connection error.' }))
  f.policy.pageGenerationConcurrency = 1
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (input.topic_id === second!.id) throw Object.assign(new Error('测试预算暂停'), { budgetPause: true })
    return f.original(...args)
  })
  await expect(prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryTopics: { topicIds: [first!.id, second!.id] } }, undefined)).rejects.toThrow('测试预算暂停')
  const stable = structuredClone(f.pending.topics!.pages[first!.path])
  f.pending = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
  f.call.mockImplementation(f.original); f.call.mockClear(); f.topicRequests.splice(0)
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(f.topicRequests.map(request => request.input.topic_id)).toEqual([second!.id])
  expect(f.pending.topics!.pages[first!.path]?.content).toBe(stable?.content)
  expect(f.pending.topics!.pages[first!.path]?.dependencies).toEqual(stable?.dependencies)
  expect(f.call.mock.calls.every(call => JSON.parse(call[2]).topic_id === second!.id)).toBe(true)
})

it('范围外真实成员变化在模型派发或删页前暂停', async () => {
  const f = await pendingFixture(), build = f.pending.topics!, target = build.state.topics[1]!
  build.gaps = [{ topic_id: target.id, point_ids: target.point_ids, message: '删除未支撑句：复核' }]
  const before = structuredClone(build.pages)
  await changeExtraction(f, extraction => { extraction.segments.flatMap(segment => segment.points)[0]!.text += '真实新事实。' })
  f.call.mockClear()
  await expect(prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryTopics: { topicIds: [target.id] } }, undefined)).rejects.toThrow(/范围|资料.*变化/)
  expect(f.call).not.toHaveBeenCalled()
  expect(build.pages).toEqual(before)
})
