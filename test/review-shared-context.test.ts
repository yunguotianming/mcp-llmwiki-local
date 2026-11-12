import { expect, it } from 'vitest'
import { extractionReviewPrompt, reviewExtraction, reviewOutput } from '../src/layered/review.js'
import { jsonProtocol, schemaJSON } from '../src/llm/protocol.js'
import { layeredSettings } from '../src/domain/config.js'
import { reviewContextTable } from '../src/layered/evidence.js'
import { matchQuotation } from '../src/layered/quotation.js'
import { separateImages } from '../src/ingest/markdown.js'
import { locatorRange } from '../src/layered/schema.js'
import { point, reviewFixture } from './quality-fix2-audit-fixture.js'

// 固定旧版平铺算法，独立比较每个要点实际可见的原文字节。
function legacy(f: ReturnType<typeof reviewFixture>, full: boolean) {
  const lines = f.source.text.split(/\r?\n/)
  return f.extraction.segments.flatMap(segment => segment.points).map((p, index) => ({ id: 'P' + (index + 1), text: p.text, section: p.section,
    ...(full ? { source_context: separateImages(f.source.text).text } : {}), evidence: p.evidence.map(e => {
      const segment = f.source.segments[0]!
      const [first, last] = e.locator.startsWith('block:') ? [1, lines.length] : locatorRange(e.locator)
      const body = e.locator.startsWith('block:') ? f.source.text.slice(segment.start, segment.end) : lines.slice(first - 1, last).join('\n')
      const match = matchQuotation(body, e.quote)
      const start = first - 1 + (body.slice(0, match?.start ?? 0).match(/\n/g) ?? []).length
      const end = start + ((match?.quote ?? e.quote).match(/\n/g) ?? []).length
      const context = lines.slice(Math.max(0, start - 2), end + 3).join('\n')
      return { quote: e.quote, locator: e.locator, context: /data:image\//i.test(context) ? separateImages(context).text : context }
    }) }))
}

async function verify(f: ReturnType<typeof reviewFixture>, full = false) {
  const old = legacy(f, full)
  await reviewExtraction(f.extraction, f.source, f.options, 1000000)
  const request = JSON.parse(f.call.mock.calls[0]![2])
  const expanded = request.points.map(({ source_context_ref, evidence, ...p }: any) => ({ ...p,
    ...(source_context_ref ? { source_context: request.contexts[source_context_ref].text } : {}),
    evidence: evidence.map(({ context_ref, ...e }: any) => ({ ...e, context: request.contexts[context_ref].text })) }))
  expect(Buffer.from(JSON.stringify(expanded))).toEqual(Buffer.from(JSON.stringify(old)))
  return { request, old }
}

it('相同范围上下文只发送一份，展开逐字节相同且请求变小', async () => {
  const f = reviewFixture(Array.from({ length: 20 }, (_, i) => point('结果提高。' + i, '主要发现', 'p' + i)))
  f.source.text = f.source.text.replace('前二', '原文未删减'.repeat(100))
  f.source.segments[0]!.end = f.source.text.length
  const { request, old } = await verify(f)
  expect(Object.keys(request.contexts)).toHaveLength(1)
  expect(Buffer.byteLength(JSON.stringify(request))).toBeLessThan(Buffer.byteLength(JSON.stringify({ review_stage: 'extraction', source_id: 'S-0001', points: old })))
})

it('多个全文缺省断言共用一次全文，局部范围不附全文', async () => {
  const f = reviewFixture([point('文中未报告样本量。', '主要发现', 'a'), point('全文未披露样本量。', '主要发现', 'b')])
  const { request } = await verify(f, true)
  expect(request.points[0].source_context_ref).toBe(request.points[1].source_context_ref)
  expect(Object.values(request.contexts).filter((c: any) => c.range === 'full')).toHaveLength(1)
  const local = await verify(reviewFixture([point('本段未报告样本量。')]))
  expect(local.request.points[0].source_context_ref).toBeUndefined()
})

it('CRLF、多行引文与图片隔离仍逐字节等价', async () => {
  const f = reviewFixture()
  f.source.text = '远处\r\n前二\r\n前一\r\n结果提高。\r\n完整补充。\r\n![图](data:image/png;base64,YQ==)\r\n后二'
  f.source.segments[0]!.end = f.source.text.length
  f.extraction.segments[0]!.points[0]!.evidence[0] = { source_id: 'S-0001', source_version: 'v1', locator: 'L4-L5', quote: '结果提高。\r\n完整补充。' }
  await verify(f)
})

it('思源块内邻文按块及行范围共享，不跨来源或版本串用', async () => {
  const f = reviewFixture([point('结果提高。', '主要发现', 'a'), point('结果提高。', '主要发现', 'b')])
  f.source.segments[0]!.locator = 'block:20261111000000-abcdefg'
  for (const p of f.extraction.segments[0]!.points) p.evidence[0]!.locator = f.source.segments[0]!.locator
  const { request } = await verify(f)
  expect(Object.keys(request.contexts)).toHaveLength(1)
  const table = reviewContextTable()
  const refs = [table.reference('S1', 'v1', 'L1', '甲'), table.reference('S2', 'v1', 'L1', '甲'), table.reference('S1', 'v2', 'L1', '乙')]
  expect(new Set(refs).size).toBe(3)
  expect(() => table.reference('S1', 'v1', 'L1', '乙')).toThrow('不一致')
})

it('单项恰好装满旧预算时回退平铺，不因字典开销丢失原本可核对的证据', async () => {
  const f = reviewFixture([point('文中未报告样本量。')])
  f.source.text += '完整原文'.repeat(200)
  f.source.segments[0]!.end = f.source.text.length
  const input = JSON.stringify({ review_stage: 'extraction', source_id: 'S-0001', points: legacy(f, true) })
  const limit = Math.ceil(Buffer.byteLength(jsonProtocol(extractionReviewPrompt, schemaJSON(reviewOutput)) + input) / layeredSettings().extractCeilingRatio)
  await reviewExtraction(f.extraction, f.source, f.options, limit)
  expect(f.call).toHaveBeenCalledTimes(1)
  expect(f.call.mock.calls[0]![2]).toBe(input)
  expect(f.extraction.segments[0]!.points[0]!.verification?.status).toBe('verified')
})
