import { expect, it } from 'vitest'
import { reviewExtraction } from '../src/layered/review.js'
import { reviewTopicContent } from '../src/layered/topic-review.js'
import { sourceOverview } from '../src/layered/overview.js'
import { renderSource } from '../src/layered/extraction.js'
import { point, reviewFixture } from './quality-fix2-audit-fixture.js'
import type { SourceEntry } from '../src/layered/schema.js'

it('Q1：未报告样本量也须查全文，远处样本量不能漏给核对器', async () => {
  const f = reviewFixture([point('文中未报告样本量。')])
  f.source.text += '\n'.repeat(120) + '本研究样本量为27人。'
  f.source.segments[0]!.end = f.source.text.length
  await reviewExtraction(f.extraction, f.source, f.options, 100000)
  const input = JSON.parse(f.call.mock.calls[0]![2])
  expect(input.contexts[input.points[0].source_context_ref].text).toContain('样本量为27人')
})

it('Q2：正文中的作者 ORCID 元数据不得进入来源概览', () => {
  const f = reviewFixture([point('作者甲的 ORCID 为 0000-0002-1825-0097。'), point('结果提高。', '主要发现', 'P2')])
  const overview = sourceOverview(f.extraction, new Map([['P1', ['a']], ['P2', ['b']]]))
  expect(overview).toContain('结果提高。')
  expect(overview).not.toContain('0000-0002-1825-0097')
})

it('Q3：章节列表、分类列表和未核实区均标注，证据链接仍存在', () => {
  const f = reviewFixture(), p = f.extraction.segments[0]!.points[0]!
  p.verification = { status: 'unverified', missing: '缺证据', fingerprint: 'x' }
  f.extraction.chapters = [{ id: 'chapter-a', title: '结果', depth: 1, parent_id: null, paragraph_ids: [0], quota: 1 }]
  const entry = { source_id: 'S-0001', metadata: f.source.metadata, current_path: 'a.md', updated_at: '2026-11-10T00:00:00Z', source_version: 'v1', files: { assets: [] } } as unknown as SourceEntry
  const content = renderSource(entry, f.extraction)
  expect(content.match(/【未核实】结果提高。/g)).toHaveLength(2)
  expect(content).toContain('缺证据')
  for (const match of content.matchAll(/\]\(#\^([^)]+)\)/g)) expect(content).toMatch(new RegExp('\\^' + match[1] + '(?:\\s|$)'))
})

it('Q4：学生访谈方法混入岗位主题应移除，拒绝改写主张并冻结成员', async () => {
  const members = [point('研究者访谈学生。')], before = structuredClone(members), f = reviewFixture(members)
  const link = '[证据](../sources/S-0001.md#^p)'
  const content = '# 岗位职责\n## 条件\n- 临床研究护士负责访谈学生。' + link + '\n## 成员列表\n- P1 研究者访谈学生。'
  f.call.mockImplementation(async (_task, system, raw) => {
    const d = JSON.parse(raw)
    if (d.review_stage === 'topic') {
      expect(system).toContain('研究者使用的访谈方法不能当作受访者岗位职责')
      expect(d.sentences.some((s: any) => s.text === '- P1 研究者访谈学生。')).toBe(true)
      return JSON.stringify({ items: d.sentences.map((s: any) => {
        const supported = s.text.startsWith('#') || s.text === '- P1 研究者访谈学生。'
        return { id: s.id, support: supported ? '完整支撑' : '不支撑', missing: supported ? null : '角色不同' }
      }) })
    }
    return JSON.stringify({ sentences: d.validationFeedback.map((s: any) => ({ id: s.id, text: '- 研究者访谈学生。' + link, point_ids: ['P1'], support: '完整支撑', missing: null })) })
  })
  const result = await reviewTopicContent('T33', content, members, f.options)
  expect(result.content).not.toContain('临床研究护士负责')
  expect(result.content).not.toContain('- 研究者访谈学生。')
  expect(result.review?.removed).toHaveLength(1)
  expect(result.content).toContain('# 岗位职责')
  expect(result.content).toContain('## 成员列表\n- P1 研究者访谈学生。')
  expect(members).toEqual(before)
})

it('Q5：主题核对漏一句不能把其他正常句整批送入纠正', async () => {
  const f = reviewFixture(), body = '# 标题\n## 条件\n- 正常结论。[证据](a.md)\n- 待核对结论。[证据](a.md)'
  let expected: string[] = [], actual: string[] = []
  f.call.mockImplementation(async (_task, _system, raw) => {
    const d = JSON.parse(raw)
    if (d.review_stage === 'topic') {
      expected = [d.sentences.at(-1).id]
      return JSON.stringify({ items: d.sentences.slice(0, -1).map((s: any) => ({ id: s.id, support: '完整支撑', missing: null })) })
    }
    actual = d.validationFeedback.map((s: any) => s.id)
    return '{"sentences":[]}'
  })
  const result = await reviewTopicContent('T1', body, [point()], f.options)
  expect(actual).toEqual(expected)
  expect(result.content).toContain('正常结论。')
})
