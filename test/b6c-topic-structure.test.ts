import { afterEach, expect, it, vi } from 'vitest'
import { prepareTopics } from '../src/layered/topics.js'
import { topicPath } from '../src/layered/schema.js'
import { pendingFixture } from './pipeline-audit-fixture.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => cleanupLayeredFixtures())

it.each(['移出引用', '空正文', '引用纠正改字', '语法纠正改字'])('%s失败稿作废后有界重生成并完整核对', async mode => {
  const f = await pendingFixture(), topic = f.pending.topics!.state.topics[0]!
  delete f.pending.topics!.pages[topic.path]
  let attempts = 0
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (input.topic_id !== topic.id || input.review_stage) return f.original(...args)
    attempts++
    const good = JSON.parse(await f.original(...args))
    if (input.regeneration) return JSON.stringify(good)
    if (mode === '语法纠正改字' && attempts === 1) return '{"title":"冻结标题","summary":"冻结范围","conditions":['
    if (mode === '空正文') return JSON.stringify({ ...good, consensus: [], differences: [], conditions: [] })
    if (mode === '引用纠正改字' && attempts === 1) good.conditions[0].point_ids = ['不属于输入']
    else if (mode === '引用纠正改字' || mode === '语法纠正改字') good.title = '纠正不能偷改标题'
    if (mode === '移出引用') good.removed_members = [{ point_id: good.conditions[0].point_ids[0], reason: '不属于同一问题' }]
    return JSON.stringify(good)
  })
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(attempts).toBeLessThanOrEqual(3)
  expect(attempts).toBeGreaterThan(1)
  const page = f.pending.topics!.pages[topic.path]!
  expect(page).toBeDefined()
  expect(page.content).not.toContain('纠正不能偷改标题')
  expect(page.dependencies.review).toBeDefined()
  expect(page.dependencies.claims!.length).toBeGreaterThan(0)
  expect(page.dependencies.claims!.every(claim => claim.point_ids.length && claim.point_ids.every(id => topic.point_ids.includes(id)))).toBe(true)
})

it('父共识不足两子页时重生成，单子页事实进入条件并保留子页绑定', async () => {
  const f = await pendingFixture(), parent = f.pending.topics!.state.topics[0]!
  const child = { ...structuredClone(parent), id: parent.id + '-01', parent_id: parent.id, path: topicPath(parent.id + '-01') }
  parent.direct_point_ids = []; f.pending.topics!.state.topics.push(child); delete f.pending.topics!.pages[parent.path]
  let attempts = 0
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2]), raw = await f.original(...args)
    if (!input.children) return raw
    attempts++
    if (attempts > 1) return raw
    const output = JSON.parse(raw)
    output.consensus = output.conditions; output.conditions = []
    return JSON.stringify(output)
  })
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(attempts).toBe(2)
  const page = f.pending.topics!.pages[parent.path]!
  expect(page.dependencies.claims!.some(claim => claim.child_ids?.includes(child.id))).toBe(true)
  expect(page.dependencies.review).toBeDefined()
})
