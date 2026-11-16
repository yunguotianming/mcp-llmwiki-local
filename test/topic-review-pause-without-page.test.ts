import { afterEach, expect, it, vi } from 'vitest'
import { prepareTopics } from '../src/layered/topics.js'
import { topicPath } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, hydratedState } from './layered-fixture.js'
import { pendingFixture } from './pipeline-audit-fixture.js'
import type { PendingBuild } from '../src/layered/schema.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

async function interrupted() {
  const f = await pendingFixture(), build = f.pending.topics!, parent = build.state.topics[0]!
  const child = { ...structuredClone(parent), id: parent.id + '-01', parent_id: parent.id, path: topicPath(parent.id + '-01') }
  parent.direct_point_ids = []; build.state.topics.push(child); build.pages = {}; build.gaps = []; build.rewritten = []
  build.gaps = [{ topic_id: child.id, point_ids: child.point_ids, message: 'Connection error.' }]
  f.pending.runId = '原运行'
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (input.topic_id === child.id && input.review_stage) throw Object.assign(new Error('保存复核稿后暂停'), { budgetPause: true })
    return f.original(...args)
  })
  await expect(prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryTopics: { topicIds: [child.id] } }, undefined)).rejects.toThrow('保存复核稿后暂停')
  f.pending = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
  expect(f.pending.topics!.pages[child.path]).toBeUndefined()
  expect(f.pending.topics!.repairs?.[child.id]).toBeDefined()
  return { ...f, child, parent }
}

it.each(['期限', '轮次'])('无旧页修复稿的%s耗尽时保持暂停，不计完成或释放父链', async kind => {
  const f = await interrupted(), repair = f.pending.topics!.repairs![f.child.id]!
  if (kind === '期限') repair.deadline = 0
  else repair.rounds = repair.max_rounds
  const before = structuredClone(repair), completed = [...f.pending.topic_scope!.completed]
  const accepted = structuredClone(f.pending.acceptedRefs), calls = f.pending.topics!.model_calls
  f.call.mockImplementation(f.original); f.call.mockClear(); f.topicRequests.splice(0)
  await expect(prepareTopics(f.root, f.pending, f.committed, f.options, undefined)).rejects.toMatchObject({ stagePause: true, code: 'TOPIC_REVIEW_INCOMPLETE' })
  expect(f.call).not.toHaveBeenCalled()
  expect(f.pending.topic_scope!.completed).toEqual(completed)
  expect(f.pending.topics!.model_calls).toBe(calls)
  expect(f.pending.acceptedRefs).toEqual(accepted)
  expect(f.pending.topics!.repairs![f.child.id]).toMatchObject({ content: before.content, evidence: before.evidence, input: before.input,
    member_ids: before.member_ids, run_id: before.run_id, rounds: before.rounds, total_rounds: before.total_rounds,
    deadline: before.deadline, reason: expect.stringContaining('预算耗尽') })
  expect(f.pending.topics!.state.topics.find(topic => topic.id === f.child.id)?.page_status).not.toBe('failed')
  const saved = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
  expect(saved.topic_scope!.completed).toEqual(completed)
  expect(saved.topics!.repairs![f.child.id]!.deadline).toBe(before.deadline)
})

it('无旧页修复稿遇到协议缺项时保留当前稿与证据，不转失败或调用父页', async () => {
  const f = await interrupted(), before = structuredClone(f.pending.topics!.repairs![f.child.id]!)
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (input.topic_id === f.child.id && input.review_stage) return JSON.stringify({ items: [] })
    return f.original(...args)
  })
  f.call.mockClear(); f.topicRequests.splice(0)
  await expect(prepareTopics(f.root, f.pending, f.committed, f.options, undefined)).rejects.toMatchObject({ stagePause: true, code: 'TOPIC_REVIEW_INCOMPLETE' })
  expect(f.call.mock.calls.every(call => JSON.parse(call[2]).topic_id === f.child.id)).toBe(true)
  expect(f.pending.topic_scope!.completed).not.toContain(f.child.id)
  expect(f.pending.topics!.repairs![f.child.id]).toMatchObject({ content: before.content, evidence: before.evidence, deadline: before.deadline, run_id: before.run_id })
  expect(f.pending.topics!.gaps).toContainEqual(expect.objectContaining({ topic_id: f.child.id, stage: 'review', effect: '整页阻塞' }))
})
