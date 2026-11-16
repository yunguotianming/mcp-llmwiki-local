import { afterEach, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import { prepareTopics, topicHeader, topicInputFingerprint } from '../src/layered/topics.js'
import { hash, writeJson } from '../src/layered/files.js'
import { putPage } from '../src/layered/objects.js'
import { topicPath } from '../src/layered/schema.js'
import type { PendingBuild, Topic } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, hydratedState } from './layered-fixture.js'
import { pendingFixture, changeExtraction } from './pipeline-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

async function sealOld(f: Awaited<ReturnType<typeof pendingFixture>>, topic: Topic, known = true) {
  const build = f.pending.topics!, page = build.pages[topic.path]!, generation = hash('旧生成归属')
  const header = { ...topicHeader(page.content), generation_hash: generation,
    input_fingerprint: known ? topicInputFingerprint(topic, build.state, build.point_hashes!, generation) : hash('未知输入算法') }
  delete header.generation_input_fingerprint
  page.content = page.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, `---\n${stringify(header).trimEnd()}\n---\n`)
  page.input_fingerprint = header.input_fingerprint
  delete page.generation_input_fingerprint; delete page.dependencies.review
  Object.assign(page, { content_id: await putPage(f.root, page.content) })
  return structuredClone(page)
}

async function tree() {
  const f = await pendingFixture(), build = f.pending.topics!, parent = build.state.topics[0]!
  const child = { ...structuredClone(parent), id: parent.id + '-01', parent_id: parent.id, path: topicPath(parent.id + '-01') }
  parent.direct_point_ids = []; build.state.topics.push(child); build.pages = {}; build.gaps = []; build.rewritten = []
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  return { ...f, parent: f.pending.topics!.state.topics.find(topic => topic.id === parent.id)!, child: f.pending.topics!.state.topics.find(topic => topic.id === child.id)! }
}

it('旧页核对协议未完成保留原字节依赖归属，续跑真正补核后才释放父链', async () => {
  const f = await tree(), old = await sealOld(f, f.child), parent = await sealOld(f, f.parent)
  f.pending.topics!.gaps = [{ topic_id: f.child.id, point_ids: f.child.point_ids, message: '删除未支撑句：需要补核' }]
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (input.topic_id === f.child.id && input.review_stage) return JSON.stringify(input.review_stage === 'topic-correction' ? { sentences: [] } : { items: [] })
    return f.original(...args)
  })
  f.call.mockClear(); f.topicRequests.splice(0)
  await expect(prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryTopics: { topicIds: [f.child.id] } }, undefined)).rejects.toMatchObject({ code: 'TOPIC_REVIEW_INCOMPLETE' })
  expect(f.pending.topics!.pages[f.child.path]).toEqual(old)
  expect(f.pending.topics!.pages[f.parent.path]).toEqual(parent)
  expect(f.pending.topic_scope!.completed).not.toContain(f.child.id)
  expect(f.call.mock.calls.every(call => JSON.parse(call[2]).topic_id === f.child.id)).toBe(true)
  f.pending = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
  f.call.mockImplementation(f.original); f.call.mockClear()
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(f.call.mock.calls.some(call => JSON.parse(call[2]).topic_id === f.child.id && JSON.parse(call[2]).review_stage === 'topic')).toBe(true)
  expect(f.topicRequests).toEqual([])
  expect(f.pending.topic_scope!.completed).toContain(f.child.id)
})

it('旧页明确语义不支撑不回退为新核对通过，删空使用原有界重生成', async () => {
  const f = await pendingFixture(), topic = f.pending.topics!.state.topics[0]!
  await sealOld(f, topic)
  f.pending.topics!.gaps = [{ topic_id: topic.id, point_ids: topic.point_ids, message: '删除未支撑句：需要复核' }]
  let generations = 0
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (input.topic_id !== topic.id) return f.original(...args)
    if (!input.review_stage) { generations++; return f.original(...args) }
    if (input.review_stage === 'topic-correction') return JSON.stringify({ sentences: [] })
    return JSON.stringify({ items: input.sentences.map((sentence: any) => ({ id: sentence.id,
      support: sentence.text.startsWith('# ') || sentence.text.startsWith('范围：') ? '完整支撑' : '不支撑',
      missing: sentence.text.startsWith('# ') || sentence.text.startsWith('范围：') ? null : '成员证据明确不支持' })) })
  })
  await prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryTopics: { topicIds: [topic.id] } }, undefined)
  expect(generations).toBe(2)
  expect(f.pending.topics!.pages[topic.path]).toBeUndefined()
  expect(f.pending.topics!.repairs![topic.id]!.stage).toBe('generate')
  expect(f.pending.topics!.gaps?.find(gap => gap.topic_id === topic.id)?.message).toContain('重生成预算耗尽')
  f.call.mockClear()
  await prepareTopics(f.root, f.pending, f.committed, { ...f.options, runId: '更换运行仍沿用累计额度' } as typeof f.options, undefined)
  expect(f.call).not.toHaveBeenCalled()
})

it('未知旧输入算法仅在所选主题重生成，范围外字节保持', async () => {
  const f = await pendingFixture(), [target, other] = f.pending.topics!.state.topics
  await sealOld(f, target!, false)
  const stable = await sealOld(f, other!)
  f.pending.topics!.gaps = [{ topic_id: target!.id, point_ids: target!.point_ids, message: '删除未支撑句：需复核' }]
  f.call.mockClear(); f.topicRequests.splice(0)
  await prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryTopics: { topicIds: [target!.id] } }, undefined)
  expect(f.topicRequests.map(request => request.input.topic_id)).toEqual([target!.id])
  expect(f.pending.topics!.pages[other!.path]).toEqual(stable)
  expect(topicHeader(f.pending.topics!.pages[target!.path]!.content).generation_hash).not.toBe(hash('旧生成归属'))
})

it('追加目标保留已完成成果与累计额度，祖先按变化后的子摘要重综合', async () => {
  const f = await tree(), other = f.pending.topics!.state.topics.find(topic => topic.id === 'T-0002')!
  const first = await sealOld(f, other), oldParent = await sealOld(f, f.parent)
  await sealOld(f, f.child, false)
  f.pending.topics!.gaps = [{ topic_id: other.id, point_ids: other.point_ids, message: '删除未支撑句：先核对' },
    { topic_id: f.child.id, point_ids: f.child.point_ids, message: '删除未支撑句：后核对' }]
  await prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryTopics: { topicIds: [other.id] } }, undefined)
  const accepted = structuredClone(f.pending.topics!.pages[other.path])
  await changeExtraction(f, value => { value.segments.flatMap(segment => segment.points)[0]!.text += '新目标真实输入变化。' })
  f.call.mockClear(); f.topicRequests.splice(0)
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2]), raw = await f.original(...args)
    if (input.topic_id !== f.child.id || input.review_stage) return raw
    return JSON.stringify({ ...JSON.parse(raw), summary: '更新后的实际子摘要' })
  })
  await prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryTopics: { topicIds: [f.child.id] } }, undefined)
  expect(f.topicRequests.map(request => request.input.topic_id)).toEqual([f.child.id, f.parent.id])
  expect(f.pending.topics!.pages[other.path]).toEqual(accepted)
  expect(f.pending.topic_scope!.targets.sort()).toEqual([other.id, f.child.id].sort())
  expect(f.pending.topics!.repairs?.[other.id]).toBeUndefined()
  expect(topicHeader(f.pending.topics!.pages[f.parent.path]!.content).generation_hash).not.toBe(topicHeader(oldParent.content).generation_hash)
  expect(topicHeader(first.content).generation_hash).toBe(hash('旧生成归属'))
})

it('子证据变化但标题摘要相同只重核父页，父页生成身份与正文保留', async () => {
  const f = await tree(), parent = await sealOld(f, f.parent)
  await sealOld(f, f.child)
  f.pending.topics!.gaps = [{ topic_id: f.child.id, point_ids: f.child.point_ids, message: '删除未支撑句：需要复核' }]
  await prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryTopics: { topicIds: [f.child.id] } }, undefined)
  f.pending.topic_scope!.completed = f.pending.topic_scope!.completed.filter(id => id !== f.child.id)
  await changeExtraction(f, value => { value.segments.flatMap(segment => segment.points)[0]!.text += '新增可核对限定。' })
  f.call.mockClear(); f.topicRequests.splice(0)
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(f.topicRequests.map(request => request.input.topic_id)).toEqual([f.child.id])
  expect(f.call.mock.calls.some(call => JSON.parse(call[2]).topic_id === f.parent.id && JSON.parse(call[2]).review_stage)).toBe(true)
  expect(topicHeader(f.pending.topics!.pages[f.parent.path]!.content).generation_hash).toBe(topicHeader(parent.content).generation_hash)
  expect(f.pending.topics!.pages[f.parent.path]!.content.split('\n---\n').slice(1).join('\n---\n')).toBe(parent.content.split('\n---\n').slice(1).join('\n---\n'))
})
