import { expect, it } from 'vitest'
import { setImmediate } from 'node:timers/promises'
import { auditFixture, envelope, point } from './speed-fix-audit-fixture.js'
import { reviewExtraction } from '../src/layered/review.js'

it('A29 同键30请求只调用一次，取消单订阅者不影响其余对象隔离', async () => {
  const f = auditFixture('唯一研究事实。'), gate = Promise.withResolvers<void>(), abort = new AbortController()
  f.call.mockImplementation(async () => { await gate.promise; return JSON.stringify(envelope([point(f.parts[0]!)])) })
  f.options.signal = abort.signal
  const cancelled = f.run().catch(error => error)
  delete f.options.signal
  const pending = Array.from({ length: 29 }, () => f.run())
  await setImmediate(); abort.abort(new Error('单个订阅者取消')); gate.resolve()
  expect((await cancelled).message).toBe('单个订阅者取消')
  const values = await Promise.all(pending); expect(f.call).toHaveBeenCalledTimes(1)
  values[0]!.segments[0]!.points[0]!.text = '篡改副本'
  expect(values.slice(1).every(v => v.segments[0]!.points[0]!.text === '唯一研究事实。')).toBe(true)
})

it('A30 30章包多次乱序完成与1、3路的合并字节一致', async () => {
  const f = auditFixture(Array.from({ length: 30 }, (_, i) => `第${i}章研究结果。`).join('\n\n')), bytes: string[] = []
  for (const [cap, seed] of [[1, 7], [3, 13], [30, 23], [30, 31]]) {
    f.options.client.concurrency = () => cap!
    f.call.mockImplementation(async (_t, _s, raw) => {
      const data = JSON.parse(raw), p = data.paragraphs[0]
      for (let i = 0; i < (p.paragraph_id * seed!) % 7; i++) await setImmediate()
      return JSON.stringify(envelope([point(p)]))
    })
    const result = await f.run(undefined, f.parts.map(p => [p]))
    expect(result.segments.flatMap(s => s.points).map(p => p.text)).toEqual(f.parts.map(p => p.text))
    bytes.push(JSON.stringify(result)); f.call.mockClear()
  }
  expect(new Set(bytes).size).toBe(1)
})

it('A31 已完成章节保留，取消的在途结果不落检查点，续做只调用未完成章节', async () => {
  const f = auditFixture('第一章事实。\n\n第二章事实。'), abort = new AbortController(), second = Promise.withResolvers<void>()
  f.options.signal = abort.signal
  f.call.mockImplementation(async (_t, _s, raw) => {
    const p = JSON.parse(raw).paragraphs[0]
    if (p.paragraph_id === 1) { await second.promise; abort.abort(new Error('建库取消')) }
    return JSON.stringify(envelope([point(p)]))
  })
  const work = f.run(undefined, f.parts.map(p => [p])).catch(error => error)
  await setImmediate(); second.resolve(); expect((await work).message).toBe('建库取消')
  const progress = f.progress()
  expect(progress.segments.map(s => s.points.length)).toEqual([1, 0])
  delete f.options.signal; f.call.mockClear(); f.call.mockImplementation(async (_t, _s, raw) => JSON.stringify(envelope([point(JSON.parse(raw).paragraphs[0])])))
  const resumed = await f.run(progress, f.parts.map(p => [p]))
  expect(f.call).toHaveBeenCalledTimes(1); expect(JSON.parse(f.call.mock.calls[0]![2]).paragraphs[0].paragraph_id).toBe(1)
  expect(resumed.segments.map(s => s.points.length)).toEqual([1, 1])
})

it('A32 语义补证被取消后尝试数已保存，续做不得重复核对与补证', async () => {
  const f = auditFixture('原证据。新增证据。')
  f.call.mockResolvedValue(JSON.stringify(envelope([{ ...point(f.parts[0]!), evidence: [{ locator: 'L1-L1', quote: '原证据。' }] }])))
  const result = await f.run(), abort = new AbortController(); f.options.signal = abort.signal; f.options.topics = { extractionReview: 'all' }
  f.call.mockImplementation(async (_t, _s, raw) => {
    const data = JSON.parse(raw), id = (data.points ?? data.items)[0].id
    if (data.review_stage === 'extraction') return JSON.stringify({ items: [{ id, support: '部分支撑', missing: '新增证据' }] })
    abort.abort(new Error('补证取消')); return JSON.stringify({ items: [{ id, evidence: [{ locator: 'L1-L1', quote: f.source.text }], support: '完整支撑', missing: '' }] })
  })
  let checkpoint: typeof result | undefined
  await expect(reviewExtraction(result, f.source, f.options, 64000, async () => { checkpoint = structuredClone(result) })).rejects.toThrow('补证取消')
  expect(checkpoint!.segments[0]!.points[0]!.verification?.status).toBe('unverified')
  delete f.options.signal; f.call.mockClear()
  await reviewExtraction(checkpoint!, f.source, f.options, 64000)
  expect(f.call).not.toHaveBeenCalled()
})

it('篇级两批额度按章节顺序领取，乱序和并发档位不改变成果与缺口', async () => {
  const f = auditFixture('第一章结果。\n\n第二章结果。\n\n第三章结果。'), outputs: string[] = []
  for (const cap of [1, 3, 30]) {
    f.options.client.concurrency = () => cap
    f.call.mockImplementation(async (_t, _s, raw) => {
      const data = JSON.parse(raw)
      if (data.correction_stage) return JSON.stringify({ items: data.items.map((item: any) => ({ id: item.id,
        paragraph_id: item.validationFeedback.item.evidence[0].paragraph_id, section: '主要发现', evidence: item.validationFeedback.item.evidence })) })
      const part = data.paragraphs[0]
      for (let i = 0; i < 3 - part.paragraph_id; i++) await setImmediate()
      return JSON.stringify(envelope([{ text: part.text, evidence: point(part).evidence }]))
    })
    const result = await f.run(undefined, f.parts.map(p => [p]))
    expect(result.correction_batches?.structure).toBe(2)
    expect(result.segments.map(s => s.points.length)).toEqual([1, 1, 0])
    expect(result.gaps).toHaveLength(1)
    expect(f.progress().correction_batches?.structure).toBe(2)
    outputs.push(JSON.stringify(result))
  }
  expect(new Set(outputs).size).toBe(1)
})
