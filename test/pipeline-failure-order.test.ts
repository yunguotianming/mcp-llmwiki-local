import { setImmediate } from 'node:timers/promises'
import { expect, it } from 'vitest'
import { auditFixture, envelope, point } from './speed-fix-audit-fixture.js'

it('同组两批纠正失败乱序返回，缺口和组缓存与串行逐字节一致', async () => {
  const outputs: string[] = []
  for (const cap of [30, 3, 1]) {
    const f = auditFixture('完整的原始证据。'); f.options.client.concurrency = () => cap
    let batch = 0
    f.call.mockImplementation(async (_task, _prompt, raw) => {
      const input = JSON.parse(raw)
      if (input.correction_stage) {
        const order = batch++
        for (let i = 0; i < (order === 0 ? 5 : 1); i++) await setImmediate()
        return JSON.stringify({ items: [] })
      }
      return JSON.stringify(envelope([point(f.parts[0]!), ...Array.from({ length: 30 }, (_, index) => {
        const item = point(f.parts[0]!, '缺少结构字段的主张' + index)
        delete (item as any).section
        return item
      })]))
    })
    const result = await f.run(undefined, [f.parts], 6000)
    expect(batch).toBe(2)
    expect(result.segments[0]!.points).toHaveLength(1)
    expect(result.gaps).toHaveLength(30)
    outputs.push(JSON.stringify(result))
  }
  expect(outputs[1]).toBe(outputs[0]); expect(outputs[2]).toBe(outputs[0])
})
