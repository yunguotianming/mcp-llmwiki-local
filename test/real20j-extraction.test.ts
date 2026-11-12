import { expect, it } from 'vitest'
import { evidenceDictionary } from '../src/layered/evidence.js'
import { auditFixture, envelope, point } from './speed-fix-audit-fixture.js'

it('重复证据以E短编号往返，旧哈希检查点继续逐字验收且不再调用模型', async () => {
  const f = auditFixture('结果增加20%。\n\n结果增加20%。')
  const oldRef = Object.keys(evidenceDictionary(f.parts).dictionary)[0]!
  f.call.mockImplementation(async (_t, _s, raw) => {
    const data = JSON.parse(raw)
    expect(Object.keys(data.evidence_dictionary)).toEqual(['E1'])
    expect(data.paragraphs.map((p: any) => p.evidence_ref)).toEqual(['E1', 'E1'])
    return JSON.stringify(envelope(f.parts.map(p => ({ ...point(p), evidence: [{ evidence_ref: 'E1', paragraph_id: p.paragraph_id }] }))))
  })
  const result = await f.run()
  expect(result.segments.flatMap(s => s.points).map(p => p.evidence[0])).toMatchObject([
    { locator: 'L1-L1', quote: '结果增加20%。' }, { locator: 'L3-L3', quote: '结果增加20%。' },
  ])
  const previous = f.progress()
  previous.in_progress = true; previous.completed_chunks = []
  previous.segments.forEach(s => { s.points = [] })
  expect(Object.keys(previous.chunk_results!)).toHaveLength(1)
  for (const chunk of Object.values(previous.chunk_results!)) {
    chunk.completed_items = []
    chunk.raw = JSON.stringify(envelope(f.parts.map(p => ({ ...point(p), evidence: [{ evidence_ref: oldRef, paragraph_id: p.paragraph_id }] }))))
  }
  f.call.mockClear()
  const resumed = await f.run(previous)
  expect(f.call).not.toHaveBeenCalled()
  expect(resumed.segments).toEqual(result.segments)
})

it('未知证据短编号及伪回旧哈希均拒收，只纠正坏项且不牵连合法证据', async () => {
  const f = auditFixture('结果增加20%。\n\n结果增加20%。')
  const oldRef = Object.keys(evidenceDictionary(f.parts).dictionary)[0]!
  f.call.mockImplementation(async (_t, _s, raw) => {
    const data = JSON.parse(raw)
    if (data.correction_stage) {
      expect(data.items.map((i: any) => i.id)).toEqual(['point:1', 'point:2'])
      expect(data.items.every((i: any) => i.validationFeedback.reasons[0].rule === 'evidence-ref')).toBe(true)
      return JSON.stringify({ items: [] })
    }
    return JSON.stringify(envelope(['E1', 'E999', oldRef].map((ref, index) => ({ ...point(f.parts[0]!, '固定主张' + index), evidence: [{ evidence_ref: ref, paragraph_id: 0 }] }))))
  })
  const result = await f.run()
  expect(f.call).toHaveBeenCalledTimes(2)
  expect(result.segments.flatMap(s => s.points).map(p => p.text)).toEqual(['固定主张0'])
  expect(result.gaps).toHaveLength(2)
})

it('未知证据编号即使附带合法逐字引文也不能被Schema剥离后接收', async () => {
  const f = auditFixture('结果增加20%。\n\n结果增加20%。')
  f.call.mockImplementation(async (_t, _s, raw) => JSON.stringify(JSON.parse(raw).correction_stage ? { items: [] }
    : envelope([{ ...point(f.parts[0]!), evidence: [{ ...point(f.parts[0]!).evidence[0], evidence_ref: 'E404' }] }])))
  const result = await f.run()
  expect(f.call).toHaveBeenCalledTimes(2)
  expect(result.segments.flatMap(s => s.points)).toEqual([])
  expect(JSON.parse(f.call.mock.calls[1]![2]).items[0].validationFeedback.reasons[0].rule).toBe('evidence-ref')
  expect(result.gaps).toHaveLength(1)
})

it('覆盖补提纠正以C短编号回填，章节哈希只保存在内部且原主张逐字不变', async () => {
  const f = auditFixture('# 结果\n\n结果增加20%。')
  f.options.topics = { sourceChapterMinPoints: 1, sourcePackRatio: 0 }
  f.call.mockImplementation(async (_t, _s, raw) => {
    const data = JSON.parse(raw)
    if (data.correction_stage) {
      expect(data.items.map((i: any) => i.id)).toEqual(['C1'])
      return JSON.stringify({ items: [{ id: 'C1', ...point(f.parts[1]!) }] })
    }
    return JSON.stringify(envelope(data.coverage ? [{ text: f.parts[1]!.text, evidence: point(f.parts[1]!).evidence }] : []))
  })
  const result = await f.run()
  expect(f.call).toHaveBeenCalledTimes(3)
  expect(result.segments.flatMap(s => s.points).map(p => p.text)).toEqual(['结果增加20%。'])
  expect(result.gaps).toEqual([])
  expect(Object.values(f.progress().chunk_results!).some(c => Object.keys(c.coverage_outputs ?? {}).some(id => id.startsWith('coverage:') && id.length > 30))).toBe(true)
})

it('覆盖补提纠正返回未知C编号仍拒收，保留其他章节并记录覆盖缺口', async () => {
  const f = auditFixture('# 方法\n\n样本随机。\n\n# 结果\n\n结果增加20%。')
  f.options.topics = { sourceChapterMinPoints: 1, sourcePackRatio: 0 }
  f.call.mockImplementation(async (_t, _s, raw) => {
    const data = JSON.parse(raw)
    if (data.correction_stage) return JSON.stringify({ items: [{ id: 'C999', ...point(f.parts[3]!) }] })
    return JSON.stringify(envelope(data.coverage ? [{ text: f.parts[3]!.text, evidence: point(f.parts[3]!).evidence }] : [point(f.parts[1]!)]))
  })
  const result = await f.run()
  expect(f.call).toHaveBeenCalledTimes(3)
  expect(result.segments.flatMap(s => s.points).map(p => p.text)).toEqual(['样本随机。'])
  expect(result.gaps!.some(g => g.reasons.some(r => r.rule === 'correction-schema'))).toBe(true)
  expect(result.gaps!.some(g => g.reasons.some(r => r.rule === 'chapter-coverage'))).toBe(true)
})
