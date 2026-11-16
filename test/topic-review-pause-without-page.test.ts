import { afterEach, expect, it, vi } from 'vitest'
import { prepareTopics } from '../src/layered/topics.js'
import { topicPath } from '../src/layered/schema.js'
import { consumeTopicReviewWindow, registerTopicReviewWindowRequest, validateTopicRecoveryRequest } from '../src/layered/topic-recovery.js'
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

it('普通续跑不消费过期窗口，明确授时从首次实际续核起算且重复恢复沿用截止时刻', () => {
  const f = { topics: { repairs: { T: { protocol: 'p', input: 'i', evidence: 'e', content: '# T', member_ids: ['P'], stage: 'review', run_id: 'r', rounds: 1, total_rounds: 1, max_rounds: 6, deadline: 1000 } } } } as any
  const pending = { topic_scope: { targets: ['T'], completed: [], review_inputs: {} }, topics: f.topics } as any
  expect(registerTopicReviewWindowRequest(pending, { topicIds: ['T'] }, 2000).granted).toEqual([])
  const granted = registerTopicReviewWindowRequest(pending, { topicIds: ['T'], renewReviewWindow: true, requestId: 'req' }, 2000)
  expect(granted.granted[0]).toMatchObject({ topicId: 'T', originalDeadline: 1000, rounds: 1, totalRounds: 1, maxRounds: 6, regenerations: 0 })
  const first = consumeTopicReviewWindow(pending, 'T', { input: 'i', evidence: 'e', memberIds: ['P'] }, 3000)
  expect(first?.deadline).toBe(1203000)
  expect(consumeTopicReviewWindow(pending, 'T', { input: 'i', evidence: 'e', memberIds: ['P'] }, 4000)?.deadline).toBe(1203000)
})

it('授时请求重复登记只消费一次，轮次已满或绑定变化拒绝消费', () => {
  const make = (rounds = 1) => ({ topic_scope: { targets: ['T'], completed: [], review_inputs: {} }, topics: { repairs: { T: { protocol: 'p', input: 'i', evidence: 'e', content: '# T', member_ids: ['P'], stage: 'review', run_id: 'r', rounds, total_rounds: rounds, max_rounds: 6, deadline: 1000 } } } } as any)
  const pending = make(); registerTopicReviewWindowRequest(pending, { topicIds: ['T'], renewReviewWindow: true, requestId: 'req' }, 2000); registerTopicReviewWindowRequest(pending, { topicIds: ['T'], renewReviewWindow: true, requestId: 'req' }, 2000)
  expect(Object.keys(pending.topic_scope.review_windows)).toHaveLength(1)
  expect(consumeTopicReviewWindow(pending, 'T', { input: 'changed', evidence: 'e', memberIds: ['P'] }, 3000)).toBeUndefined()
  const full = make(6); registerTopicReviewWindowRequest(full, { topicIds: ['T'], renewReviewWindow: true, requestId: 'full' }, 2000)
  expect(consumeTopicReviewWindow(full, 'T', { input: 'i', evidence: 'e', memberIds: ['P'] }, 3000)).toBeUndefined()
})

it('授时意图要求非空 topicIds，且不影响未选中目标', () => {
  expect(() => validateTopicRecoveryRequest({ renewReviewWindow: true })).toThrow(/topicIds/)
  const pending = { topic_scope: { targets: ['T'], completed: [], review_inputs: {} }, topics: { repairs: {} } } as any
  const result = registerTopicReviewWindowRequest(pending, { topicIds: ['X'], renewReviewWindow: true, requestId: 'x' }, 2000)
  expect(result.granted).toEqual([]); expect(result.skipped[0]?.reason).toContain('未被当前恢复范围选中')
})

it('授时结果在消费后返回固定起止时刻与保留计数', () => {
  const pending = { topic_scope: { targets: ['T'], completed: [], review_inputs: {} }, topics: { repairs: { T: { protocol: 'p', input: 'i', evidence: 'e', content: '# T', member_ids: ['P'], stage: 'review', run_id: 'r', rounds: 2, total_rounds: 4, max_rounds: 6, deadline: 1000, regenerations: 3 } } } } as any
  registerTopicReviewWindowRequest(pending, { topicIds: ['T'], renewReviewWindow: true, requestId: 'result' }, 2000)
  consumeTopicReviewWindow(pending, 'T', { input: 'i', evidence: 'e', memberIds: ['P'] }, 3000)
  const grant = pending.topic_scope.review_windows.result.grants.T
  expect(grant).toMatchObject({ original_deadline: 1000, started_at: 3000, deadline: 1203000, rounds: 2, total_rounds: 4, max_rounds: 6, regenerations: 3 })
})

it('输入、证据或成员绑定变化时拒绝消费且保留原期限', () => {
  const pending = { topic_scope: { targets: ['T'], completed: [], review_inputs: {} }, topics: { repairs: { T: { protocol: 'p', input: 'i', evidence: 'e', content: '# T', member_ids: ['P'], stage: 'review', run_id: 'r', rounds: 1, total_rounds: 1, max_rounds: 6, deadline: 1000 } } } } as any
  registerTopicReviewWindowRequest(pending, { topicIds: ['T'], renewReviewWindow: true, requestId: 'binding' }, 2000)
  expect(consumeTopicReviewWindow(pending, 'T', { input: 'i', evidence: 'changed', memberIds: ['P'] }, 3000)).toBeUndefined()
  expect(pending.topics.repairs.T.deadline).toBe(1000)
  expect(pending.topic_scope.review_windows.binding.grants.T.reason).toContain('绑定已变化')
})

it('明确授时后过期修复稿在新窗口内续核：派发核对、保留计数且消费即落盘', async () => {
  const f = await interrupted(), repair = f.pending.topics!.repairs![f.child.id]!
  repair.deadline = 0
  const before = structuredClone(repair)
  registerTopicReviewWindowRequest(f.pending, { topicIds: [f.child.id], renewReviewWindow: true, requestId: '续时' })
  f.call.mockImplementation(f.original); f.call.mockClear(); f.topicRequests.splice(0)
  const started = Date.now()
  // 主题范围已持久；授时登记后按原范围续跑（与上方期限耗尽用例相同的入口）。
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  const grant = f.pending.topic_scope!.review_windows!['续时']!.grants[f.child.id]!
  expect(grant).toMatchObject({ status: 'consumed', original_deadline: 0, rounds: before.rounds, total_rounds: before.total_rounds, max_rounds: before.max_rounds })
  expect(grant.started_at!).toBeGreaterThanOrEqual(started)
  expect(grant.deadline! - grant.started_at!).toBe(20 * 60 * 1000)
  expect(f.call.mock.calls.some(call => { const input = JSON.parse(call[2]); return input.topic_id === f.child.id && input.review_stage })).toBe(true)
  const saved = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
  expect(saved.topic_scope!.review_windows!['续时']!.grants[f.child.id]).toMatchObject({ status: 'consumed', deadline: grant.deadline })
})
