import { expect, it, vi } from 'vitest'
import { customBook, customBookFixture } from './extraction-custom-book-fixture.js'

vi.mock('../src/layered/files.js', async original => ({ ...await original<typeof import('../src/layered/files.js')>(), writeJson: async () => {}, appendLog: async () => {} }))

it.each([
  ['短书', 'custom', 700, 50], ['短书', 'standard', 700, 50],
  ['长书', 'custom', 10000, 50], ['长书', 'standard', 10000, 100],
] as const)('%s的%s颗粒度遵守篇级上限且不凑满', async (_size, granularity, chars, expected) => {
  const f = customBookFixture(granularity), result = await f.run(customBook(chars)), points = result.segments.flatMap(segment => segment.points)
  expect(result.plan_book).toBe(true)
  expect(result.point_limit).toBe(expected)
  expect(result.plan_quotas!.reduce((sum, quota) => sum + quota, 0)).toBe(expected)
  expect(result.plan_hard_limit).toBe(granularity === 'custom' ? 50 : undefined)
  expect(points.length).toBeGreaterThan(0)
  expect(points.length).toBeLessThan(expected)
  expect(result.calls.every(call => call.input_bytes <= call.input_limit)).toBe(true)
})
