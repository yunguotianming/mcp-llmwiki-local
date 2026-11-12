import { afterEach, expect, it, vi } from 'vitest'
import { prepareTopics } from '../src/layered/topics.js'
import { topicPath } from '../src/layered/schema.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'
import { pendingFixture } from './pipeline-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => { vi.useRealTimers(); cleanupLayeredFixtures() })

it('假时钟下快分支父页与慢主题重叠，三槽利用率由35.3%升至60%', async () => {
  const f = await pendingFixture(), build = f.pending.topics!
  const parent = build.state.topics.find(topic => topic.id === 'T-0001')!
  build.state.topics.push({ ...structuredClone(parent), id: 'T-0001-01', parent_id: parent.id, path: topicPath('T-0001-01') })
  parent.direct_point_ids = []; build.pages = {}; build.rewritten = []; build.gaps = []
  f.policy.pageGenerationConcurrency = 3
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(0)
  const leavesStarted = Promise.withResolvers<void>(), parentStarted = Promise.withResolvers<void>(), parentEnded = Promise.withResolvers<void>()
  const starts = new Map<string, number>(), ends = new Map<string, number>()
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (input.topic_id && !input.review_stage) {
      starts.set(input.topic_id, Date.now())
      const waiting = new Promise<void>(resolve => setTimeout(resolve, input.children ? 70 : input.topic_id === 'T-0002' ? 100 : 10))
      if (starts.has('T-0002') && starts.has('T-0001-01')) leavesStarted.resolve()
      if (input.children) parentStarted.resolve()
      await waiting
      ends.set(input.topic_id, Date.now())
      if (input.children) parentEnded.resolve()
    }
    return f.original(...args)
  })
  const running = prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  await leavesStarted.promise
  await vi.advanceTimersByTimeAsync(10); await parentStarted.promise
  expect(starts.get('T-0001')).toBe(10)
  await vi.advanceTimersByTimeAsync(70); await parentEnded.promise
  expect(ends.has('T-0002')).toBe(false)
  await vi.advanceTimersByTimeAsync(20); await running
  const elapsed = Math.max(...ends.values()), work = 100 + 10 + 70
  // 基线先等待全部叶页：max(100,10)+70；本次实测只等待所属子页。
  expect(elapsed).toBe(100)
  expect(work / (3 * (100 + 70))).toBeCloseTo(0.352941, 6)
  expect(work / (3 * elapsed)).toBe(0.6)
})
