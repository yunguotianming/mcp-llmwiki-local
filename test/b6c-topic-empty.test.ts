import { afterEach, expect, it, vi } from 'vitest'
import { prepareTopics } from '../src/layered/topics.js'
import { pendingFixture } from './pipeline-audit-fixture.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it.each([false, true])('核对删空后的重生成完整核对并持久化额度：持续无据=%s', async persistent => {
  const f = await pendingFixture(), topic = f.pending.topics!.state.topics[0]!
  delete f.pending.topics!.pages[topic.path]
  let generations = 0
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (input.topic_id !== topic.id) return f.original(...args)
    if (!input.review_stage) { generations++; return f.original(...args) }
    if (input.review_stage === 'topic-correction') return JSON.stringify({ sentences: [] })
    if (persistent || generations === 1) return JSON.stringify({ items: input.sentences.map((sentence: any) => ({
      id: sentence.id, support: sentence.text.startsWith('# ') || sentence.text.startsWith('范围：') ? '完整支撑' : '不支撑',
      missing: sentence.text.startsWith('# ') || sentence.text.startsWith('范围：') ? null : '没有成员证据',
    })) })
    return f.original(...args)
  })
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(generations).toBe(persistent ? 3 : 2)
  if (!persistent) {
    expect(f.pending.topics!.pages[topic.path]?.dependencies.claims?.every(claim => claim.point_ids.length)).toBe(true)
    expect(f.pending.manifest.topic_gaps).toEqual([])
    return
  }
  expect(f.pending.topics!.pages[topic.path]).toBeUndefined()
  expect(f.pending.topics!.repairs?.[topic.id]?.stage).toBe('generate')
  expect(f.pending.manifest.topic_recovery?.repairs[topic.id]?.regenerations).toBe(3)
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(generations).toBe(3)
})
