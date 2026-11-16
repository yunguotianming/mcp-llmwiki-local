import { expect, it } from 'vitest'
import { selectSourcePoints } from '../src/layered/extraction.js'
import type { Point } from '../src/layered/schema.js'

const point = (point_id: string, text: string): Point => ({ point_id, text, section: '主要发现', text_hash: point_id,
  locator: 'L1-L1', source_version: 'v1', evidence: [{ source_id: 'S-0001', source_version: 'v1', locator: 'L1-L1', quote: text }] })

it('章节底线不重新选入同主张同证据，余量保留独立事实', () => {
  const points = [point('A1', '甲研究纳入20人。'), point('A2', '甲研究纳入20人。'), point('B1', '乙研究随访6个月。')]
  expect([...selectSourcePoints(points, 2, [{ ids: new Set(['A1', 'A2']), minimum: 2 }])]).toEqual(['A1', 'B1'])
})

it('跨章及不同数值的独立主张仍按底线保留，不合并真实差异', () => {
  const points = [point('A1', '甲研究纳入20人。'), point('A2', '甲研究纳入30人。'), point('B1', '乙研究随访6个月。')]
  expect([...selectSourcePoints(points, 2, [{ ids: new Set(['B1']), minimum: 1 },
    { ids: new Set(['A1', 'A2']), minimum: 1 }])]).toEqual(['B1', 'A1'])
  expect([...selectSourcePoints(points, 3, [{ ids: new Set(['A1', 'A2']), minimum: 2 }])]).toEqual(['A1', 'A2', 'B1'])
})
