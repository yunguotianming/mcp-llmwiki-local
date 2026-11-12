import { expect, it } from 'vitest'
import { auditFixture, envelope, point } from './speed-fix-audit-fixture.js'
import { reviewExtraction } from '../src/layered/review.js'

it('A36 语义补证分批额度续做时仍应按篇累计至多两批', async () => {
  const f = auditFixture('原证据。' + '研究新增事实。'.repeat(30))
  f.call.mockResolvedValue(JSON.stringify(envelope(Array.from({ length: 20 }, (_, i) => ({ ...point(f.parts[0]!, '原主张' + i), evidence: [{ locator: 'L1-L1', quote: '原证据。' }] })))))
  const result = await f.run(); f.options.topics = { extractionReview: 'all' }
  let batches = 0
  f.call.mockImplementation(async (_t, _s, raw) => {
    const data = JSON.parse(raw)
    if (data.review_stage === 'extraction') return JSON.stringify({ items: data.points.map((p: any) => ({ id: p.id, support: '部分支撑', missing: '研究事实' })) })
    batches++; return JSON.stringify({ items: data.items.map((p: any) => ({ id: p.id, evidence: [{ locator: 'L1-L1', quote: f.source.text }], support: '完整支撑', missing: '' })) })
  })
  await reviewExtraction(result, f.source, f.options, 6000)
  expect(batches).toBe(2)
  // 续做使用持久化后的独立对象，不能依赖原调用中的闭包计数。
  await reviewExtraction(structuredClone(result), f.source, f.options, 6000)
  expect(batches).toBeLessThanOrEqual(2)
})

it('A37 语义补证同批部分返回时独立验收，缺失项不消耗第二次语义尝试', async () => {
  const f = auditFixture('旧事实。新事实。')
  f.call.mockResolvedValue(JSON.stringify(envelope([0, 1].map(i => ({ ...point(f.parts[0]!, '原主张' + i), evidence: [{ locator: 'L1-L1', quote: '旧事实。' }] })))))
  const result = await f.run(); f.options.topics = { extractionReview: 'all' }
  f.call.mockImplementation(async (_t, _s, raw) => {
    const data = JSON.parse(raw)
    return JSON.stringify({ items: data.review_stage === 'extraction'
      ? data.points.map((p: any) => ({ id: p.id, support: '部分支撑', missing: '新事实' }))
      : [{ id: data.items[0].id, evidence: [{ locator: 'L1-L1', quote: f.source.text }], support: '完整支撑', missing: '' }] })
  })
  await reviewExtraction(result, f.source, f.options, 64000)
  expect(result.segments[0]!.points.map(p => p.verification?.status)).toEqual(['verified', 'unverified'])
  f.call.mockClear(); await reviewExtraction(result, f.source, f.options, 64000)
  expect(f.call).not.toHaveBeenCalled()
})

it('A38 语义补证新增跨段证据必须保留各自段号，不得继承第一条段号', async () => {
  const f = auditFixture('研究方法A。\n\n研究结果20%。')
  f.call.mockResolvedValue(JSON.stringify(envelope([point(f.parts[0]!, '方法A对应结果20%。')])))
  const result = await f.run(); f.options.topics = { extractionReview: 'all' }
  f.call.mockImplementation(async (_t, _s, raw) => {
    const data = JSON.parse(raw), id = (data.points ?? data.items)[0].id
    return JSON.stringify({ items: data.review_stage === 'extraction' ? [{ id, support: '部分支撑', missing: '研究结果' }]
      : [{ id, evidence: f.parts.flatMap(p => point(p).evidence), support: '完整支撑', missing: '' }] })
  })
  await reviewExtraction(result, f.source, f.options, 64000)
  expect(result.segments[0]!.points[0]!.verification?.status).toBe('verified')
  expect(result.segments[0]!.points[0]!.evidence.map(e => ({ paragraph_id: (e as any).paragraph_id, locator: e.locator }))).toEqual([{ paragraph_id: 0, locator: 'L1-L1' }, { paragraph_id: 1, locator: 'L3-L3' }])
})
