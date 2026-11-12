import { afterEach, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import { prepareTopics, topicHeader } from '../src/layered/topics.js'
import { prepareTagMerges } from '../src/layered/tag-merges.js'
import { publishLibrary, readLayeredPage } from '../src/layered/publication.js'
import { pendingFixture } from './pipeline-audit-fixture.js'
import { cleanupLayeredFixtures, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('父页旧头部缺子来源仍从最终依赖渲染并通过发布，根索引摘要链接重定位', async () => {
  const f = await pendingFixture(), state = f.pending.topics!.state
  const children = [...state.topics], sources = f.pending.manifest.sources.map(s => s.source_id).sort()
  const parent = { ...structuredClone(children[0]!), id: 'T-0099', path: 'topics/T-0099.md', title: '父主题', summary: '[证据](../sources/' + sources[0] + '.md)', point_ids: [], sources: [] }
  state.topics.push(parent)
  f.pending.topics!.pages[parent.path] = { content: '---\n' + stringify({ id: parent.id, page_type: 'topic', title: parent.title, source_type: '综合', source_date: 'unknown', credibility: 'mixed', sources: [], updated: f.pending.started_at }) + '---\n\n# 父主题\n\n## 子主题导航\n' + children.map(t => `- [${t.id}](${t.id}.md)`).join('\n'),
    dependencies: { sources: [], points: [], children: children.map(t => ({ page: t.path, version: '' })) } }
  await publishLibrary(f.root, f.pending)
  const manifest = await snapshotManifest(f.root), content = await readLayeredPage(f.knowledgeRoot, parent.path)
  expect(topicHeader(content).sources).toEqual(sources)
  expect(manifest.deps!.pages[parent.path]!.sources).toEqual(sources)
  expect(await readLayeredPage(f.knowledgeRoot)).toContain(`[证据](sources/${sources[0]}.md)`)
  expect(await readLayeredPage(f.knowledgeRoot)).not.toContain('(../sources/')
})

it('单元素标签组视为无需合并，页面一次发布', async () => {
  const f = await pendingFixture()
  f.call.mockImplementation(async (_task, _system, raw) => {
    const input = JSON.parse(raw)
    return JSON.stringify({ groups: [{ canonical: input.new_tags[0], tags: [input.new_tags[0]] }] })
  })
  await prepareTagMerges(f.root, f.pending, f.options)
  expect(f.pending.manifest.tag_merges!.groups).toEqual([])
  expect(f.pending.manifest.tag_merge_gap).toBeUndefined()
  await expect(publishLibrary(f.root, f.pending)).resolves.toMatch(/^v/)
})

it('标签失败留缺口且可发布，续做只重试标签不调用主题或嵌入', async () => {
  const f = await pendingFixture(), before = JSON.stringify(f.pending.topics)
  f.call.mockRejectedValue(new Error('标签模型暂时失败'))
  await prepareTagMerges(f.root, f.pending, f.options)
  expect(f.pending.manifest.tag_merge_gap?.message).toContain('标签模型暂时失败')
  await publishLibrary(f.root, f.pending, undefined, false)
  f.call.mockClear(); f.call.mockResolvedValue('{"groups":[]}')
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(f.call).not.toHaveBeenCalled()
  // 发布会固定版本；仅比较页面成果和成员，不能因标签失败重建。
  expect(f.pending.topics!.pages).toEqual(JSON.parse(before).pages)
  await prepareTagMerges(f.root, f.pending, f.options)
  expect(f.call).toHaveBeenCalledTimes(1)
  expect(f.pending.manifest.tag_merge_gap).toBeUndefined()
})

it('主题首轮支持短引用并回填原成员，原对象不匹配的成员只移出主题', async () => {
  const f = await pendingFixture(), build = f.pending.topics!, topic = build.state.topics[0]!
  const removed = topic.point_ids[0]!, kept = topic.point_ids.slice(1)
  delete build.pages[topic.path]
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (input.topic_id !== topic.id || input.review_stage) return f.original(...args)
    expect(args[1]).toContain('同对象同问题')
    expect(input.points[0].ref).toBe('P1')
    return JSON.stringify({ title: '同对象研究', summary: '原对象', aliases: [], removed_members: [{ point_id: input.points[0].ref, reason: '对象角色不同' }], consensus: [], differences: [], conditions: [{ text: input.points[1].text, point_ids: [input.points[1].ref] }] })
  })
  // 夹具仅两个来源，移出后允许单来源以检查身份映射；生产门槛未改。
  f.options.topics = { ...f.options.topics, topicMergeMinSources: 1 }
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  const next = f.pending.topics!.state.topics.find(t => t.id === topic.id)
  expect(next?.point_ids).not.toContain(removed)
  expect(next?.point_ids).toEqual(kept)
  expect(f.pending.topics!.state.excluded_members?.[topic.id]?.[removed]?.reason).toBe('对象角色不同')
})
