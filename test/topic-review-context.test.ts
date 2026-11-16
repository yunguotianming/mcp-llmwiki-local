import { afterEach, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { cleanupLayeredFixtures, layeredTopicFixture } from './layered-fixture.js'
import { topicSentences, topicNavigation, reviewTopicContent, topicReviewFingerprint } from '../src/layered/topic-review.js'
import { topicEvidenceContext } from '../src/layered/topic-metadata.js'
import { evidenceBlockIds } from '../src/layered/anchors.js'
import { point, reviewFixture } from './quality-fix2-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('PDQ 引号内问号、括号内句号及链接内标点不分句，外部事实逐句核对', () => {
  const first = '- 文章使用 PDQ“ What do I need to know about you? ”讨论照护（包含“为何？”及条件。）。 '
  const link = '[证据](https://example.org/a_(b)?x=1.2)'
  const content = first + link + ' 另一事实。末句。'
  const sentences = topicSentences(content)
  expect(sentences.map(s => s.text)).toEqual([first + link + ' ', '另一事实。', '末句。'])
  expect(sentences.map(s => content.slice(s.start, s.end))).toEqual(sentences.map(s => s.text))
  expect(sentences.map(s => s.text).join('')).toBe(content)
})

it('英文引号、撇号和小数保留，未配对引号不吞后续事实', () => {
  const content = `- Authors' findings use "What is care?" and don't change 3.5. Next fact. 未闭合“说明。另一句。`
  expect(topicSentences(content).map(s => s.text)).toEqual([
    `- Authors' findings use "What is care?" and don't change 3.5. `, 'Next fact. ', '未闭合“说明。', '另一句。',
  ])
  expect(topicSentences('---\r\naliases: []\r\n---\r\n地址 <https://example.org/a?b=1> 可用。后句。').map(s => s.text))
    .toEqual(['地址 <https://example.org/a?b=1> 可用。', '后句。'])
})

it('原段中引文之前和之后的补证均完整保留，引文、版本和段界仍严格核验', () => {
  const text = 'Professional support was a priority. Shared knowledge improved access. These factors should be accommodated.'
  const source = { title: '研究', source_version: 'v1', text, segments: [{ start: 0, end: text.length, locator: 'L1-L1', text_hash: 'x' }] }
  const evidence = { source_id: 'S1', source_version: 'v1', locator: 'L1-L1', quote: 'Shared knowledge improved access.' }
  expect(topicEvidenceContext(evidence, source)).toBe(text)
  expect(() => topicEvidenceContext({ ...evidence, source_version: 'v0' }, source)).toThrow('版本不一致')
  expect(() => topicEvidenceContext({ ...evidence, quote: 'Shared care improved access.' }, source)).toThrow('不逐字匹配')
})

it('导航结构和子页对应关系完整进入核对，导航句、范围和别名均未豁免', async () => {
  const content = '---\naliases: [护理]\n---\n# 主题\n范围：两个子页。\n## 子主题导航\n\n- [T-0001-01 专业支持](T-0001/T-0001-01.md) — 涉及专业支持。\n- [T-0001-02 临床研究](T-0001/T-0001-02.md) — 涉及临床研究。\n## 来源导航\n\n- [S-0001 研究](../sources/S-0001.md) — L4-L4\n'
  const navigation = topicNavigation(content)
  expect(navigation.sections).toHaveLength(2)
  expect(navigation.children).toEqual([
    { id: 'T-0001-01', title: '专业支持', path: 'T-0001/T-0001-01.md', summary: '涉及专业支持。' },
    { id: 'T-0001-02', title: '临床研究', path: 'T-0001/T-0001-02.md', summary: '涉及临床研究。' },
  ])
  const f = reviewFixture()
  await reviewTopicContent('T-0001', content, [point()], f.options)
  const request = JSON.parse(f.call.mock.calls[0]![2])
  expect(request.navigation).toEqual(navigation)
  expect(request.source_versions).toEqual([{ source_id: 'S-0001', source_version: 'v1' }])
  expect(request.sentences.map((s: any) => s.text)).toEqual(expect.arrayContaining(['范围：两个子页。', '别名：护理', '- [T-0001-01 专业支持](T-0001/T-0001-01.md) — 涉及专业支持。']))
  expect(request.sentences[1].previous_sentence).toEqual({ id: 'S0', text: '# 主题' })
})

it('同一固定输入在 1、3、30 路的分句、完整上下文和请求字节一致', async () => {
  const requests: string[] = []
  for (const concurrency of [1, 3, 30]) {
    const f = reviewFixture()
    f.options.client.concurrency = () => concurrency
    await reviewTopicContent('T-0001', '# 标题\n范围：结果。\n## 条件\n- 研究发现“结果？”表示问题。结果提高。', [point()], f.options)
    requests.push(f.call.mock.calls[0]![2])
  }
  expect(new Set(requests).size).toBe(1)
})

it('实际来源版本和逐句证据绑定变化使核对指纹失效，成员顺序不影响指纹', async () => {
  const members = [point('结果提高。', '主要发现', 'S-0001:p1'), point('另一结果。', '主要发现', 'S-0001:p2')]
  const anchors = evidenceBlockIds(members)
  const content = (index: number) => '# 主题\n- 结果提高。 [证据](../sources/S-0001.md#^' + anchors.get(members[index]!.point_id)![0] + ')'
  const fingerprint = topicReviewFingerprint(content(0), members, false)
  expect(topicReviewFingerprint(content(0), [...members].reverse(), false)).toBe(fingerprint)
  expect(topicReviewFingerprint(content(1), members, false)).not.toBe(fingerprint)
  const changed = members.map(member => ({ ...member, evidence: member.evidence.map(evidence => ({ ...evidence, source_version: 'v2' })) }))
  expect(topicReviewFingerprint(content(0), changed, false)).not.toBe(fingerprint)
  const f = reviewFixture()
  await reviewTopicContent('T-0001', content(0), members, f.options)
  const request = JSON.parse(f.call.mock.calls[0]![2])
  expect(request.sentences[1].point_ids).toEqual(['P1'])
  expect(request.sentences[1].previous_sentence).toEqual({ id: 'S0', text: '# 主题' })
  expect(request.source_versions).toEqual([{ source_id: 'S-0001', source_version: 'v1' }])
})

it('实际主题写作请求逐句绑定依据，新增条款保留原有来源和共识约束', async () => {
  const f = await layeredTopicFixture()
  for (const name of ['a', 'b', 'c']) await writeFile(path.join(f.knowledgeRoot, name + '.md'), '# 来源' + name + '\n\n甲组研究结果。')
  await buildLayeredLibrary(f.options)
  expect(f.topicRequests.length).toBeGreaterThan(0)
  for (const { system, input } of f.topicRequests.filter(r => !r.input.children)) {
    expect(system).toContain('禁止只由编号组成的句子')
    expect(system).toContain('正文每个事实句单列为一个条目')
    expect(system).toContain('point_ids 写完整支撑该句的要点编号')
    expect(system).toContain('consensus≥两来源')
    expect(system).toContain('研究逐句署来源简称/已有作者年份')
    expect(input.points.every(p => p.point_id.startsWith('P'))).toBe(true)
  }
  const calls = f.call.mock.calls.length
  await buildLayeredLibrary(f.options)
  expect(f.call.mock.calls.length).toBe(calls)
})
