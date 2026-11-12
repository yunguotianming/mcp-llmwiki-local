import { setImmediate } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { auditFixture, envelope, point } from './speed-fix-audit-fixture.js'
import { reviewExtraction } from '../src/layered/review.js'

it('两组纠正已分配额度后并发，慢首组纠正不阻挡下一组', async () => {
  const f = auditFixture('第一组研究结果。\n\n第二组研究结果。')
  const both = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let active = 0, peak = 0
  f.call.mockImplementation(async (_task, _prompt, raw) => {
    const input = JSON.parse(raw)
    if (input.correction_stage) {
      peak = Math.max(peak, ++active); if (active === 2) both.resolve()
      await release.promise; active--
      return JSON.stringify({ items: input.items.map((item: any) => ({ ...item.validationFeedback.item, id: item.id, section: '主要发现' })) })
    }
    const item = point(input.paragraphs[0]); delete (item as any).section
    return JSON.stringify(envelope([item]))
  })
  const running = f.run(undefined, f.parts.map(part => [part]))
  try { await both.promise; expect(peak).toBe(2) } finally { release.resolve() }
  const result = await running
  expect(result.correction_batches?.structure).toBe(2)
  expect(result.segments.map(segment => segment.points.length)).toEqual([1, 1])
})

it('失败拆分的兄弟包并发且30、3、1路完整成果字节相同', async () => {
  const outputs: string[] = []
  for (const cap of [30, 3, 1]) {
    const f = auditFixture('第一段完整研究证据。\n\n第二段完整研究证据。')
    f.options.client.concurrency = () => cap
    let active = 0, peak = 0
    f.call.mockImplementation(async (_task, _prompt, raw) => {
      const input = JSON.parse(raw)
      if (input.paragraphs.length === 2) throw Object.assign(new Error('拆分测试'), { name: 'TimeoutError' })
      peak = Math.max(peak, ++active)
      for (let i = 0; i < (input.paragraphs[0].paragraph_id ? 1 : 4); i++) await setImmediate()
      active--
      return JSON.stringify(envelope([point(input.paragraphs[0])]))
    })
    const result = await f.run(undefined, [f.parts])
    expect(peak).toBe(Math.min(2, cap))
    expect(result.segments.map(segment => segment.points[0]!.evidence[0]!.quote)).toEqual(f.parts.map(part => part.text))
    outputs.push(JSON.stringify(result))
  }
  expect(outputs[1]).toBe(outputs[0]); expect(outputs[2]).toBe(outputs[0])
})

it('章节补提并发且稳定合并，慢补提不阻挡另一篇完成', async () => {
  const f = auditFixture('# 甲章\n\n研究发现甲结果。\n\n# 乙章\n\n研究发现乙结果。')
  f.options.topics = { sourceChapterMinPoints: 1, sourceMetaChapterMinPoints: 0, sourcePackRatio: 0 }
  // 输出预算只能装一章，明确构造两个独立请求来验证并发，不等待同一包内的两章。
  const info = f.options.client.info
  f.options.client.info = async (...args) => ({ ...await info(...args), defaultMaxTokens: 640 })
  const both = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let active = 0, peak = 0
  f.call.mockImplementation(async (_task, _prompt, raw) => {
    const input = JSON.parse(raw)
    if (!input.coverage) return JSON.stringify(envelope([]))
    peak = Math.max(peak, ++active); if (active === 2) both.resolve()
    await release.promise; active--
    return JSON.stringify(envelope(input.paragraphs.filter((part: any) => !part.text.startsWith('#')).map((part: any) => point(part))))
  })
  const running = f.run(undefined, [f.parts])
  try {
    await both.promise
    const other = auditFixture('另一篇独立研究结果。')
    expect((await other.run()).segments[0]!.points).toHaveLength(1)
    expect(peak).toBe(2); expect(active).toBe(2)
  } finally { release.resolve() }
  expect((await running).segments.flatMap(segment => segment.points).map(item => item.text)).toEqual(['研究发现甲结果。', '研究发现乙结果。'])
})

it('取消补提后保留已返回章节，恢复只请求未完成补提', async () => {
  const f = auditFixture('# 甲章\n\n研究发现甲结果。\n\n# 乙章\n\n研究发现乙结果。')
  f.options.topics = { sourceChapterMinPoints: 1, sourceMetaChapterMinPoints: 0, sourcePackRatio: 0 }
  const abort = new AbortController(); f.options.signal = abort.signal
  const slow = Promise.withResolvers<void>()
  f.call.mockImplementation(async (_task, _prompt, raw, signal) => {
    const input = JSON.parse(raw)
    if (!input.coverage) return JSON.stringify(envelope([]))
    if (input.paragraphs.some((part: any) => part.text.includes('乙结果'))) {
      slow.resolve()
      await new Promise((_, reject) => signal!.addEventListener('abort', () => reject(signal!.reason), { once: true }))
    }
    return JSON.stringify(envelope(input.paragraphs.filter((part: any) => !part.text.startsWith('#')).map((part: any) => point(part))))
  })
  const running = f.run(undefined, [f.parts]); const caught = running.catch(error => error)
  await slow.promise
  while (!Object.values(f.progress().chunk_results ?? {}).some(chunk => Object.keys(chunk.coverage_outputs ?? {}).length)) await setImmediate()
  abort.abort(new Error('取消补提'))
  expect((await caught).message).toBe('取消补提')
  const previous = f.progress(); delete f.options.signal; f.call.mockClear()
  f.call.mockImplementation(async (_task, _prompt, raw) => {
    const input = JSON.parse(raw)
    expect(input.coverage).toBeTruthy()
    expect(input.paragraphs.some((part: any) => part.text.includes('乙结果'))).toBe(true)
    return JSON.stringify(envelope(input.paragraphs.filter((part: any) => !part.text.startsWith('#')).map((part: any) => point(part))))
  })
  const result = await f.run(previous, [f.parts])
  expect(f.call).toHaveBeenCalledTimes(1)
  expect(result.segments.flatMap(segment => segment.points)).toHaveLength(2)
})

it('语义补证两批并发且保留全部逐字证据与逐项支撑判定', async () => {
  const f = auditFixture('原证据。' + '研究新增事实。'.repeat(30))
  f.call.mockResolvedValue(JSON.stringify(envelope(Array.from({ length: 20 }, (_, index) => ({ ...point(f.parts[0]!, '原主张' + index), evidence: [{ locator: 'L1-L1', quote: '原证据。' }] })))))
  const result = await f.run(); f.options.topics = { extractionReview: 'all' }
  let active = 0, peak = 0
  f.call.mockImplementation(async (_task, _prompt, raw) => {
    const input = JSON.parse(raw)
    if (input.review_stage === 'extraction') return JSON.stringify({ items: input.points.map((item: any) => ({ id: item.id, support: '部分支撑', missing: '新增事实' })) })
    peak = Math.max(peak, ++active); await setImmediate(); await setImmediate(); active--
    return JSON.stringify({ items: input.items.map((item: any) => ({ id: item.id, evidence: [{ locator: 'L1-L1', quote: f.source.text }], support: '完整支撑', missing: '' })) })
  })
  await reviewExtraction(result, f.source, f.options, 6000)
  expect(peak).toBe(2); expect(result.correction_batches?.semantic).toBe(2)
  expect(result.segments[0]!.points.filter(item => item.verification?.status === 'verified').every(item => item.evidence[0]!.quote === f.source.text)).toBe(true)
  expect(result.segments[0]!.points.every(item => item.verification)).toBe(true)
})
