import { expect, it } from 'vitest'
import { reviewExtraction } from '../src/layered/review.js'
import { reviewTopicContent } from '../src/layered/topic-review.js'
import { coveragePurpose } from '../src/layered/longdoc.js'
import { point, reviewFixture } from './quality-fix2-audit-fixture.js'

it('核对传输失败仅允许一次续做重试，仍失败保留缺口与原主张', async () => {
  const f = reviewFixture([point('固定主张。', '主要发现', 'S-0001:sha256:' + 'a'.repeat(64) + ':01')])
  f.call.mockRejectedValue(new Error('网络失败'))
  await reviewExtraction(f.extraction, f.source, f.options, 100000)
  const before = structuredClone(f.extraction.segments[0]!.points[0]!)
  await reviewExtraction(f.extraction, f.source, f.options, 100000)
  await reviewExtraction(f.extraction, f.source, f.options, 100000)
  expect(f.call).toHaveBeenCalledTimes(2)
  expect(f.extraction.gaps).toHaveLength(1)
  expect(f.extraction.correction_batches!.semantic).toBe(1)
  expect(f.extraction.segments[0]!.points[0]!).toMatchObject({ text: before.text, evidence: before.evidence, verification: { retry_attempted: true } })
  for (const args of f.call.mock.calls) expect(JSON.parse(args[2]).points[0].id).toBe('P1')
  expect(JSON.parse(f.call.mock.calls[1]![2]).validationFeedback).toBeTruthy()
})

it('全文未披露与本段未报告分开核对，全文超预算保留缺口而不截断取证', async () => {
  const full = reviewFixture([point('全文未披露样本量。')]), local = reviewFixture([point('本段未报告样本量。')])
  full.source.text += '\n'.repeat(30) + '样本量为27。'
  full.source.segments[0]!.end = full.source.text.length
  await reviewExtraction(full.extraction, full.source, full.options, 100000)
  await reviewExtraction(local.extraction, local.source, local.options, 100000)
  const fullInput = JSON.parse(full.call.mock.calls[0]![2])
  expect(fullInput.contexts[fullInput.points[0].source_context_ref].text).toBe(full.source.text)
  expect(JSON.parse(local.call.mock.calls[0]![2]).points[0]).not.toHaveProperty('source_context_ref')
  const large = reviewFixture([point('文中未报告样本量。')])
  large.source.text += '完整原文'.repeat(10000)
  large.source.segments[0]!.end = large.source.text.length
  await reviewExtraction(large.extraction, large.source, large.options, 3000)
  expect(large.call).not.toHaveBeenCalled()
  expect(large.extraction.gaps).toHaveLength(1)
  expect(large.extraction.segments[0]!.points[0]!.text).toBe('文中未报告样本量。')
})

it('ORCID正文元数据被排除，以ORCID为研究对象的结果仍属研究内容', () => {
  expect(coveragePurpose('', '作者甲的 ORCID 为 0000-0002-1825-0097。')).toBe('ORCID')
  expect(coveragePurpose('ORCID', '研究发现 ORCID 可改善作者身份匹配。')).toBe('研究内容')
  expect(coveragePurpose('', '结果显示 ORCID 0000-0002-1825-0097 的识别错误率为2%。')).toBe('研究内容')
})

it('主题漏项纠正仍缺失时保留正常句与未完成句，标记协议缺口而非语义反证', async () => {
  const f = reviewFixture(), body = '# 标题\n## 条件\n- 正常结论。[证据](a.md)\n- 漏项结论。[证据](a.md)'
  let missing = ''
  f.call.mockImplementation(async (_task, _system, raw) => {
    const d = JSON.parse(raw)
    if (d.review_stage === 'topic') {
      missing = d.sentences.at(-1).id
      return JSON.stringify({ items: d.sentences.slice(0, -1).map((s: any) => ({ id: s.id, support: '完整支撑', missing: null })) })
    }
    expect(d.sentences.map((s: any) => s.id)).toEqual([missing])
    expect(d.validationFeedback.map((s: any) => s.id)).toEqual([missing])
    return '{"sentences":[]}'
  })
  const checked = await reviewTopicContent('T1', body, [point()], f.options)
  expect(checked.content).toBe(body)
  expect(checked.review!.removed).toEqual([])
  expect(checked.failure).toContain('核对协议缺口')
})

it('主题分块核对漏项只纠正相应句，已完成句继续合并且未知成员短编号拒收', async () => {
  const f = reviewFixture(), members = Array.from({ length: 4 }, (_, index) => ({ ...point('完整事实。'.repeat(150)), point_id: 'S-0001:sha256:' + index,
    evidence: [{ source_id: 'S-0001', source_version: 'v1', locator: 'L4-L4', quote: '完整引文。'.repeat(150) }] }))
  f.options.topics = { topicReviewInputBudget: 7000 }
  const body = '# 标题\n## 条件\n- 正常句。[证据](a.md)\n- 漏项句。[证据](a.md)', requests: any[] = []
  f.call.mockImplementation(async (_task, _system, raw) => {
    const d = JSON.parse(raw); requests.push(d)
    if (d.review_stage === 'topic-block') return JSON.stringify({ items: d.sentences.map((s: any) => ({ id: s.id, support: '完整支撑', missing: null, findings: '完整引文。', point_ids: [s.text.includes('漏项') ? 'P404' : d.members[0].point_id] })) })
    if (d.review_stage === 'topic-merge') return JSON.stringify({ items: d.sentences.map((s: any) => ({ id: s.id, support: '完整支撑', missing: null })) })
    expect(d.sentences.every((s: any) => s.text.includes('漏项'))).toBe(true)
    return '{"sentences":[]}'
  })
  const checked = await reviewTopicContent('T1', body, members, f.options)
  expect(requests.some(d => d.review_stage === 'topic-block')).toBe(true)
  expect(requests.some(d => d.review_stage === 'topic-merge')).toBe(true)
  expect(checked.content).toBe(body)
  expect(checked.failure).toContain('核对协议缺口')
})
