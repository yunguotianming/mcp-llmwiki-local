import { mockSupportReview } from './layered-fixture.js'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareTopics } from '../src/layered/topics.js'
import { meteredOptions } from '../src/layered/costs.js'
import { writeJson } from '../src/layered/files.js'
import { publishLibrary, readLayeredPage } from '../src/layered/publication.js'
import type { PendingBuild } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, hydratedState } from './layered-fixture.js'
import { pendingFixture } from './pipeline-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

for (const failure of ['超时', '超限'] as const) it(`${failure}主题落盘后续做恢复原ID与全部成员，反复失败不积累缺口`, async () => {
  const f = await pendingFixture()
  await writeJson(f.root, 'work/pending.json', f.pending)
  f.pending = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
  const stable = structuredClone(f.pending.topics!.pages['topics/T-0002.md'])
  const ids = [...f.pending.topics!.state.topics.find(topic => topic.id === 'T-0001')!.point_ids]
  delete f.pending.topics!.pages['topics/T-0001.md']
  f.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
    if (failure === '超时') throw Object.assign(new Error('模型响应超时'), { name: 'TimeoutError' })
    const output = JSON.parse(await f.original(...args))
    output.conditions[0].text = '超限正文'.repeat(4000)
    return JSON.stringify(output)
  })
  let pending = f.pending
  const before = pending.topics!.model_calls, costBefore = pending.costs!.stages['主题']!.actual_calls
  for (let attempt = 0; attempt < 2; attempt++) {
    await prepareTopics(f.root, pending, f.committed, meteredOptions(f.root, pending, f.options), undefined)
    expect(pending.manifest.topic_gaps).toHaveLength(1)
    expect(pending.manifest.topic_gaps![0]).toMatchObject({ topic_id: 'T-0001', point_ids: ids })
    expect(pending.topics!.pages['topics/T-0002.md']).toEqual(stable)
    expect(pending.topics!.pages).not.toHaveProperty('topics/T-0001.md')
    await writeJson(f.root, 'work/pending.json', pending)
    pending = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
  }
  expect(pending.topics!.model_calls - before).toBe(2)
  expect(pending.costs!.stages['主题']!.actual_calls - costBefore).toBe(2)
  f.call.mockImplementation(f.original); f.topicRequests.splice(0)
  await prepareTopics(f.root, pending, f.committed, meteredOptions(f.root, pending, f.options), undefined)
  expect(f.topicRequests.map(request => request.input.topic_id)).toEqual(['T-0001'])
  expect(pending.manifest.topic_gaps).toEqual([])
  expect(pending.topics!.state.topics.find(topic => topic.id === 'T-0001')!.point_ids).toEqual(ids)
  expect(pending.topics!.pages['topics/T-0002.md']).toEqual(stable)
  const snapshot = JSON.stringify(pending.topics)
  await prepareTopics(f.root, pending, f.committed, f.options, undefined)
  expect(JSON.stringify(pending.topics)).toBe(snapshot)
  expect(f.topicRequests).toHaveLength(1)
  await publishLibrary(f.root, pending)
  expect(await readLayeredPage(f.knowledgeRoot, 'topics/T-0001.md')).toContain('甲组')
})

for (const [name, marker] of [['取消', { name: 'AbortError' }], ['预算暂停', { budgetPause: true }], ['文件权限错误', { code: 'EACCES' }]] as const) {
  it(`${name}保持向外传播且不伪装为主题缺口`, async () => {
    const f = await pendingFixture(), error = Object.assign(new Error(name), marker)
    delete f.pending.topics!.pages['topics/T-0001.md']
    f.call.mockRejectedValue(error)
    await expect(prepareTopics(f.root, f.pending, f.committed, f.options, undefined)).rejects.toBe(error)
    expect(f.pending.manifest.topic_gaps).toEqual([])
    expect(f.pending.topics!.state.topics.map(topic => topic.id)).toContain('T-0001')
  })
}
