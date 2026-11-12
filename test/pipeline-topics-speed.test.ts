import { afterEach, expect, it, vi } from 'vitest'
import { setImmediate } from 'node:timers/promises'
import { prepareTopics, topicBelowThresholdMessage } from '../src/layered/topics.js'
import { topicPath } from '../src/layered/schema.js'
import { writeJson } from '../src/layered/files.js'
import type { PendingBuild } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, hydratedState } from './layered-fixture.js'
import { pendingFixture, changeExtraction } from './pipeline-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => { vi.useRealTimers(); cleanupLayeredFixtures() })

async function tree() {
  const f = await pendingFixture(), build = f.pending.topics!
  const leaf = build.state.topics.find(topic => topic.id === 'T-0001')!
  const child = { ...structuredClone(leaf), id: 'T-0001-01', parent_id: leaf.id, path: topicPath('T-0001-01') }
  leaf.direct_point_ids = []
  build.state.topics.push(child); build.pages = {}; build.rewritten = []; build.gaps = []
  f.policy.pageGenerationConcurrency = 30
  f.call.mockClear(); f.topicRequests.splice(0)
  return f
}

it('慢主题不阻挡无关父页，父页读取已核对的子摘要', async () => {
  const f = await tree(), slow = Promise.withResolvers<void>(), parent = Promise.withResolvers<void>()
  const events: string[] = []
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (input.topic_id === 'T-0002' && !input.review_stage) { events.push('慢主题开始'); await slow.promise }
    const result = await f.original(...args)
    if (input.review_stage === 'topic') events.push('核对:' + input.topic_id)
    if (input.children) { events.push('父页开始'); parent.resolve() }
    return result
  })
  const work = prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  try {
    await parent.promise
    expect(events).toContain('慢主题开始')
    expect(events.indexOf('核对:T-0001-01')).toBeLessThan(events.indexOf('父页开始'))
    expect(f.pending.topics!.pages).not.toHaveProperty('topics/T-0002.md')
  } finally { slow.resolve(); await work }
})

it('失败续做只重跑失败子页及祖先，成功分支与再次续做零调用', async () => {
  const f = await tree()
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (input.topic_id === 'T-0001-01' && !input.review_stage) throw new Error('测试子页失败')
    return f.original(...args)
  })
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  await writeJson(f.root, 'work/pending.json', f.pending)
  f.pending = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
  const stable = structuredClone(f.pending.topics!.pages['topics/T-0002.md'])
  f.call.mockImplementation(f.original); f.call.mockClear(); f.topicRequests.splice(0)
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(f.topicRequests.map(request => request.input.topic_id)).toEqual(['T-0001-01', 'T-0001'])
  expect(f.pending.topics!.pages['topics/T-0002.md']).toEqual(stable)
  f.call.mockClear()
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(f.call).not.toHaveBeenCalled()
})

it('成员变化重算分支，父输入未变复用回执，提示版本变化使全部主题失效', async () => {
  const f = await tree()
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  const stable = structuredClone(f.pending.topics!.pages['topics/T-0002.md'])
  const parentContent = f.pending.topics!.pages['topics/T-0001.md']!.content
  await changeExtraction(f, extraction => {
    const point = extraction.segments.flatMap(segment => segment.points)[0]!
    point.text += '补充条件'
    // 模拟已核对的新提取成果，原文身份保持，由要点内容触发主题失效。
  })
  f.topicRequests.splice(0)
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  // 子页摘要未变，父页仍重新准备，但复用已通过校验的相同输入回执。
  expect(f.topicRequests.map(request => request.input.topic_id)).toEqual(['T-0001-01'])
  const parent = f.pending.topics!.pages['topics/T-0001.md']!
  expect(parent.content).not.toBe(parentContent)
  expect(parent.content.replace(/^input_fingerprint: .*\n/m, '')).toBe(parentContent.replace(/^input_fingerprint: .*\n/m, ''))
  expect(f.pending.topics!.pages['topics/T-0002.md']).toEqual(stable)
  f.topicRequests.splice(0)
  await prepareTopics(f.root, f.pending, f.committed, { ...f.options, promptVersion: '新版本' }, undefined)
  expect(f.topicRequests.length).toBeGreaterThanOrEqual(2)
  expect(f.topicRequests.some(request => request.input.points?.some(point => point.text.includes('补充条件')))).toBe(true)
})

it('核对删句诊断保留成功页与核对指纹，恢复不把诊断当作失败', async () => {
  const f = await pendingFixture(), topic = f.pending.topics!.state.topics[0]!
  f.pending.topics!.gaps = [{ topic_id: topic.id, point_ids: [...topic.point_ids], message: '删除未支撑句：已删除' }]
  const before = structuredClone(f.pending.topics!.pages)
  f.call.mockClear()
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(f.call).not.toHaveBeenCalled()
  expect(f.pending.topics!.pages).toEqual(before)
  expect(f.pending.manifest.topic_gaps).toHaveLength(1)
})

it('30、3、1路依赖派发乱序完成后的主题页面与依赖逐字节一致', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-10T00:00:00Z'))
  const outputs: string[] = []
  for (const cap of [30, 3, 1]) {
    const f = await tree(); f.policy.pageGenerationConcurrency = cap
    f.call.mockImplementation(async (...args) => {
      const input = JSON.parse(args[2])
      for (let i = 0; i < (input.topic_id === 'T-0002' ? 8 : 1); i++) await setImmediate()
      return f.original(...args)
    })
    await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
    outputs.push(JSON.stringify(f.pending.topics!.pages))
  }
  expect(outputs[1]).toBe(outputs[0]); expect(outputs[2]).toBe(outputs[0])
})

it('续做跳过“移出成员后来源数不足门槛”的缺口，不重发主题调用', async () => {
  const f = await pendingFixture(), topic = f.pending.topics!.state.topics[0]!
  // 缺口主题没有成功页；门槛结论由已记录的移出成员决定，重试必然相同。
  delete f.pending.topics!.pages[topic.path]
  f.pending.topics!.gaps = [{ topic_id: topic.id, point_ids: [...topic.point_ids], message: topicBelowThresholdMessage }]
  f.call.mockClear(); f.topicRequests.splice(0)
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(f.topicRequests.filter(request => request.input.topic_id === topic.id)).toHaveLength(0)
  expect(f.pending.manifest.topic_gaps?.some(gap => gap.topic_id === topic.id && gap.message === topicBelowThresholdMessage)).toBe(true)
})

it('续做仍重试原因有偶然性的缺口', async () => {
  const f = await pendingFixture(), topic = f.pending.topics!.state.topics[0]!
  delete f.pending.topics!.pages[topic.path]
  f.pending.topics!.gaps = [{ topic_id: topic.id, point_ids: [...topic.point_ids], message: '主题核对未完成：S1；核对协议缺口：该 ID 缺失、重复或判定格式错误。' }]
  f.call.mockClear(); f.topicRequests.splice(0)
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(f.topicRequests.some(request => request.input.topic_id === topic.id)).toBe(true)
})
