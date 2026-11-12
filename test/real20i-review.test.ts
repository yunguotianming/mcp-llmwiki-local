import { expect, it } from 'vitest'
import { reviewExtraction } from '../src/layered/review.js'
import { reviewTopicContent } from '../src/layered/topic-review.js'
import { sourceOverview } from '../src/layered/overview.js'
import { renderSource } from '../src/layered/extraction.js'
import { point, reviewFixture } from './quality-fix2-audit-fixture.js'
import type { SourceEntry } from '../src/layered/schema.js'

it('49 项中一个错 ID 只纠正该项，正常 48 项保留；31 项缺一项同样隔离', async () => {
  for (const count of [49, 31]) {
    const f = reviewFixture(Array.from({ length: count }, (_, i) => point('结果提高。', '主要发现', 'P' + i)))
    f.call.mockImplementation(async (_task, _system, raw) => {
      const input = JSON.parse(raw)
      if (input.review_stage === 'extraction') return JSON.stringify({ items: input.points.slice(0, count - 1).map((p: any) => ({ id: p.id, support: '完整支撑', missing: null })).concat(count === 49 ? [{ id: '错号', support: '完整支撑', missing: null }] : []) })
      expect(input.items.map((p: any) => p.id)).toEqual(['P' + (count - 1)])
      return JSON.stringify({ items: input.items.map((p: any) => ({ id: p.id, evidence: p.validationFeedback.item.evidence, support: '完整支撑', missing: null })) })
    })
    await reviewExtraction(f.extraction, f.source, f.options, 100000)
    expect(f.call).toHaveBeenCalledTimes(2)
    expect(f.extraction.segments[0]!.points.every(p => p.verification?.status === 'verified')).toBe(true)
    expect(f.extraction.gaps).toEqual([])
  }
})

it('重复或错误判定不污染其他 ID，纠正改写主张仍拒收', async () => {
  const f = reviewFixture([point(), point('结果提高。', '方法', 'P2')])
  f.call.mockImplementation(async (_task, _system, raw) => {
    const input = JSON.parse(raw)
    if (input.review_stage === 'extraction') return JSON.stringify({ items: [{ id: 'P1', support: '完整支撑', missing: null }, { id: 'P2', support: '完整支撑', missing: null }, { id: 'P2', support: '完整支撑', missing: null }] })
    return JSON.stringify({ items: [{ id: 'P2', text: '另一主张', evidence: input.items[0].validationFeedback.item.evidence, support: '完整支撑', missing: null }] })
  })
  await reviewExtraction(f.extraction, f.source, f.options, 100000)
  expect(f.extraction.segments[0]!.points.map(p => p.verification?.status)).toEqual(['verified', 'unverified'])
  expect(f.extraction.gaps).toHaveLength(1)
})

it('局部缺省主张送入全文核对，远处答案不能被判全篇缺失', async () => {
  const f = reviewFixture([point('第7题未给出答案。')])
  f.source.text += '\n'.repeat(126) + '第7题答案：C'
  f.call.mockImplementation(async (_task, system, raw) => {
    const input = JSON.parse(raw)
    if (input.review_stage === 'extraction') {
      expect(system).toContain('局部没有不代表全文没有')
      expect(input.points[0].source_context).toContain('第7题答案：C')
      return JSON.stringify({ items: [{ id: 'P1', support: '不支撑', missing: '全文有答案 C' }] })
    }
    return JSON.stringify({ items: [] })
  })
  await reviewExtraction(f.extraction, f.source, f.options, 100000)
  expect(f.extraction.segments[0]!.points[0]!.verification?.status).toBe('unverified')
})

it('概览排除 ORCID，章节与分类列表逐条贯通未核实状态', () => {
  const f = reviewFixture([point('ORCID 0000-0000-0000-0000'), { ...point('未经证实的结论', '方法', 'P2'), verification: { status: 'unverified', missing: '缺证据', fingerprint: 'f' } }])
  f.extraction.chapters = [{ id: 'a', title: 'ORCID', depth: 1, parent_id: null, paragraph_ids: [0], quota: 1 }]
  expect(sourceOverview(f.extraction, new Map([['P1', ['p1']], ['P2', ['p2']]]))).not.toContain('0000')
  const entry = { source_id: 'S-0001', metadata: f.source.metadata, current_path: 'a.md', updated_at: '2026-11-10T00:00:00Z', source_version: 'v1', files: { assets: [] } } as unknown as SourceEntry
  const page = renderSource(entry, f.extraction)
  expect(page.match(/【未核实】未经证实的结论/g)).toHaveLength(2)
})

it('父主题核对携带实际子页导航，并继续核对全部句子和对象身份', async () => {
  const f = reviewFixture()
  const body = '# 岗位研究\n范围：前后两个子页分别讨论岗位与学习。\n## 子主题导航\n- [甲岗位](甲.md) — 岗位研究\n- [乙学习](乙.md) — 学习研究'
  await reviewTopicContent('T1', body, [point()], f.options)
  const input = JSON.parse(f.call.mock.calls[0]![2])
  expect(input.navigation).toContain('乙学习'); expect(input.sentences).toHaveLength(2)
  expect(f.call.mock.calls[0]![1]).toContain('研究者使用的访谈方法不能当作受访者岗位职责')
})
