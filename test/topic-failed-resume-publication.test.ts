import { readdir } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareTopics } from '../src/layered/topics.js'
import { publishLibrary, readCurrent } from '../src/layered/publication.js'
import { readVersion, versionPage } from '../src/layered/objects.js'
import { registerTopicReviewWindowRequest } from '../src/layered/topic-recovery.js'
import { topicPath } from '../src/layered/schema.js'
import type { PendingBuild } from '../src/layered/schema.js'
import { pendingFixture } from './pipeline-audit-fixture.js'
import { cleanupLayeredFixtures, hydratedState } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('发布树中残留无页主题时保留检查点并暂停，不以类型错误中止', async () => {
  const f = await pendingFixture(), topic = f.pending.topics!.state.topics[0]!
  delete f.pending.topics!.pages[topic.path]
  const current = await readCurrent(f.root)
  await expect(publishLibrary(f.root, f.pending)).rejects.toMatchObject({ stagePause: true, code: 'TOPIC_PAGE_MISSING' })
  expect(await readCurrent(f.root)).toEqual(current)
  expect(await readdir(f.root + '/versions')).toEqual([])
  const saved = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
  expect(saved.topics!.state.topics.some(item => item.id === topic.id)).toBe(true)
  expect(saved.topics!.pages[topic.path]).toBeUndefined()
})

it.each([false, true])('上一段失败目标不重发并从发布树和别名中剔除，显式续时=%s', async renew => {
  const f = await pendingFixture(), build = f.pending.topics!, [parent, stable] = build.state.topics
  const child = { ...structuredClone(parent!), id: parent!.id + '-01', parent_id: parent!.id, path: topicPath(parent!.id + '-01') }
  const active = { ...structuredClone(parent!), id: 'T-0099', path: topicPath('T-0099') }
  parent!.direct_point_ids = []; build.state.topics.push(child, active)
  delete build.pages[parent!.path]
  build.gaps = [child, active].map(topic => ({ topic_id: topic.id, point_ids: [...topic.point_ids], message: 'Connection error.' }))
  build.rewritten = []
  f.pending.runId = '原运行'
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    // 模拟旧版已隔离的非门槛失败；父页随之因全部子页失败而隔离。
    if (input.topic_id === child.id) throw new Error('主题核对未完成：返回缺少句子判定。')
    if (input.topic_id === active.id && input.review_stage) throw Object.assign(new Error('保存复核稿后暂停'), { budgetPause: true })
    return f.original(...args)
  })
  await expect(prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryTopics: { topicIds: [child.id, active.id] } }, undefined)).rejects.toThrow('保存复核稿后暂停')
  const pending = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
  const failedIds = [parent!.id, child.id]
  for (const id of failedIds) {
    expect(pending.topics!.state.topics.find(topic => topic.id === id)?.page_status).toBe('failed')
    expect(pending.topics!.pages[topicPath(id)]).toBeUndefined()
    expect(pending.topic_scope!.completed).toContain(id)
    expect(pending.topics!.gaps).toContainEqual(expect.objectContaining({ topic_id: id }))
    expect(pending.topics!.gaps!.filter(gap => gap.topic_id === id).every(gap => gap.kind !== 'below-threshold')).toBe(true)
  }
  expect(pending.topics!.state.topics.find(topic => topic.id === parent!.id)!.point_ids).toEqual([])
  const stablePage = structuredClone(pending.topics!.pages[stable!.path])
  pending.topics!.aliases = { 'T-0096': parent!.id, 'T-0097': child.id, 'T-0098': stable!.id }
  const retryTopics = { topicIds: [child.id, active.id], renewReviewWindow: true, requestId: '续时' }
  if (renew) {
    pending.topics!.repairs![active.id]!.deadline = 0
    expect(registerTopicReviewWindowRequest(pending, retryTopics).granted.map(grant => grant.topicId)).toEqual([active.id])
  }
  f.call.mockImplementation(f.original); f.call.mockClear(); f.topicRequests.splice(0)
  await prepareTopics(f.root, pending, f.committed, { ...f.options, ...(renew ? { retryTopics } : {}) }, undefined)
  expect(pending.topics!.state.topics.map(topic => topic.id)).toEqual([stable!.id, active.id])
  expect(pending.topics!.aliases).toEqual({ 'T-0098': stable!.id })
  expect(pending.topics!.pages[stable!.path]).toEqual(stablePage)
  expect(pending.topics!.state.topics.every(topic => topic.page_status === 'ready')).toBe(true)
  expect(f.call.mock.calls.length).toBeGreaterThan(0)
  expect(f.call.mock.calls.every(call => { const input = JSON.parse(call[2]); return input.topic_id === active.id && input.review_stage })).toBe(true)
  expect(f.topicRequests).toEqual([])
  const saved = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
  expect(saved.topics!.state.topics.map(topic => topic.id)).toEqual([stable!.id, active.id])
  if (renew) expect(saved.topic_scope!.review_windows!['续时']!.grants[active.id]!.status).toBe('consumed')
  await publishLibrary(f.root, pending)
  const published = await readVersion(f.root, pending.version!)
  expect(published.topics!.topics.map(topic => topic.id)).toEqual([stable!.id, active.id])
  expect(published.aliases).toEqual({ 'T-0098': stable!.id })
  expect(await versionPage(f.root, published, stable!.path)).toContain(stablePage!.content.slice(stablePage!.content.indexOf('\n# ')))
  for (const id of failedIds) {
    expect(published.pages![topicPath(id)]).toBeUndefined()
    expect(published.topic_gaps).toContainEqual(expect.objectContaining({ topic_id: id }))
    expect(published.topic_recovery!.topics.some(topic => topic.id === id)).toBe(true)
  }
})

it('定向恢复不剔除范围外尚未处理的缺页主题', async () => {
  const f = await pendingFixture(), build = f.pending.topics!, [target, stable] = build.state.topics
  const outside = { ...structuredClone(stable!), id: 'T-0099', path: topicPath('T-0099'), page_status: 'failed' as const }
  build.state.topics.push(outside)
  const outsideGap = { topic_id: outside.id, point_ids: [...outside.point_ids], message: 'Connection error.' }
  build.gaps = [{ topic_id: target!.id, point_ids: [...target!.point_ids], message: '删除未支撑句：需要新规则复核' }, outsideGap]
  f.call.mockClear()
  await prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryTopics: { topicIds: [target!.id] } }, undefined)
  expect(f.pending.topic_scope!.completed).not.toContain(outside.id)
  expect(f.pending.topics!.state.topics.find(topic => topic.id === outside.id)).toEqual(outside)
  expect(f.pending.topics!.gaps).toContainEqual(outsideGap)
  expect(f.call.mock.calls.every(call => JSON.parse(call[2]).topic_id === target!.id)).toBe(true)
  await expect(publishLibrary(f.root, f.pending)).rejects.toMatchObject({ stagePause: true, code: 'TOPIC_PAGE_MISSING' })
})
