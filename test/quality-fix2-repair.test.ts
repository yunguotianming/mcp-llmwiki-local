import { afterEach, expect, it, vi } from 'vitest'
import { matchQuotation } from '../src/layered/quotation.js'
import { reviewExtraction } from '../src/layered/review.js'
import { reviewTopicContent } from '../src/layered/topic-review.js'
import { sourceOverview } from '../src/layered/overview.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'
import { extractionFixture, output, point, reviewFixture } from './quality-fix2-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('上下标和单位符号保持含义，全半角及组合重音仍返回原文偏移', () => {
  for (const [original, changed] of [['m²', 'm2'], ['10⁻³', '10-3'], ['H₂O', 'H2O'], ['xᵃ', 'xa'], ['㎎', 'mg'], ['℃', '°C']]) {
    expect(matchQuotation(original!, changed!), original).toBeUndefined()
    expect(matchQuotation(original!, original!)?.quote).toBe(original)
  }
  const raw = '前文Ａ\u0301 m² 后文'
  expect(matchQuotation(raw, 'Á m²')).toEqual({ start: 2, end: 7, quote: 'Ａ\u0301 m²' })
})

it('纠正按实际引用行判增量，复制重排和扩大定位无效，新增原文行有效且引文去重', async () => {
  for (const mode of ['复制', '重排', '扩大定位', '同文异行', '新增']) {
    const f = reviewFixture(), p = f.extraction.segments[0]!.points[0]!
    if (mode === '同文异行') {
      f.source.text = f.source.text.replace('后一', '结果提高。')
      f.source.segments[0]!.end = f.source.text.length
    }
    p.evidence.push({ ...p.evidence[0]!, locator: 'L3-L3', quote: '前一' })
    f.call.mockImplementation(async (_task, _system, raw) => {
      const input = JSON.parse(raw)
      if (input.review_stage === 'extraction') return JSON.stringify({ items: [{ id: 'P1', support: '部分支撑', missing: '缺下一行' }] })
      const original = input.items[0].validationFeedback.item
      const evidence = mode === '复制' ? [...original.evidence, ...original.evidence]
        : mode === '重排' ? [...original.evidence].reverse()
        : mode === '扩大定位' ? original.evidence.map((e: any) => ({ ...e, locator: 'L1-L7' }))
        : mode === '同文异行' ? [...original.evidence, { locator: 'L5-L5', quote: '结果提高。' }]
        : [...original.evidence, ...original.evidence, { locator: 'L5-L5', quote: '后一' }]
      return JSON.stringify({ items: [{ id: input.items[0].id, evidence, support: '完整支撑', missing: '' }] })
    })
    await reviewExtraction(f.extraction, f.source, f.options, 100000)
    expect(p.verification?.status, mode).toBe(mode === '新增' ? 'verified' : 'unverified')
    expect(p.evidence).toHaveLength(mode === '新增' ? 3 : 2)
    expect(f.extraction.gaps).toHaveLength(mode === '新增' ? 0 : 1)
    expect(await reviewExtraction(f.extraction, f.source, f.options, 100000)).toBe(0)
    expect(f.call).toHaveBeenCalledTimes(2)
  }
})

it('补提先去重再截取，重复候选不挤掉后续新主张，补不足仍留章节缺口', async () => {
  for (const includeNew of [true, false]) {
    const f = await extractionFixture('# 结果\n\n结果提高。结果降低。', { sourceChapterMinPoints: 2 }, 2)
    f.options.granularity = 'custom'
    f.call.mockImplementation(async (_task, _system, raw) => {
      const input = JSON.parse(raw), value = output(input), base = value.points[0]!
      const claim = (text: string) => ({ ...base, text, evidence: [{ locator: input.paragraphs.at(-1).locator, quote: text }] })
      value.points = input.coverage ? [claim('结果提高。'), claim('结果提高。'), ...(includeNew ? [claim('结果降低。')] : [])] : [claim('结果提高。')]
      return JSON.stringify(value)
    })
    const result = await f.run(), claims = result.segments.flatMap(s => s.points).map(p => p.text)
    expect(claims).toEqual(includeNew ? ['结果提高。', '结果降低。'] : ['结果提高。'])
    expect(result.gaps?.some(g => g.reasons.some(r => r.rule === 'chapter-coverage'))).toBe(!includeNew)
    expect(result.truncations).toEqual([])
    expect(f.call.mock.calls.filter(c => JSON.parse(c[2]).coverage)).toHaveLength(1)
  }
})

it('主题标题和成员列表不变，正文纠正保持编号且拒绝注入新标题', async () => {
  const members = [point()], before = structuredClone(members), link = '[证据](sources/a.md#p)'
  const body = '# T-001.1 原标题。\n## 共识\n1. 错误结论。' + link + '\n## 成员列表\n- P1 原成员'
  for (const revision of ['1. 有效结论。' + link, '2. 有效结论。' + link, '1. 有效结论。' + link + '\n# 新标题']) {
    const f = reviewFixture()
    f.call.mockImplementation(async (_task, _system, raw) => {
      const input = JSON.parse(raw)
      if (input.review_stage === 'topic') return JSON.stringify({ items: input.sentences.map((s: any) => ({ id: s.id, support: '不支撑', missing: '待纠正' })) })
      return JSON.stringify({ sentences: input.validationFeedback.map((s: any) => ({ id: s.id,
        text: input.sentences.find((v: any) => v.id === s.id).text.startsWith('#') ? '# 被改写的标题' : revision,
        point_ids: ['P1'], support: '完整支撑', missing: '' })) })
    })
    const result = await reviewTopicContent('T-001.1', body, members, f.options)
    expect(result.content).toContain('# T-001.1 原标题。')
    expect(result.content).toContain('## 成员列表\n- P1 原成员')
    expect(result.content).not.toContain('被改写的标题'); expect(result.content).not.toContain('# 新标题')
    expect(result.content.includes('1. 有效结论。')).toBe(revision === '1. 有效结论。' + link)
    expect(members).toEqual(before)
  }
})

it('概览先结果方法局限背景，各类型分别从章节轮转起点选择', () => {
  const a = [point('结果甲', '主要发现', 'A1'), point('结果乙', '主要发现', 'A2'), point('方法甲', '方法', 'A3'), point('局限甲', '限制', 'A4')]
  const b = [point('背景乙', '对象与条件', 'B1'), point('方法乙', '方法', 'B2'), point('结果丙', '主要发现', 'B3')]
  const f = reviewFixture(a)
  f.extraction.segments.push({ ...f.extraction.segments[0]!, points: b })
  f.extraction.chapters = [0, 1].map(i => ({ id: String(i), title: String(i), depth: 1, parent_id: null, paragraph_ids: [i], quota: 4 }))
  const result = sourceOverview(f.extraction, new Map([...a, ...b].map(p => [p.point_id, [p.point_id]])))
  expect(result.split('\n').map(line => line.split(' ')[1])).toEqual(['结果甲', '结果丙', '结果乙', '方法甲', '方法乙', '局限甲', '背景乙'])
})
