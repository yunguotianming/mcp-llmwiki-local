import { setImmediate } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { layeredSettings } from '../src/domain/config.js'
import { synthesizeSourceSummary } from '../src/layered/longdoc.js'
import { hash } from '../src/layered/files.js'
import { auditFixture, envelope, point } from './speed-fix-audit-fixture.js'

it('同层摘要独立并发，全部支持要点保留，30、3、1路字节一致', async () => {
  const f = auditFixture('第一段研究结果。\n\n第二段研究结果。\n\n第三段研究结果。\n\n第四段研究结果。')
  const initial = await f.run(), points = initial.segments.flatMap(segment => segment.points)
  const keys = points.map((point, index) => '组' + index)
  initial.group_summaries = Object.fromEntries(keys.map((key, index) => [key, { id: key, point_ids: [points[index]!.point_id], missing: [], level: 0, children: [], fingerprint: hash(key) }]))
  const outputs: string[] = []
  for (const concurrency of [30, 3, 1]) {
    const result = structuredClone(initial); let active = 0, peak = 0, calls = 0
    f.options.client.concurrency = () => concurrency
    f.call.mockImplementation(async (_task, _prompt, raw) => {
      const input = JSON.parse(raw)
      peak = Math.max(peak, ++active); calls++
      await setImmediate(); await setImmediate(); active--
      return JSON.stringify({ point_ids: input.children.flatMap((child: any) => child.points.map((point: any) => point.point_id)) })
    })
    await synthesizeSourceSummary(result, keys, f.options, layeredSettings({ sourceSummaryFanout: 2 }), 64000, async () => {}, () => false)
    expect(calls).toBe(3); expect(peak).toBe(Math.min(2, concurrency))
    expect(result.summary!.point_ids).toEqual(points.map(point => point.point_id))
    expect(result.segments).toEqual(initial.segments)
    outputs.push(JSON.stringify(result))
  }
  expect(outputs[1]).toBe(outputs[0]); expect(outputs[2]).toBe(outputs[0])
})

it('同包多章节补提乱序返回后30、3、1路成果与稳定ID逐字节相同', async () => {
  const outputs: string[] = []
  for (const concurrency of [30, 3, 1]) {
    const f = auditFixture('# 甲章\n\n研究发现甲结果。\n\n# 乙章\n\n研究发现乙结果。')
    f.options.client.concurrency = () => concurrency
    f.options.topics = { sourceChapterMinPoints: 1, sourceMetaChapterMinPoints: 0, sourcePackRatio: 0 }
    f.call.mockImplementation(async (_task, _prompt, raw) => {
      const input = JSON.parse(raw)
      if (!input.coverage) return JSON.stringify(envelope([]))
      for (let i = 0; i < (input.paragraphs[0].paragraph_id ? 1 : 5); i++) await setImmediate()
      return JSON.stringify(envelope(input.paragraphs.filter((part: any) => !part.text.startsWith('#')).map((part: any) => point(part))))
    })
    const result = await f.run(undefined, [f.parts])
    expect(result.segments.flatMap(segment => segment.points)).toHaveLength(2)
    outputs.push(JSON.stringify(result))
  }
  expect(outputs[1]).toBe(outputs[0]); expect(outputs[2]).toBe(outputs[0])
})
