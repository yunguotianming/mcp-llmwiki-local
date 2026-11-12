import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary, readLayeredPage } from '../src/layered/index.js'
import { reusableExtraction } from '../src/layered/extraction.js'
import { cleanupLayeredFixtures, snapshotManifest } from './layered-fixture.js'
import { extractionFixture, output } from './quality-fix2-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('未核实缺口随提取成果落盘并进入报告，缓存可复用且增量不重试', async () => {
  const f = await extractionFixture('结果尚无证据。')
  f.call.mockImplementation(async (_task, _system, raw) => {
    const input = JSON.parse(raw)
    if (input.review_stage === 'extraction') return JSON.stringify({ items: input.points.map((p: any) => ({ id: p.id, support: '不支撑', missing: '样本证据不足' })) })
    if (input.review_stage === 'extraction-correction') return JSON.stringify({ ...input.validationFeedback.item, support: '不支撑', missing: '样本证据不足' })
    return JSON.stringify(output(input))
  })
  await buildLayeredLibrary(f.options)
  const manifest = await snapshotManifest(f.root), source = manifest.sources[0]!
  const extraction = JSON.parse(await readFile(path.join(f.root, source.extract.path), 'utf8'))
  expect(reusableExtraction(extraction)).toBe(true)
  expect(extraction.gaps).toEqual([expect.objectContaining({ kind: 'unverified_claim',
    item: { source_id: source.source_id, point_id: extraction.segments[0].points[0].point_id, reason: '样本证据不足' } })])
  expect(await readFile(path.join(f.root, 'logs/build.md'), 'utf8')).toContain('未核实要点')
  const page = await readLayeredPage(f.knowledgeRoot, 'sources/S-0001.md')
  expect(page).toContain('要点未核实'); expect(page).not.toContain('术语未保留')
  f.call.mockClear()
  expect((await buildLayeredLibrary(f.options)).modelCalls).toBe(0)
  expect(f.call).not.toHaveBeenCalled()
})
