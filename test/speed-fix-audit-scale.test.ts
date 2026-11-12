import { expect, it } from 'vitest'
import { auditFixture, envelope, point } from './speed-fix-audit-fixture.js'

it('A16 20篇320项含远端填充正文，纠正调用和单次输入字节均有硬上限', async () => {
  let initial = 0, corrections = 0, maxBytes = 0
  const results = await Promise.all(Array.from({ length: 20 }, async (_, sourceIndex) => {
    // 远端填充仍足以让 16 项重送全文超过纠正预算，局部前后两段与 320 项断言保持。
    const f = auditFixture(Array.from({ length: 15 }, (_, i) => i === 7 ? `论文${sourceIndex}结果增加20%。` : `段${i}。` + '无关的远端正文。'.repeat(i >= 5 && i <= 9 ? 1 : 20)).join('\n\n'))
    const anchor = f.parts[7]!
    f.call.mockImplementation(async (_t, system, raw) => {
      const data = JSON.parse(raw)
      if (!data.correction_stage) { initial++; return JSON.stringify(envelope(Array.from({ length: 16 }, (_, i) => ({ text: '原主张' + i, evidence: point(anchor).evidence })))) }
      corrections++; const bytes = Buffer.byteLength(system + raw); maxBytes = Math.max(maxBytes, bytes)
      expect(bytes).toBeLessThanOrEqual(32000)
      expect(data).not.toHaveProperty('paragraphs')
      for (const item of data.items) expect(item.paragraphs.map((p: any) => p.paragraph_id)).toEqual([5, 6, 7, 8, 9])
      return JSON.stringify({ items: data.items.map((item: any) => ({ id: item.id, paragraph_id: 7, section: '主要发现', evidence: item.validationFeedback.item.evidence })) })
    })
    return f.run()
  }))
  expect(initial).toBe(20); expect(corrections).toBe(20); expect(maxBytes).toBeGreaterThan(0)
  expect(results.reduce((n, r) => n + r.segments.flatMap(s => s.points).length, 0)).toBe(320)
})

it('A17 真实预算分批不超过两批，第三批溢出登记缺口且不重送整包', async () => {
  const f = auditFixture(Array.from({ length: 20 }, (_, i) => `第${i}段` + '研究事实。'.repeat(30)).join('\n\n'))
  const batches: number[] = []
  f.call.mockImplementation(async (_t, system, raw) => {
    const data = JSON.parse(raw)
    if (data.correction_stage) {
      expect(Buffer.byteLength(system + raw)).toBeLessThanOrEqual(6000)
      batches.push(data.items.length)
      return JSON.stringify({ items: data.items.map((item: any) => ({ id: item.id, paragraph_id: item.validationFeedback.item.evidence[0].paragraph_id, section: '主要发现', evidence: item.validationFeedback.item.evidence })) })
    }
    return JSON.stringify(envelope(Array.from({ length: 8 }, (_, i) => ({ text: '主张' + i, evidence: point(f.parts[8]!).evidence }))))
  })
  // 显式章节包用于隔离纠正预算；首提是离线假模型，硬预算只检查实际纠正输入。
  const result = await f.run(undefined, [f.parts], 6000)
  expect(batches).toHaveLength(2)
  expect(result.gaps!.some(g => g.reasons.some(r => r.rule === 'correction-budget'))).toBe(true)
  expect(result.segments.flatMap(s => s.points).length + result.gaps!.length).toBe(8)
})
