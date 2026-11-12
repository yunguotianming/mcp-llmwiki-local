import { mockSupportReview } from './layered-fixture.js'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareTopics } from '../src/layered/topics.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'
import { pendingFixture } from './pipeline-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('C06 初次输出结构无效也不能借纠正改写已给出的主张', async () => {
  const f = await pendingFixture()
  delete f.pending.topics!.pages['topics/T-0001.md']
  let count = 0
  f.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
    const value = JSON.parse(await f.original(...args))
    if (++count === 1) value.aliases = ['甲', '乙', '丙', '丁', '戊', '己']
    else value.conditions[0].text = '纠正过程中换掉原主张'
    return JSON.stringify(value)
  })
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect.soft(f.pending.manifest.topic_gaps).toHaveLength(1)
  expect(f.pending.topics!.pages).not.toHaveProperty('topics/T-0001.md')
})

it('C07 单主题模型超时只记缺口，其他主题继续', async () => {
  const f = await pendingFixture()
  f.pending.topics!.pages = {}
  f.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
    if (JSON.parse(args[2]).topic_id === 'T-0001') throw Object.assign(new Error('模型响应超时'), { name: 'TimeoutError' })
    return f.original(...args)
  })
  await expect(prepareTopics(f.root, f.pending, f.committed, f.options, undefined)).resolves.toBeDefined()
  expect(f.pending.manifest.topic_gaps).toHaveLength(1)
  expect(f.pending.topics!.pages).toHaveProperty('topics/T-0002.md')
})

it('C08 单主题生成正文超限且不足拆分来源时只记缺口', async () => {
  const f = await pendingFixture()
  delete f.pending.topics!.pages['topics/T-0001.md']
  f.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
    const value = JSON.parse(await f.original(...args)); value.conditions[0].text = '超限正文'.repeat(4000); return JSON.stringify(value)
  })
  await expect(prepareTopics(f.root, f.pending, f.committed, f.options, undefined)).resolves.toBeDefined()
  expect(f.pending.manifest.topic_gaps).toHaveLength(1)
})
