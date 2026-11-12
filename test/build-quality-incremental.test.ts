import { afterEach, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildLayeredLibrary, readLayeredPage } from '../src/layered/index.js'
import { topicHeader, prepareTopics } from '../src/layered/topics.js'
import { readVersion, putPage, writeVersion } from '../src/layered/objects.js'
import { publishLibrary } from '../src/layered/publication.js'
import * as publication from '../src/layered/publication.js'
import { cleanupLayeredFixtures, layeredFixture, mockSupportReview, modelOutput, snapshotManifest } from './layered-fixture.js'
import { pendingFixture } from './pipeline-audit-fixture.js'
import type { PendingBuild } from '../src/layered/schema.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('正文删句后叶页和父页来源、标签、索引一致，来源层保留成员且重新发布零调用', async () => {
  const f = await layeredFixture()
  f.options.topics = { topicMergeMinSources: 1 }
  f.options.embeddingClient = { identity: async () => '纠正夹具', embed: async texts => texts.map(() => [1, 0]) }
  for (const [name, text] of [['a', '护士工作体验。'], ['b', '学生学习甲。'], ['c', '学生学习乙。'], ['d', '学生学习丙。']]) await writeFile(path.join(f.knowledgeRoot, name + '.md'), text!)
  f.call.mockImplementation(async (_task, _system, raw) => {
    const d = JSON.parse(raw)
    if (d.review_stage === 'topic') return JSON.stringify({ items: d.sentences.map((s: any) => ({ id: s.id, support: s.text.includes('学生') ? '不支撑' : '完整支撑', missing: s.text.includes('学生') ? '对象不同' : null })) })
    if (d.review_stage === 'topic-correction') return '{"sentences":[]}'
    const reviewed = mockSupportReview(d)
    if (reviewed) return reviewed
    if (d.topic_id) return JSON.stringify({ title: '护士工作体验', summary: '护士工作体验。', aliases: ['学生学习'], removed_members: [], consensus: [], differences: [], conditions: [
      { text: '护士工作体验。', point_ids: d.points.filter((p: any) => p.source_id === 'S-0001').map((p: any) => p.point_id) },
      { text: '学生学习说明护士工作体验。', point_ids: d.points.filter((p: any) => p.source_id !== 'S-0001').map((p: any) => p.point_id) },
    ].filter(s => s.point_ids.length) })
    const value = JSON.parse(modelOutput(d))
    if (d.paragraphs) { value.tags = [d.source_id === 'S-0001' ? '岗位' : '学生']; value.terms = [] }
    return JSON.stringify(value)
  })
  let pending: PendingBuild | undefined
  const publish = publication.publishLibrary
  const capture = vi.spyOn(publication, 'publishLibrary').mockImplementation(async (...args) => {
    pending = structuredClone(args[1])
    return publish(...args)
  })
  try { await buildLayeredLibrary(f.options) } finally { capture.mockRestore() }
  const manifest = await snapshotManifest(f.root), topic = manifest.topics!.topics[0]!, page = await readLayeredPage(f.knowledgeRoot, topic.path)
  expect(topicHeader(page)).toMatchObject({ sources: ['S-0001'], aliases: [], tags: ['岗位'], title: '护士工作体验' })
  for (const id of ['S-0002', 'S-0003', 'S-0004']) { expect(page).not.toContain(id); expect(await readLayeredPage(f.knowledgeRoot, 'sources/' + id + '.md')).toContain('学生学习') }
  expect(await readLayeredPage(f.knowledgeRoot)).toContain('护士工作体验')
  f.call.mockClear()
  pending!.base_version = manifest.version
  await publishLibrary(f.root, pending!)
  expect(f.call).not.toHaveBeenCalled()
  expect(topicHeader(await readLayeredPage(f.knowledgeRoot, topic.path))).toMatchObject({ sources: ['S-0001'], aliases: [], tags: ['岗位'], title: '护士工作体验' })
  // 模拟子页已纠正、父页还持有纠正前来源的恢复检查点。
  const committed = await snapshotManifest(f.root), state = pending!.topics!.state
  const child = state.topics.find(item => item.id === topic.id)!
  const parent = { ...structuredClone(child), id: 'T-9999', path: 'topics/T-9999.md', parent_id: null,
    point_ids: Object.keys(state.vectors), sources: ['S-0001', 'S-0002', 'S-0003', 'S-0004'], direct_point_ids: [] }
  child.parent_id = parent.id; state.topics.push(parent)
  pending!.topics!.pages[parent.path] = { content: '---\nid: T-9999\npage_type: topic\ntitle: 护士工作体验\nsource_type: 综合\ncredibility: mixed\nsource_date: unknown\nupdated: 2026-11-10T00:00:00Z\nsources: [S-0001,S-0002,S-0003,S-0004]\n---\n# 护士工作体验\n范围：护士工作体验。\n## 子主题导航\n- [护士工作体验](' + path.posix.basename(child.path) + ') — 护士工作体验。\n',
    dependencies: { sources: [...parent.sources], points: [], children: [{ page: child.path, version: committed.version! }] } }
  pending!.base_version = committed.version
  // 直接续做主题沿用已建立的库身份，与正式建库装配保持一致。
  await prepareTopics(f.root, pending!, committed, { ...f.options, vectorIdentity: pending!.manifest.vector_state!.identity!, reextract: [] }, undefined)
  expect(pending!.topics!.pages[parent.path]!.dependencies.sources).toEqual(['S-0001'])
  expect(topicHeader(pending!.topics!.pages[parent.path]!.content).sources).toEqual(['S-0001'])
  // 直接重新发布旧检查点也必须重算继承来源，不能依赖一次新的模型生成。
  pending!.topics!.pages[parent.path]!.dependencies.sources.push('S-0002', 'S-0003', 'S-0004')
  f.call.mockClear(); await publishLibrary(f.root, pending!)
  expect(f.call).not.toHaveBeenCalled()
  expect(topicHeader(await readLayeredPage(f.knowledgeRoot, parent.path))).toMatchObject({ sources: ['S-0001'], tags: ['岗位'] })
})

it('显式重提只升级所选来源的主题分支，未选页面保持旧协议且发布不调用模型', async () => {
  const f = await pendingFixture()
  await publishLibrary(f.root, f.pending)
  const committed = await readVersion(f.root, f.pending.version!), untouched = committed.topics!.topics.find(topic => topic.sources.includes('S-0002'))!
  const before = await readLayeredPage(f.knowledgeRoot, untouched.path)
  // 模拟旧生成协议：新的来源重提不应顺带升级无依赖关系的页面。
  committed.version = 'v000002'
  committed.pages![untouched.path] = await putPage(f.root, before.replace(/^generation_hash:.*$/m, 'generation_hash: 旧协议'))
  await writeVersion(f.root, committed)
  const pending: PendingBuild = { format_version: 1, base_version: committed.version, version: null, manifest: structuredClone(committed), card: committed.card!, added: [], model_calls: 0, started_at: f.pending.started_at }
  f.call.mockClear()
  await prepareTopics(f.root, pending, committed, { ...f.options, reextract: ['S-0001'] }, undefined)
  expect(f.call.mock.calls.map(call => JSON.parse(call[2]).topic_id)).not.toContain(untouched.id)
  expect(pending.topics!.pages[untouched.path]!.content).toBe(before.replace(/^generation_hash:.*$/m, 'generation_hash: 旧协议'))
  f.call.mockClear(); await publishLibrary(f.root, pending, undefined, false)
  expect(f.call).not.toHaveBeenCalled()
})
