import { afterEach, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { evidenceBlockIds } from '../src/layered/anchors.js'
import { reviewTopicContent } from '../src/layered/topic-review.js'
import { prepareTagMerges } from '../src/layered/tag-merges.js'
import { extractSource, renderSource } from '../src/layered/extraction.js'
import { hash, writeJson } from '../src/layered/files.js'
import { point, reviewFixture, extractionFixture, output, processing } from './quality-fix2-audit-fixture.js'
import { cleanupLayeredFixtures, layeredFixture } from './layered-fixture.js'
import type { PendingBuild, Point, SourceEntry } from '../src/layered/schema.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
const header = (content: string) => parse(/^---\n([\s\S]*?)\n---/.exec(content)![1]!)
const member = (id: string, text: string): Point => ({ ...point(text, '对象与条件', id + ':' + hash(text) + ':01'), evidence: [{ source_id: id, source_version: 'v1', locator: 'L4-L4', quote: text }] })
const link = (p: Point) => `[证据](../sources/${p.evidence[0]!.source_id}.md#^${evidenceBlockIds([p]).get(p.point_id)![0]})`

it('T-0025标题、别名与页头随正文纠正，成员和逐字引文不变且重核对零调用', async () => {
  const members = [member('S-0001', '患者和公众未作贡献。')], before = structuredClone(members), f = reviewFixture()
  const body = `---\ntitle: 未参与研究\naliases: [未参与研究]\nsources: [S-0001]\n---\n# 未参与研究\n范围：患者和公众未作贡献。\n## 共识\n未提取\n## 分歧\n未提取\n## 适用条件\n- 患者和公众未作贡献。 ${link(members[0]!)}\n## 来源导航\n- [来源](../sources/S-0001.md)\n`
  f.call.mockImplementation(async (_task, _system, raw) => {
    const d = JSON.parse(raw)
    return JSON.stringify(d.review_stage === 'topic-correction' ? { sentences: d.sentences.map((s: any) => ({ id: s.id, text: '# 患者和公众未作贡献', point_ids: ['P1'], support: '完整支撑', missing: null })) }
      : { items: d.sentences.map((s: any) => ({ id: s.id, support: s.text.includes('未参与') ? '不支撑' : '完整支撑', missing: s.text.includes('未参与') ? '贡献不等于参与' : null })) })
  })
  const result = await reviewTopicContent('T-0025', body, members, f.options)
  expect(result.failure).toBeUndefined(); expect(result.content).not.toContain('未参与研究')
  expect(header(result.content)).toMatchObject({ title: '患者和公众未作贡献', aliases: [], sources: ['S-0001'] })
  expect(members).toEqual(before)
  expect((await reviewTopicContent('T-0025', result.content, members, f.options, result.review)).calls).toBe(0)
})

it('T-0033删去学生结论后移除S18/S19/S20导航与sources，并用剩余成员复核范围别名', async () => {
  const members = [member('S-0001', '护士工作体验。'), ...['S-0018', 'S-0019', 'S-0020'].map(id => member(id, '学生学习体验。'))], before = structuredClone(members), f = reviewFixture()
  const body = `---\ntitle: 护士工作体验\naliases: [学生学习]\nsources: [S-0001,S-0018,S-0019,S-0020]\n---\n# 护士工作体验\n范围：护士工作体验。\n## 共识\n- 护士工作体验。 ${link(members[0]!)}\n- 学生学习说明护士工作体验。 ${members.slice(1).map(link).join('；')}\n## 来源导航\n${members.map(p => '- [来源](../sources/' + p.evidence[0]!.source_id + '.md)').join('\n')}\n`
  f.call.mockImplementation(async (_task, _system, raw) => {
    const d = JSON.parse(raw)
    return JSON.stringify(d.review_stage === 'topic-correction' ? { sentences: [] } : { items: d.sentences.map((s: any) => ({ id: s.id, support: s.text.includes('学生') ? '不支撑' : '完整支撑', missing: s.text.includes('学生') ? '对象不同' : null })) })
  })
  const result = await reviewTopicContent('T-0033', body, members, f.options)
  expect(result.failure).toBeUndefined(); expect(header(result.content)).toMatchObject({ sources: ['S-0001'], aliases: [] })
  for (const id of ['S-0018', 'S-0019', 'S-0020']) expect(result.content).not.toContain(id)
  expect(JSON.parse(f.call.mock.calls.at(-1)![2]).members).toHaveLength(1)
  expect(members).toEqual(before)
})

it('英文规范名先归一化，坏组隔离且其后有效组提交，仅重试坏组后零调用', async () => {
  const f = await layeredFixture(), tags = ['临床研究', 'Clinical-Research', '定性研究', 'Qualitative-Research', '访谈', 'Interview']
  await writeJson(f.root, 'tags.json', { format_version: 1, tags, segments: [] })
  const pending = { manifest: { sources: [{ extract: { path: 'tags.json' } }] } } as PendingBuild
  f.call.mockResolvedValue(JSON.stringify({ groups: [
    { canonical: 'Clinical Research', tags: tags.slice(0, 2) },
    { canonical: '无效', tags: ['不存在', '访谈'] },
    { canonical: 'Qualitative Research', tags: tags.slice(2, 4) },
    { canonical: 123, tags: ['访谈', 'Interview'] },
  ] }))
  await prepareTagMerges(f.root, pending, f.options)
  expect(pending.manifest.tag_merges!.groups.map(group => group.canonical)).toEqual(['Clinical-Research', 'Qualitative-Research'])
  expect(pending.manifest.tag_merge_gap!.message).toContain('第 2 组'); expect(pending.manifest.tag_merge_gap!.message).toContain('第 4 组')
  f.call.mockClear(); f.call.mockResolvedValue('{"groups":[]}')
  expect((await prepareTagMerges(f.root, pending, f.options)).modelCalls).toBe(1)
  expect(JSON.parse(f.call.mock.calls[0]![2]).new_tags).toEqual(['Interview', '访谈'])
  expect(pending.manifest.tag_merges!.groups).toHaveLength(2)
  f.call.mockClear(); expect((await prepareTagMerges(f.root, pending, f.options)).modelCalls).toBe(0)
  expect(f.call).not.toHaveBeenCalled()
})

it('包超额的经验范围、年限人数、访谈构成通过逐字校验后使用篇级空额保留', async () => {
  const facts = ['虚构样本的工作经验2至18年，项目经验6个月至12年。', '虚构样本中不足4年8人，超过12年6人。', '虚构样本采用2次个别访谈，3次小组访谈，每组3至4人。']
  const f = await extractionFixture('# 样本\n\n' + facts.join('\n\n') + '\n\n# 其他\n\n其他结果成立。', { sourceChapterMinPoints: 1 }, 50)
  const parts = f.source.segments.map((segment, paragraph_id) => ({ ...segment, paragraph_id, text: f.source.text.slice(segment.start, segment.end) }))
  f.call.mockImplementation(async (_task, _system, raw) => {
    const d = JSON.parse(raw)
    if (d.summary_id) return JSON.stringify(output(d))
    const p = d.paragraphs.find((p: any) => !p.text.startsWith('#'))
    const points = d.paragraphs.filter((p: any) => !p.text.startsWith('#')).map((p: any) => ({ paragraph_id: p.paragraph_id, text: p.text, section: '对象与条件', evidence: [{ locator: p.locator, quote: p.text }] }))
    if (d.paragraphs[0].paragraph_id === 0) points.unshift(...Array.from({ length: d.point_limit }, () => ({ paragraph_id: p.paragraph_id, text: p.text, section: '主要发现', evidence: [{ locator: p.locator, quote: p.text }] })))
    return JSON.stringify({ tags: ['样本'], credibility: 'low', credibility_reason: null, terms: [], points, summary_point_indices: [0] })
  })
  const result = await extractSource(f.root, 'S-0001', f.source, { ...processing, granularity: 'custom' }, f.options, 100000, undefined, [], undefined, [parts.slice(0, 4), parts.slice(4)])
  for (const fact of facts) expect(result.segments.flatMap(segment => segment.points).some(point => point.text === fact && point.evidence[0]!.quote === fact)).toBe(true)
  expect(result.segments.flatMap(segment => segment.points).length).toBeLessThanOrEqual(result.point_limit!)
})

it('列表中通过门槛与免费重考完整送入模型，提示词要求保留条件、例外与费用', async () => {
  const text = '• 答对8题通过；未通过可免费重考。', f = await extractionFixture('# 测验说明\n\n' + text, {}, 100)
  f.call.mockImplementation(async (_task, system, raw) => {
    const d = JSON.parse(raw)
    expect(d.fact_requirements).toContain('人数、年限、范围两端及单位'); expect(d.fact_requirements).toContain('例外与费用')
    expect(d.paragraphs.some((p: any) => p.text === text)).toBe(true)
    return JSON.stringify(output(d))
  })
  const result = await f.run(), entry = { source_id: 'S-0001', metadata: f.source.metadata, current_path: 'a.md', updated_at: '2026-11-10T00:00:00Z', source_version: f.source.contentHash, files: { assets: [] } } as unknown as SourceEntry
  expect(renderSource(entry, result)).toContain(text)
  expect(result.segments.flatMap(segment => segment.points)[0]!.evidence[0]!.quote).toBe(text)
})
