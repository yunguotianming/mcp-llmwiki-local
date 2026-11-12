// 术语精确断言增加实际模型；恶改名称、指称、ID 与原主张断言保持。
import { expect, it } from 'vitest'
import { auditFixture, envelope, point } from './speed-fix-audit-fixture.js'
import { correctionBatches, correctionContext } from '../src/layered/corrections.js'

it('A01 局部上下文严格限于各自证据段及前后两段，失锚不回退整包', () => {
  const f = auditFixture(Array.from({ length: 20 }, (_, i) => `第${i}段研究事实。`).join('\n\n'))
  expect(correctionContext(f.parts, point(f.parts[8]!)).map(p => p.paragraph_id)).toEqual([6, 7, 8, 9, 10])
  expect(correctionContext(f.parts, { evidence: [{ quote: '原文不存在的引文' }] })).toEqual([])
  const cross = point(f.parts[3]!); cross.evidence.push(point(f.parts[15]!).evidence[0]!)
  expect(correctionContext(f.parts, cross).map(p => p.paragraph_id)).toEqual([1, 2, 3, 4, 5, 13, 14, 15, 16, 17])
  expect(correctionBatches([3, 3, 9, 3, 3, 3], batch => batch.reduce((a, b) => a + b, 0) <= 6)).toEqual({ batches: [[3, 3], [3, 3]], overflow: [9, 3] })
})

it('A02 批返回缺失、重复ID、改别项主张逐项拒收，合法项独立保留且续做零调用', async () => {
  const f = auditFixture('结果为20%。')
  f.call.mockImplementation(async (_t, _s, raw) => {
    const data = JSON.parse(raw)
    if (!data.correction_stage) return JSON.stringify(envelope(Array.from({ length: 5 }, (_, i) => ({ text: '原主张' + i, evidence: point(f.parts[0]!).evidence }))))
    const patch = (id: string) => ({ id, paragraph_id: 0, section: '主要发现', evidence: point(f.parts[0]!).evidence })
    return JSON.stringify({ items: [patch('point:0'), patch('point:2'), patch('point:2'), { ...patch('point:3'), text: '改写另一项主张' }, patch('point:99')] })
  })
  const result = await f.run()
  expect(result.segments.flatMap(s => s.points).map(p => p.text)).toEqual(['原主张0'])
  expect(result.gaps).toHaveLength(4)
  expect(Object.values(result.correction_attempts!).every(a => a.structure === 1)).toBe(true)
  f.call.mockClear(); await f.run(result); expect(f.call).not.toHaveBeenCalled()
})

it('A03 分成三章包的一篇仍最多两批结构纠正', async () => {
  const f = auditFixture('第一段结果。\n\n第二段结果。\n\n第三段结果。')
  let corrections = 0
  f.call.mockImplementation(async (_t, _s, raw) => {
    const data = JSON.parse(raw)
    if (data.correction_stage) { corrections++; return JSON.stringify({ items: data.items.map((item: any) => ({ id: item.id, paragraph_id: item.paragraphs.find((p: any) => p.text === item.validationFeedback.item.evidence[0].quote).paragraph_id, section: '主要发现', evidence: item.validationFeedback.item.evidence })) }) }
    return JSON.stringify(envelope([{ text: data.paragraphs[0].text, evidence: [{ locator: data.paragraphs[0].locator, quote: data.paragraphs[0].text }] }]))
  })
  await f.run(undefined, f.parts.map(p => [p]))
  expect(corrections).toBeLessThanOrEqual(2)
})

it('A04 纠正恶改referent、名称和ID不得进入成果，合法原字段由程序保留', async () => {
  const f = auditFixture('原术语用于研究。')
  f.call.mockImplementation(async (_t, _s, raw) => JSON.stringify(JSON.parse(raw).correction_stage
    ? { items: [{ id: 'term:0', paragraph_id: 0, locator: 'L1-L1', name: '伪名称', referent: '伪指称', note: '伪定义' }, { id: 'point:99', paragraph_id: 0, section: '主要发现', evidence: point(f.parts[0]!).evidence }] }
    : envelope([{ text: '原主张', evidence: point(f.parts[0]!).evidence }], [{ name: '原术语', referent: '原指称', category: '概念', aliases: [], locator: 'L1-L1', note: '原定义' }])))
  const result = await f.run()
  expect(result.segments[0]!.terms).toEqual([{ models: [{ provider: 'mock', model: 'audit' }], name: '原术语', referent: '原指称', category: '概念', aliases: [], locator: 'L1-L1', note: '原定义' }])
  expect(result.segments[0]!.points).toEqual([])
})

it('A05 结构纠正取消后不写回返回值，续做不重复耗尽尝试', async () => {
  const f = auditFixture('结果增加20%。'), abort = new AbortController()
  f.options.signal = abort.signal
  f.call.mockImplementation(async (_t, _s, raw) => {
    if (JSON.parse(raw).correction_stage) { abort.abort(new Error('审查取消')); return JSON.stringify({ items: [{ id: 'point:0', ...point(f.parts[0]!) }] }) }
    return JSON.stringify(envelope([{ text: '结果增加20%。', evidence: point(f.parts[0]!).evidence }]))
  })
  await expect(f.run()).rejects.toThrow('审查取消')
  const progress = f.progress(); expect(progress.segments[0]!.points).toEqual([])
  delete f.options.signal; f.call.mockClear()
  const resumed = await f.run(progress)
  expect(f.call).not.toHaveBeenCalled(); expect(resumed.segments[0]!.points).toEqual([])
})
