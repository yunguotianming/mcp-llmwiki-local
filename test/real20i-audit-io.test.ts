import * as fs from 'node:fs/promises'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { stringify } from 'yaml'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary, revokeLayeredSources } from '../src/layered/index.js'
import { publishLibrary } from '../src/layered/publication.js'
import { prepareTopics, topicHeader } from '../src/layered/topics.js'
import { prepareTagMerges } from '../src/layered/tag-merges.js'
import { costReport, meteredOptions } from '../src/layered/costs.js'
import { extractSource } from '../src/layered/extraction.js'
import { readLocalSource } from '../src/layered/snapshot.js'
import type { PendingBuild } from '../src/layered/schema.js'
import { pendingFixture } from './pipeline-audit-fixture.js'
import { cleanupLayeredFixtures, snapshotManifest, versionFile, layeredFixture, mockSupportReview } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)


async function consistent(root: string) {
  const manifest = await snapshotManifest(root), index = await versionFile(root, manifest.version!, 'index.md')
  for (const [page, deps] of Object.entries(manifest.deps!.pages)) if (page.startsWith('topics/')) {
    expect(topicHeader(await versionFile(root, manifest.version!, page)).sources, page).toEqual(deps.sources)
    expect(deps.sources.every(id => manifest.sources.some(s => s.source_id === id)), page).toBe(true)
    expect(index.split('\n').find(line => line.includes('](' + page + ')'))).toContain('来源数：' + deps.sources.length)
  }
  for (const match of index.matchAll(/\]\(([^)]+)\)/g)) {
    if (/^[a-z]+:/i.test(match[1]!)) continue
    expect(Object.keys(manifest.pages!), match[1]).toContain(match[1]!.split('#')[0]!)
  }
  return manifest
}

it('P1：子页来源合并后刷新旧父页头与根页计数，重新发布零模型调用', async () => {
  const f = await pendingFixture(), children = [...f.pending.topics!.state.topics]
  const parent = { ...structuredClone(children[0]!), id: 'T-0099', path: 'topics/T-0099.md', title: '父主题', summary: '[证据](../sources/S-0001.md)', point_ids: [], sources: [] }
  f.pending.topics!.state.topics.push(parent)
  f.pending.topics!.pages[parent.path] = { content: '---\n' + stringify({ id: parent.id, page_type: 'topic', title: parent.title, source_type: '综合', source_date: 'unknown', credibility: 'mixed', sources: [], updated: f.pending.started_at }) + '---\n\n# 父主题\n\n## 子主题导航\n' + children.map(t => `- [${t.id}](${t.id}.md)`).join('\n'),
    dependencies: { sources: [], points: [], children: children.map(t => ({ page: t.path, version: '' })) } }
  f.call.mockClear(); f.embed.mockClear()
  await publishLibrary(f.root, f.pending, undefined, false)
  await publishLibrary(f.root, f.pending)
  const manifest = await consistent(f.root)
  expect(manifest.deps!.pages[parent.path]!.sources).toEqual(manifest.sources.map(s => s.source_id).sort())
  expect(f.call).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled()
})

it('P2：全部未变增量零模型与嵌入调用，发布元数据保持一致', async () => {
  const f = await pendingFixture()
  await publishLibrary(f.root, f.pending)
  // 首次公开发布前把标签检查补齐，避免将未完成标签任务当作增量重算。
  await buildLayeredLibrary(f.options)
  f.call.mockClear(); f.embed.mockClear()
  const result = await buildLayeredLibrary(f.options)
  expect(result.modelCalls).toBe(0)
  expect(f.call).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled()
  await consistent(f.root)
})

it('P3：撤权后重建与增量发布失败续做均不保留过期来源，也不重算成功成果', async () => {
  const f = await pendingFixture()
  await publishLibrary(f.root, f.pending)
  await revokeLayeredSources(f.knowledgeRoot, ['S-0001'], '合成审查撤权')
  await buildLayeredLibrary(f.options)
  expect((await consistent(f.root)).sources.map(s => s.source_id)).toEqual(['S-0002'])
  await fs.writeFile(path.join(f.knowledgeRoot, 'b.md'), '# 乙资料\n\n乙组新增结果。')
  const rename = fs.rename
  const fault = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (/versions[\\/]v\d+\.json$/.test(String(to))) throw new Error('审查发布中断')
    return rename(from, to)
  })
  await expect(buildLayeredLibrary(f.options)).rejects.toThrow('审查发布中断')
  fault.mockRestore(); f.call.mockClear(); f.embed.mockClear()
  await buildLayeredLibrary(f.options)
  expect(f.call).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled()
  await consistent(f.root)
})

it('P4：根页搬运主题摘要中的同目录相对链接时不能产生失效链接', async () => {
  const f = await pendingFixture(), topics = f.pending.topics!.state.topics
  expect(topics.length).toBeGreaterThan(1)
  topics[0]!.summary = `[关联主题](${path.posix.basename(topics[1]!.path)})`
  await publishLibrary(f.root, f.pending)
  await consistent(f.root)
})

it('P5：旧术语索引头部落后于最终依赖时明确拒绝并说明恢复边界', async () => {
  const f = await pendingFixture(), page = 'terms/index-01.md', section = page + '#^section-a'
  f.pending.terms = { fingerprint: '审查合并分节', records: [], rewritten: [], model_calls: 0,
    pages: { [page]: { content: '---\n' + stringify({ id: 'TI-01', page_type: 'index', term_kind: 'index', title: '术语索引', source_type: '索引', source_date: 'unknown', updated: f.pending.started_at, sources: [] }) + '---\n\n# 术语索引\n\n## 审查分节 ^section-a\n\n资料索引。\n',
      dependencies: { sources: [], points: [], children: [{ page: section, version: '' }] } } },
    section_dependencies: { [section]: { sources: ['S-0001'], points: [] } } }
  await expect(publishLibrary(f.root, f.pending)).rejects.toThrow('术语 YAML 字段或来源依赖不一致：terms/index-01.md。不支持自动恢复旧索引头部，请重新生成该术语索引。')
})


it.each(['单元素组', '空组', '重复组', '不存在标签', '非法 JSON'])('T-%s：失败只留标签缺口，恢复不重建主题', async kind => {
  const f = await pendingFixture(), before = structuredClone(f.pending.topics)
  f.call.mockImplementation(async (_task, _system, raw) => {
    const d = JSON.parse(raw), tags = d.new_tags.slice(0, 2), group = { canonical: tags[0], tags }
    if (kind === '非法 JSON') return '{'
    return JSON.stringify({ groups: kind === '单元素组' ? [{ canonical: tags[0], tags: tags.slice(0, 1) }]
      : kind === '空组' ? [{ canonical: tags[0], tags: [] }]
        : kind === '重复组' ? [group, group] : [{ canonical: tags[0], tags: [tags[0], '不存在的标签'] }] })
  })
  await prepareTagMerges(f.root, f.pending, f.options)
  expect(Boolean(f.pending.manifest.tag_merge_gap)).toBe(kind !== '单元素组')
  expect(f.pending.topics).toEqual(before)
  await publishLibrary(f.root, f.pending, undefined, false)
  f.call.mockClear(); f.embed.mockClear()
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(f.call).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled()
  f.call.mockResolvedValue('{"groups":[]}')
  await prepareTagMerges(f.root, f.pending, f.options)
  expect(f.call).toHaveBeenCalledTimes(kind === '单元素组' ? 0 : 1)
  expect(f.pending.manifest.tag_merge_gap).toBeUndefined()
  expect(f.pending.topics!.pages).toEqual(before!.pages)
})


it.each([null, 7])('O-note=%s：产品结构校验与首提统计一致', async note => {
  const f = await layeredFixture(), file = path.join(f.knowledgeRoot, 'a.md')
  await writeFile(file, '术语甲。')
  const source = await readLocalSource(file, '资料'), pending = { started_at: new Date().toISOString(), costs: costReport() } as PendingBuild
  f.call.mockResolvedValue(JSON.stringify({ tags: ['研究方法'], credibility: 'unknown', credibility_reason: null, points: [],
    terms: [{ paragraph_id: 0, name: '术语甲', category: '概念', aliases: [], locator: 'L1-L1', note }] }))
  const result = await extractSource(f.root, 'S-0001', source, { tier: 50, granularity: 'custom', model: 'mock', prompt_version: 'audit' }, meteredOptions(f.root, pending, f.options), 64000)
  expect(Object.values(pending.costs!.first_extractions!).map(v => v.status)).toEqual([note === null ? 'passed' : 'failed'])
  if (note === null) {
    expect(result.segments[0]!.terms[0]!.note).toBeNull()
    expect(f.call).toHaveBeenCalledTimes(1)
    expect(result.gaps).toEqual([])
  } else {
    expect(result.segments.flatMap(s => s.terms)).toEqual([])
    expect(result.gaps?.length).toBeGreaterThan(0)
  }
})


it('S1：带标签缺口发布后重新进入建库入口只重试标签', async () => {
  const f = await pendingFixture()
  f.call.mockResolvedValue('{')
  await prepareTagMerges(f.root, f.pending, f.options)
  await publishLibrary(f.root, f.pending)
  f.call.mockClear(); f.embed.mockClear(); f.call.mockResolvedValue('{"groups":[]}')
  await buildLayeredLibrary(f.options)
  expect(f.call).toHaveBeenCalledTimes(1)
  expect(JSON.parse(f.call.mock.calls[0]![2])).toHaveProperty('new_tags')
  expect(f.embed).not.toHaveBeenCalled()
})

it('S2：实际提取纠正护栏保存待办，调高额度后续做不重提来源', async () => {
  const f = await layeredFixture()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '结果提高。')
  f.options.topics = { extractionCorrectionRatio: 0.1, correctionMinCalls: 1, sourceChapterMinPoints: 0 }
  f.options.embeddingClient = { identity: async () => '合成向量', embed: async texts => texts.map(() => [1, 0]) }
  f.call.mockImplementation(async (_task, _system, raw) => {
    const d = JSON.parse(raw), review = mockSupportReview(d)
    if (review) return review
    if (d.new_tags) return '{"groups":[]}'
    const point = { paragraph_id: 0, text: '结果提高。', section: '主要发现', evidence: [{ locator: 'L1-L1', quote: d.correction_stage ? '结果提高。' : '伪造引文' }] }
    if (d.correction_stage) return JSON.stringify({ items: d.items.map((p: any) => ({ ...point, id: p.id })) })
    return JSON.stringify({ tags: ['研究方法', '研究结果'], credibility: 'high', credibility_reason: '合成资料', terms: [], points: [point] })
  })
  await expect(buildLayeredLibrary(f.options)).rejects.toMatchObject({ budgetPause: true })
  const saved = JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8'))
  expect(saved.paused.reason).toBe('budget')
  expect(f.call).toHaveBeenCalledTimes(1)
  f.call.mockClear(); f.options.topics.extractionCorrectionRatio = 2
  await buildLayeredLibrary(f.options)
  const inputs = f.call.mock.calls.map(c => JSON.parse(c[2]))
  expect(inputs.some(d => d.correction_stage)).toBe(true)
  expect(inputs.filter(d => d.paragraphs && !d.correction_stage)).toEqual([])
})
