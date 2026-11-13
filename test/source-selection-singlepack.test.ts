import { afterEach, expect, it, vi } from 'vitest'
import { cleanupLayeredFixtures } from './layered-fixture.js'
import { extractionFixture, output } from './quality-fix2-audit-fixture.js'
import { selectSourcePoints } from '../src/layered/extraction.js'
import type { Point } from '../src/layered/schema.js'
import { existsSync, readFileSync } from 'node:fs'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('普通论文单包超额先去重复，完整候选入缓存后保留独立方法事实', async () => {
  const f = await extractionFixture('结果提高。样本随机。', { sourceChapterMinPoints: 0 }, 2)
  f.options.granularity = 'custom'
  f.call.mockImplementation(async (_task, _system, raw) => {
    const input = JSON.parse(raw), value = output(input), paragraph = input.paragraphs[0]
    value.points = ['结果提高。', '研究显示结果提高。', '结果提高。', '结果提高。', '样本随机。'].map((text, index) => ({
      paragraph_id: paragraph.paragraph_id, text, section: index === 4 ? '方法' : '主要发现',
      evidence: [{ locator: paragraph.locator, quote: index === 4 ? '样本随机。' : '结果提高。' }],
    }))
    return JSON.stringify(value)
  })
  const result = await f.run()
  expect(result.point_limit).toBe(2)
  expect(result.segments.flatMap(segment => segment.points).map(point => point.text)).toEqual(['结果提高。', '样本随机。'])
  expect(Object.values(result.group_cache!).flatMap(cache => JSON.parse(cache.raw).points)).toHaveLength(5)
  expect(result.truncations).toEqual([{ chunk: 'source', count: 3 }])
})

it('对象与条件中的样本优先保留，背景及一般条件不能占掉局限额度', () => {
  const point = (point_id: string, text: string, section: Point['section']): Point => ({ point_id, text, section,
    text_hash: point_id, locator: 'L1-L1', source_version: 'v1',
    evidence: [{ source_id: 'S-0001', source_version: 'v1', locator: 'L1-L1', quote: text }] })
  const points = [point('a', '该专业的历史背景。', '对象与条件'), point('b', '服务申请条件。', '对象与条件'),
    point('c', '样本18人。', '对象与条件'), point('d', '不包含其他服务提供者视角。', '限制'),
    point('e', '结果提高。', '主要发现'), point('f', '采用主题分析。', '方法')]
  expect([...selectSourcePoints(points, 4, [])]).toEqual(['e', 'c', 'f', 'd'])
})

it.skipIf(!(existsSync(new URL('./fixtures/real20k/source-selection-expanded-s14.json', import.meta.url))))('S14扩额首提237条仍超200时，C036的其他视角及家庭研究局限完整保留（夹具含第三方论文原文，未随公开仓库发布）', () => {
  const { points } = JSON.parse(readFileSync(new URL('./fixtures/real20k/source-selection-expanded-s14.json', import.meta.url), 'utf8')) as { points: Point[] }
  const selected = selectSourcePoints(points, 200, [])
  expect(selected.size).toBe(200)
  const required = points.filter(point => point.evidence.some(evidence => /Other fictional providers|fictional participants, and households/.test(evidence.quote)))
  expect(required).toHaveLength(2)
  for (const point of required) expect(selected.has(point.point_id)).toBe(true)
})
