import { afterEach, expect, it, vi } from 'vitest'
import { layeredSettings } from '../src/domain/config.js'
import { synthesizeSourceSummary } from '../src/layered/longdoc.js'
import { prepareTopics } from '../src/layered/topics.js'
import { topicPath } from '../src/layered/schema.js'
import { point, reviewFixture } from './quality-fix2-audit-fixture.js'
import { compactCitationVersions, expandCitationVersions } from '../src/layered/anchors.js'
import { pendingFixture } from './pipeline-audit-fixture.js'
import { cleanupLayeredFixtures, layeredTopicFixture } from './layered-fixture.js'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { readLayeredPage } from '../src/layered/publication.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('来源摘要超预算时按完整要点分块选择再合并，原文及引文逐字保持', async () => {
  const f = reviewFixture(Array.from({ length: 4 }, (_, index) => point('完整事实', '主要发现', 'P' + index)))
  const result = f.extraction, points = result.segments.flatMap(segment => segment.points)
  points.forEach((point, index) => { point.text = '唯一主张' + index + '条件'.repeat(130) })
  const before = structuredClone(result.segments), keys = points.map((_, index) => '组' + index)
  result.group_summaries = Object.fromEntries(keys.map((id, index) => [id, { id, point_ids: [points[index]!.point_id], missing: [], level: 0, children: [], fingerprint: id }]))
  const seen: string[] = []
  f.call.mockClear(); f.call.mockImplementation(async (_task, prompt, raw) => {
    expect(Buffer.byteLength(prompt + raw)).toBeLessThanOrEqual(3000)
    const input = JSON.parse(raw), candidates = input.children.flatMap((child: any) => child.points)
    seen.push(...candidates.map((point: any) => point.text))
    return JSON.stringify({ point_ids: [candidates[0].point_id] })
  })
  await synthesizeSourceSummary(result, keys, f.options, layeredSettings({ sourceSummaryMaxPoints: 1 }), 3000, async () => {}, () => false)
  expect(f.call.mock.calls.length).toBeGreaterThan(1)
  for (const point of points) expect(seen).toContain(point.text)
  expect(seen.every(text => points.some(point => point.text === text))).toBe(true)
  expect(result.segments).toEqual(before)
  expect(result.summary!.missing).toEqual([])
})

it('父主题完整接收各子页摘要，超预算分块后合并仍引用原子页', async () => {
  const f = await pendingFixture(), build = f.pending.topics!, parent = build.state.topics[0]!
  const children = [1, 2, 3].map(number => ({ ...structuredClone(parent), id: parent.id + '-0' + number,
    parent_id: parent.id, path: topicPath(parent.id + '-0' + number) }))
  parent.direct_point_ids = []; build.state.topics.push(...children); build.pages = {}; build.rewritten = []; build.gaps = []
  delete build.configuration_fingerprint; delete build.point_hashes
  f.options.topics = { ...f.options.topics, parentInputBudget: 3000 }
  const requests: any[] = [], summaries: string[] = []
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (input.children) {
      expect(Buffer.byteLength(args[1] + args[2])).toBeLessThanOrEqual(3000); requests.push(input)
      return JSON.stringify({ title: '父主题', summary: '汇总', aliases: [], consensus: [], differences: [],
        conditions: [{ text: '条件均保留。', child_ids: input.children.map((child: any) => child.id) }] })
    }
    const raw = await f.original(...args)
    if (!input.review_stage && children.some(child => child.id === input.topic_id)) {
      const output = JSON.parse(raw); output.summary = input.topic_id + '完整条件'.repeat(130); summaries.push(output.summary)
      return JSON.stringify(output)
    }
    return raw
  })
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(f.pending.manifest.topic_gaps ?? []).toEqual([])
  const blocks = requests.filter(input => input.synthesis_stage === 'parent-block')
  expect(blocks.length).toBeGreaterThan(1)
  expect(blocks.flatMap(input => input.children.map((child: any) => child.summary)).sort()).toEqual(summaries.sort())
  expect(requests.some(input => input.synthesis_stage === 'parent-merge')).toBe(true)
  expect(f.pending.topics!.pages[parent.path]!.dependencies.children!.map(child => child.page)).toEqual(children.map(child => child.path))
})

it('引用版本号集中保存，全部事实、定位与目标链接保留，重复压缩不改变字节', () => {
  const citation = '[S-0001@sha256:完整版本#L1-L2](../sources/S-0001.md#^p123456789012)'
  const content = '# 主题\n条件甲。' + citation + '\n条件乙。' + citation + '\n## 来源导航\n资料。\n'
  const output = compactCitationVersions(content)
  expect(output).toContain('条件甲。'); expect(output).toContain('条件乙。')
  expect(output.match(/sha256:完整版本/g)).toHaveLength(1)
  expect(output.match(/\]\([^)]*\)/g)).toEqual(content.match(/\]\([^)]*\)/g))
  expect(output.match(/#L1-L2/g)).toHaveLength(2)
  expect(compactCitationVersions(output)).toBe(output)
  expect(expandCitationVersions(output).replace(/^- 来源版本：[^\n]+\n?/gm, '')).toBe(content)
  expect(() => expandCitationVersions('[S-0001#L1-L2](../sources/S-0001.md#^p1)')).toThrow('缺少来源版本')
  expect(() => expandCitationVersions(output + '- 来源版本：S-0001@不同版本\n')).toThrow('不唯一')
})

it('单条术语说明放不进预算时完整保留在索引，不向模型发送裁短说明', async () => {
  const f = await layeredTopicFixture(), original = f.call.getMockImplementation()!, note = '完整术语事实与适用条件。'.repeat(300)
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组证据。')
  f.options.topics = { topicMergeMinSources: 1, termThreshold50: 1, termInputBudget: 900 }
  let termCalls = 0
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (input.term_id) termCalls++
    const output = JSON.parse(await original(...args))
    if (input.paragraphs) output.terms = [{ paragraph_id: input.paragraphs[0].paragraph_id, name: '研究术语', category: '概念', aliases: [], locator: input.paragraphs[0].locator, note }]
    return JSON.stringify(output)
  })
  await buildLayeredLibrary(f.options)
  expect(termCalls).toBe(0)
  expect(await readLayeredPage(f.knowledgeRoot, 'terms/index-01.md')).toContain(note)
})
