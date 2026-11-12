import { fromMarkdown } from 'mdast-util-from-markdown'
import { setImmediate } from 'node:timers/promises'
import { expect, it, vi } from 'vitest'
import { extractionSelectivity } from '../src/domain/granularity.js'
import { layeredSettings } from '../src/domain/config.js'
import { extractSource, planExtraction } from '../src/layered/extraction.js'
import { reviewExtraction } from '../src/layered/review.js'
import { reviewTopicContent, topicSentences } from '../src/layered/topic-review.js'
import { costMarkdown, costReport, meteredOptions } from '../src/layered/costs.js'
import { hash } from '../src/layered/files.js'
import type { BuildLayeredOptions, Extraction, PendingBuild, Point, Processing } from '../src/layered/schema.js'
import type { LocalSource } from '../src/layered/snapshot.js'

vi.mock('../src/layered/files.js', async original => ({ ...await original<typeof import('../src/layered/files.js')>(), writeJson: async () => {}, appendLog: async () => {} }))
const processing: Processing = { tier: 50, granularity: 'standard', prompt_version: '测试', model: 'mock/test' }
function source(text: string): LocalSource {
  return { path: 'test.md', bytes: Buffer.from(text), text, contentHash: hash(text),
    segments: fromMarkdown(text).children.map(node => ({ start: node.position!.start.offset!, end: node.position!.end.offset!, locator: `L${node.position!.start.line}-L${node.position!.end.line}`, text_hash: hash(text.slice(node.position!.start.offset!, node.position!.end.offset!)) })),
    metadata: { title: '测试资料', source_type: '资料', credibility: 'low', credibility_reason: '夹具', source_date: '2026-11-09', source_date_basis: '原文日期' } }
}
function options(call: BuildLayeredOptions['client']['call'], topics: BuildLayeredOptions['topics'] = {}): BuildLayeredOptions {
  return { knowledgeRoot: '内存', topics, client: { call, concurrency: () => 4, info: async () => ({ provider: 'mock', id: 'test', name: 'test', context: { contextWindow: 131072 } }) } }
}
const output = (points: unknown[]) => JSON.stringify({ tags: ['结果', '方法', '条件'], credibility: 'low', credibility_reason: '夹具', points, terms: [] })
function extraction(input: LocalSource, points: Point[]): Extraction {
  return { format_version: 1, source_id: 'S-0001', source_hash: input.contentHash, processing, metadata: input.metadata, calls: [],
    segments: input.segments.map((segment, index) => ({ ...segment, processing_fingerprint: '', resource_hashes: [], points: index ? [] : points, terms: [] })) }
}
function point(id: string, text: string, quote: string, locator = 'L1-L1'): Point {
  return { point_id: id, text, section: '主要发现', locator, text_hash: '', source_version: 'v', evidence: [{ source_id: 'S-0001', source_version: 'v', locator, quote }] }
}

it('章节包保持顺序且不为短章单独首提，同篇并发，漏章只补一次并记缺口', async () => {
  const input = source('# 论文\n\n' + [1, 2, 3, 4].map(n => `## 章${n}\n\n研究${n}：${'事实与条件。'.repeat(n === 2 ? 2 : 120)}`).join('\n\n'))
  const settings = layeredSettings({ sourcePackRatio: 0.25 }), plan = planExtraction('S-0001', input, processing, 20000, settings)
  expect(plan.length).toBeGreaterThanOrEqual(2); expect(plan.length).toBeLessThanOrEqual(4)
  expect(plan.flat().map(part => part.paragraph_id)).toEqual(input.segments.map((_, index) => index))
  expect(plan.every(parts => parts.filter(part => !part.text.startsWith('#')).some(part => part.text.length > 30)), JSON.stringify(plan.map(parts => parts.map(part => [part.paragraph_id, part.text.length])))).toBe(true)
  let active = 0, peak = 0
  const requests: any[] = []
  const config = options(async (_task, _system, raw) => {
    const data = JSON.parse(raw); requests.push(data); active++; peak = Math.max(peak, active); await setImmediate(); active--
    if (data.chapters) return JSON.stringify({ chapters: data.chapters.map((chapter: any) => ({ chapter_id: chapter.chapter_id, points: [] })) })
    return output(data.paragraphs.filter((part: any) => !part.text.startsWith('#') && !part.text.startsWith('研究3')).map((part: any) => ({ paragraph_id: part.paragraph_id, text: part.text, section: '主要发现', evidence: [{ locator: part.locator, quote: part.text }] })))
  }, { sourcePackRatio: 0.25 })
  config.vocabulary = { tags: ['规范标签'], terms: [{ name: '规范术语', aliases: ['别名'] }] }
  const result = await extractSource('内存', 'S-0001', input, processing, config, 20000)
  expect(peak).toBeGreaterThan(1)
  const coverage = requests.filter(item => item.coverage).flatMap(item => item.chapters ? item.chapters.map((chapter: any) => ({ ...chapter, coverage: chapter.chapter_id })) : [item])
  expect(coverage).toHaveLength(1)
  expect(new Set(coverage.map(item => item.coverage)).size).toBe(1)
  expect(coverage.find(item => item.paragraphs.some((part: any) => part.text.startsWith('研究3'))).paragraphs.every((part: any) => part.text.includes('章3') || part.text.startsWith('研究3'))).toBe(true)
  expect(result.gaps?.some(gap => gap.reasons.some(reason => reason.rule === 'chapter-coverage'))).toBe(true)
  // 术语只随出现在本包正文的名称或别名下发；夹具正文没有“规范术语/别名”，标签照常全带。
  expect(requests[0].vocabulary).toEqual({ tags: ['规范标签'], terms: [] })
  expect(requests[0].selectivity).toContain('忽略次要细节')
  expect(result.calls.every(call => call.input_bytes <= call.input_limit)).toBe(true)
})

it('普通短文硬上限按结果优先截断留痕，超长文仍按同一长度公式扩额', async () => {
  const input = source('真实数据。')
  const call: BuildLayeredOptions['client']['call'] = async () => output(['对象与条件', '对象与条件', '方法', '主要发现', '主要发现', '主要发现', '限制'].map((section, index) => ({ paragraph_id: 0, text: '主张' + index, section, evidence: [{ locator: 'L1-L1', quote: '真实数据。' }] })))
  // 五点截断用显式自定义额度；精细和标准档的新基础额度在下方分别精确验证。
  const result = await extractSource('内存', 'S-0001', input, { ...processing, tier: 5, granularity: 'custom' }, options(call), 20000)
  expect(result.point_limit).toBe(5)
  expect(result.segments[0]!.points.map(point => point.section)).toEqual(['方法', '主要发现', '主要发现', '主要发现', '限制']) // 非样本的对象条件不能挤掉局限，落盘保持原文顺序。
  expect(result.truncations?.reduce((sum, item) => sum + item.count, 0)).toBe(2)
  // 单包配额沿用扩额前规则（精细、标准短文降额）；篇级扩额只放宽截断阈值。
  for (const [granularity, tier, limit] of [['fine', 100, 5], ['standard', 50, 5], ['coarse', 10, 10], ['minimal', 5, 5], ['custom', 37, 37]] as const) {
    const seen: any[] = []
    await extractSource('内存', 'S-0001', input, { ...processing, tier, granularity }, options(async (_task, _system, raw) => {
      seen.push(JSON.parse(raw)); return output([])
    }), 20000)
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ point_limit: limit, selectivity: extractionSelectivity(tier, granularity) })
  }
})

it('提取核对只发引文邻近行，补证不改主张，失败降级，未变化跳过且多篇并发', async () => {
  const input = source('设计A。\n结果20%。\n条件B。\n未支持其他结论。\n第五行。\n第六行。')
  const make = () => extraction(input, [point('p1', '设计A的结果20%。', '设计A。'), point('p2', '不存在的结论。', '设计A。')])
  let active = 0, peak = 0
  const requests: any[] = []
  const config = options(async (_task, _system, raw, _signal, _images, route) => {
    expect(route?.operation).toBe('extract')
    const data = JSON.parse(raw); requests.push(data); active++; peak = Math.max(peak, active); await setImmediate(); active--
    if (data.review_stage === 'extraction') return JSON.stringify({ items: data.points.map((p: any) => ({ id: p.id, support: '部分支撑', missing: '补充结果行' })) })
    return JSON.stringify({ items: data.items.map((item: any) => { const before = item.validationFeedback.item
      return { id: item.id, evidence: [{ locator: 'L1-L2', quote: '设计A。\n结果20%。' }], support: before.text.startsWith('设计') ? '完整支撑' : '不支撑', missing: before.text.startsWith('设计') ? '' : '原文无此结论' }
    }) })
  })
  const a = make(), b = make()
  // 每篇一次核对加一次批量补证，两个失败项共用同一调用。
  expect(await Promise.all([reviewExtraction(a, input, config, 20000), reviewExtraction(b, input, config, 20000)])).toEqual([2, 2])
  expect(peak).toBeGreaterThan(1)
  expect(requests[0].contexts[requests[0].points[0].evidence[0].context_ref].text).toBe('设计A。\n结果20%。\n条件B。')
  expect(a.segments[0]!.points.map(point => point.verification?.status)).toEqual(['verified', 'unverified'])
  expect(a.segments[0]!.points[0]!.text).toBe('设计A的结果20%。')
  expect(await reviewExtraction(a, input, config, 20000)).toBe(0)
  expect(requests).toHaveLength(4) // 两篇各两次；逐项验收断言保持。
})

it('主题逐句核对、纠正失败删句留痕，正文与成员未变零核对，主题之间并发', async () => {
  const body = '# 结果\n\n范围：结果。\n\n## 共识\n\nValid result. Another result.\n错误结论。[证据](../sources/S-0001.md#^a)\n\n## 来源导航\n\n- 导航\n'
  expect(topicSentences(body).some(sentence => sentence.text.trim() === 'Valid result.')).toBe(true)
  let active = 0, peak = 0
  const call = vi.fn(async (_task, _system, raw) => {
    const data = JSON.parse(raw); active++; peak = Math.max(peak, active); await setImmediate(); active--
    if (data.review_stage === 'topic') return JSON.stringify({ items: data.sentences.map((sentence: any) => ({ id: sentence.id, support: sentence.text.includes('错误') ? '不支撑' : '完整支撑', missing: sentence.text.includes('错误') ? '误把转述写成作者结论' : '' })) })
    return JSON.stringify({ sentences: data.validationFeedback.map((item: any) => ({ id: item.id, text: '', point_ids: [], support: '不支撑', missing: item.missing })) })
  })
  const config = options(call), members = [point('p', '结果', '结果')]
  const [a] = await Promise.all([reviewTopicContent('T1', body, members, config), reviewTopicContent('T2', body, members, config)])
  expect(peak).toBeGreaterThan(1); expect(call).toHaveBeenCalledTimes(4)
  expect(a!.content).not.toContain('错误结论'); expect(a!.review?.removed).toHaveLength(1)
  expect((await reviewTopicContent('T1', a!.content, members, config, a!.review)).calls).toBe(0)
  expect((await reviewTopicContent('T1', a!.content, [...members, point('p2', '新结果', '新结果')], config, a!.review)).calls).toBe(1)
  const repaired = await reviewTopicContent('T3', body.replace('错误结论', '有效结论'), members, options(async (_task, _system, raw) => {
    const data = JSON.parse(raw)
    if (data.review_stage === 'topic') return JSON.stringify({ items: data.sentences.map((sentence: any) => ({ id: sentence.id, support: sentence.text.includes('有效结论') ? '部分支撑' : '完整支撑', missing: sentence.text.includes('有效结论') ? '补充证据编号' : '' })) })
    return JSON.stringify({ sentences: data.validationFeedback.map((item: any) => ({ id: item.id, text: '有效结论。[证据](../sources/S-0001.md#^a)', point_ids: [data.members[0].point_id], support: '完整支撑', missing: '' })) })
  }))
  expect(repaired.calls).toBe(2); expect(repaired.review?.removed).toEqual([])
  expect(repaired.content).toContain('有效结论。'); expect(repaired.content).not.toContain('错误结论')
})

it('观测分别记录调用、Token、墙钟、并发峰值及纠正原因', async () => {
  const pending = { started_at: new Date().toISOString(), costs: costReport() } as PendingBuild
  const config = meteredOptions('内存', pending, options(async (_task, _system, _raw, _signal, _images, route) => {
    route?.beforeAttempt?.()
    const attempt = { route: { provider: 'mock', model: 'test' }, startedAt: new Date().toISOString(), durationMs: 10, finish: 'stop', usage: { inputTokens: 10, outputTokens: 2 } }
    route?.onAttempt?.(attempt); await setImmediate(); return '{}'
  }))
  await Promise.all([1, 2].map(n => config.client.call('ingest', '', JSON.stringify({ review_stage: 'extraction', source_id: 'S' + n }), undefined)))
  await config.client.call('ingest', '', JSON.stringify({ review_stage: 'topic-correction', topic_id: 'T1', validationFeedback: [{ missing: '证据' }] }), undefined)
  expect(pending.costs!.stages['提取后核对']).toMatchObject({ actual_calls: 2, input_tokens: 20, output_tokens: 4, peak_concurrency: 2 })
  expect(pending.costs!.stages['主题后核对']).toMatchObject({ actual_calls: 1, corrections: 1, correction_reasons: { 'semantic-support': 1 } })
  expect(pending.costs!.stages['提取后核对']!.wall_ms).toBeGreaterThanOrEqual(0)
  expect(costMarkdown(pending.costs!)).toContain('墙钟 ms')
})
