import { afterEach, expect, it, vi } from 'vitest'
import { readFile, readdir } from 'node:fs/promises'
import { legacyFixture } from './b3-fixture.js'
import { pendingFixture } from './pipeline-audit-fixture.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'
import { initializeLibrary } from '../src/layered/publication.js'
import { readUpgradeStatus, verifyUpgradeBackup } from '../src/layered/upgrade.js'
import { readVersion } from '../src/layered/objects.js'
import { hash, writeJson } from '../src/layered/files.js'
import { storageJson } from '../src/layered/vectors.js'
import { selectTopicGaps, recoverTopicIdentities } from '../src/layered/topic-recovery.js'
import { prepareTopics } from '../src/layered/topics.js'
import { reviewTopicContent, topicSentences } from '../src/layered/topic-review.js'
import { safePath } from '../src/storage/paths.js'
import { evidenceBlockIds } from '../src/layered/anchors.js'
import type { Point, TopicRepairState } from '../src/layered/schema.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it.each(['0.2.0', '0.2.1'] as const)('%s旧格式只读恢复不升级，首次写入备份，随后按原身份继续核对', async version => {
  const f = await legacyFixture(version, version === '0.2.1'), source = f.manifest.sources[0]!
  const quote = await readFile(await safePath(f.root, source.files.source), 'utf8')
  const point: Point = { point_id: source.source_id + ':旧成员', text: quote, text_hash: source.content_hash, locator: 'L1-L1',
    source_version: source.source_version, section: '主要发现', evidence: [{ source_id: source.source_id, source_version: source.source_version, locator: 'L1-L1', quote }] }
  f.manifest.topic_gaps = [{ topic_id: 'T-0099-01', point_ids: [point.point_id], message: 'Connection error.' },
    { topic_id: 'T-0099', point_ids: [point.point_id], message: '子主题均有生成缺口。' }]
  await writeJson(f.root, 'versions/v000001.json', { checksum: hash(storageJson(f.manifest)), manifest: f.manifest })
  const before = await readdir(f.root, { recursive: true }), original = await readFile(await safePath(f.root, 'versions/v000001.json'))
  const manifest = await readVersion(f.root, 'v000001')
  expect(recoverTopicIdentities(manifest).find(topic => topic.id === 'T-0099-01')?.parent_id).toBe('T-0099')
  expect(selectTopicGaps(manifest)).toHaveLength(2)
  expect(selectTopicGaps(manifest, undefined, { topicIds: ['T-0099-01'] })).toHaveLength(1)
  expect(await readUpgradeStatus(f.root)).toBeUndefined()
  expect(await readdir(f.root, { recursive: true })).toEqual(before)
  await initializeLibrary(f.parent, manifest.card!, undefined, undefined, f.root)
  const upgrade = (await readUpgradeStatus(f.root))!
  expect(upgrade.status).toBe('complete')
  expect((await verifyUpgradeBackup(upgrade.backupPath)).complete).toBe(true)
  expect(await readFile(await safePath(f.root, 'versions/v000001.json'))).toEqual(original)
  const link = `[证据](../sources/${source.source_id}.md#^${evidenceBlockIds([point]).get(point.point_id)![0]})`
  const content = `# ${quote}\n范围：按成员证据阅读。\n## 适用条件\n- ${quote}（P1） ${link}\n`
  expect(topicSentences(`- ${quote}（P1） ${link}`)).toHaveLength(1)
  let saved: TopicRepairState | undefined
  const result = await reviewTopicContent('T-0099-01', content, [point], { knowledgeRoot: '内存', topics: {}, client: {
    info: async () => ({ id: '离线', name: '确定性桩', provider: '桩', context: { contextWindow: 131072 } }),
    call: async (_task, _system, raw) => JSON.stringify({ items: JSON.parse(raw).sentences.map((sentence: any) => ({ id: sentence.id, support: '完整支撑', missing: null })) }),
  } }, undefined, false, undefined, { runId: '旧库续跑', save: async state => { saved = structuredClone(state) } })
  expect(result.failure).toBeUndefined()
  expect(result.content).toContain('范围：' + quote)
  expect(result.content).not.toContain('按成员证据阅读')
  expect(saved?.member_ids).toEqual([point.point_id])
}, 30000)

it('叶共识不足两个来源时有限次重生成，完整核对仍拒绝持续不合法输出', async () => {
  const f = await pendingFixture(), topic = f.pending.topics!.state.topics[0]!
  delete f.pending.topics!.pages[topic.path]
  let attempts = 0
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2]), raw = await f.original(...args)
    if (input.topic_id !== topic.id || input.review_stage) return raw
    attempts++
    const output = JSON.parse(raw); output.consensus = output.conditions; output.conditions = []
    return JSON.stringify(output)
  })
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(attempts).toBe(3)
  expect(f.pending.topics!.pages[topic.path]).toBeUndefined()
  expect(f.pending.manifest.topic_gaps?.find(gap => gap.topic_id === topic.id)?.message).toContain('至少两个来源')
})

it('有页删句通知可按原因定向重试，普通续跑保持成功页不重复生成', async () => {
  const f = await pendingFixture(), topic = f.pending.topics!.state.topics[0]!
  f.pending.topics!.gaps = [{ topic_id: topic.id, point_ids: [...topic.point_ids], message: '删除未支撑句：需复核', reasons: [{ sentence_id: 'S2', text: '原句', reason: '证据不完整' }] }]
  f.call.mockClear(); f.topicRequests.splice(0)
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(f.call).not.toHaveBeenCalled()
  await prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryTopics: { reasons: ['证据不完整'] } }, undefined)
  expect(f.topicRequests).toEqual([])
})

it('多句主张分别保存有效成员绑定，渲染不留下编号假句', async () => {
  const f = await pendingFixture(), topic = f.pending.topics!.state.topics[0]!
  delete f.pending.topics!.pages[topic.path]
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2]), raw = await f.original(...args)
    if (input.topic_id !== topic.id || input.review_stage) return raw
    const output = JSON.parse(raw)
    output.conditions[0].text = input.points[0].text + '（P1）' + input.points[1].text + '（P2）'
    output.conditions[0].point_ids = [input.points[0].point_id, input.points[1].point_id]
    return JSON.stringify(output)
  })
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  const page = f.pending.topics!.pages[topic.path]!
  expect(page.content).not.toMatch(/（P\d+）/)
  expect(page.dependencies.claims!.length).toBeGreaterThanOrEqual(2)
  expect(page.dependencies.claims!.every(claim => claim.point_ids.length > 0)).toBe(true)
})
