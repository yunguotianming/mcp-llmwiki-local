import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { cleanupLayeredFixtures, layeredFixture } from './layered-fixture.js'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))
vi.mock('../src/layered/publication.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/layered/publication.js')>(),
  publishLibrary: vi.fn().mockResolvedValue('v000001'),
}))
afterEach(cleanupLayeredFixtures)
describe('分层提取五档契约', () => {
  it.each([5, 25, 50, 75, 100] as const)('档位 %i 写入指纹并限制整篇要点数', async tier => {
    const fixture = await layeredFixture()
    await writeFile(path.join(fixture.knowledgeRoot, 'source.md'), '# 原文\n\n有依据的结论。')
    await buildLayeredLibrary({ ...fixture.options, tier })
    const pending = JSON.parse(await readFile(path.join(fixture.root, 'work/pending.json'), 'utf8'))
    const entry = pending.manifest.sources[0]!
    const extraction = JSON.parse(await readFile(path.join(fixture.root, entry.extract.path), 'utf8'))
    expect(entry.extract.processing.tier).toBe(tier)
    expect(extraction.processing.tier).toBe(tier)
    const points = extraction.segments.flatMap((segment: { points: { point_id: string; text_hash: string }[] }) => segment.points)
    expect(points.length).toBeLessThanOrEqual(tier)
    for (const point of points) expect(point.point_id).toMatch(new RegExp(`^S-0001:${point.text_hash}:\\d{2,}$`))
    expect(fixture.requests).toHaveLength(1)
    expect(fixture.requests[0]!.input.point_limit).toBe(tier >= 25 ? 5 : tier) // 单包对适中及以上档短文降额；篇级扩额只放宽截断阈值。
  })
})
