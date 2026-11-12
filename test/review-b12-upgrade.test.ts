import { afterEach, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { topicReviewVersion } from '../src/layered/topic-review.js'
import { reviewPromptHash } from '../src/layered/review.js'
import { cleanupLayeredFixtures, layeredTopicFixture, snapshotManifest } from './layered-fixture.js'

const revision = vi.hoisted(() => ({ suffix: '' }))
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
vi.mock('../src/llm/protocol.js', async original => {
  const protocol = await original<typeof import('../src/llm/protocol.js')>()
  return { ...protocol, jsonProtocol: (...args: Parameters<typeof protocol.jsonProtocol>) => protocol.jsonProtocol(...args)
    + (args[0].startsWith('主题核对：') ? revision.suffix : '') }
})
afterEach(() => { revision.suffix = ''; cleanupLayeredFixtures() })

it('B12 开启主题核对的已发布库升级护栏后普通增量零调用且版本不变', async () => {
  const f = await layeredTopicFixture()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 资料\n\n甲组研究采用访谈。')
  f.options.topics = { ...f.options.topics || {}, topicReview: true }
  await buildLayeredLibrary(f.options)
  const before = await snapshotManifest(f.root)
  expect(before.topics!.topics.length).toBeGreaterThan(0)
  expect(Object.entries(before.deps!.pages).some(([name, dep]) => name.startsWith('topics/') && dep.review)).toBe(true)
  revision.suffix = '\n升级最终句核对规则。'
  vi.resetModules()
  const changed = await import('../src/layered/topic-review.js')
  const extraction = await import('../src/layered/review.js')
  expect(changed.topicReviewVersion).not.toBe(topicReviewVersion)
  expect(extraction.reviewPromptHash()).toBe(reviewPromptHash())
  const upgraded = await import('../src/layered/index.js')
  f.call.mockClear(); f.embed.mockClear()
  const result = await upgraded.buildLayeredLibrary(f.options)
  expect(result).toMatchObject({ unchanged: true, version: before.version, modelCalls: 0 })
  expect(f.call).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled()
  expect(await snapshotManifest(f.root)).toEqual(before)
})

it('B12 最终标题核对失败的原因随主题缺口发布', async () => {
  const f = await layeredTopicFixture(), original = f.call.getMockImplementation()!
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 资料\n\n甲组研究采用访谈。')
  f.call.mockImplementation(async (...args) => {
    const d = JSON.parse(args[2])
    if (d.review_stage === 'topic-correction') return JSON.stringify({ sentences: d.sentences.map((s: any) => ({
      id: s.id, text: '# 修复标题', point_ids: [d.members[0].point_id], support: '完整支撑', missing: null,
    })) })
    if (d.review_stage === 'topic') return JSON.stringify({ items: d.sentences.map((s: any) => ({ id: s.id,
      support: s.original_text || !s.text.startsWith('#') ? '完整支撑' : '不支撑',
      missing: s.original_text || !s.text.startsWith('#') ? null : '标题待纠正',
      ...(s.original_text ? { claim_preserved: false } : {}),
    })) })
    return original(...args)
  })
  await buildLayeredLibrary(f.options)
  expect((await snapshotManifest(f.root)).topic_gaps).toEqual(expect.arrayContaining([expect.objectContaining({
    reasons: expect.arrayContaining([expect.objectContaining({ reason: '改变原主张' })]),
  })]))
})
