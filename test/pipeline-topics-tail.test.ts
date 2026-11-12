import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { cleanupLayeredFixtures, layeredTopicFixture, snapshotManifest, versionFile } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
vi.mock('../src/layered/costs.js', async original => ({ ...await original<typeof import('../src/layered/costs.js')>(),
  meteredOptions: (_root: string, _pending: unknown, options: unknown) => options }))
afterEach(() => { vi.useRealTimers(); cleanupLayeredFixtures() })

it('两支长尾持续拆分、横向身份及发布产物在30、3、1路逐字节相同', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-10T00:00:00Z'))
  const products: string[] = []
  for (const concurrency of [30, 3, 1]) {
    const f = await layeredTopicFixture(), original = f.call.getMockImplementation()!
    f.policy.pageGenerationConcurrency = concurrency
    f.options.topics = { topicMergeMinSources: 1, topicMaxPoints: 1, topicMaxDepth: 1 }
    await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组完整证据。')
    await writeFile(path.join(f.knowledgeRoot, 'b.md'), '乙组完整证据。')
    f.call.mockImplementation(async (...args) => {
      const input = JSON.parse(args[2])
      for (let i = 0; i < (input.topic_id?.startsWith('T-0001') ? 4 : 1); i++) await setImmediate()
      return original(...args)
    })
    const built = await buildLayeredLibrary(f.options), manifest = await snapshotManifest(f.root)
    const pages = await Promise.all(Object.keys(manifest.pages!).sort().map(async page => [page, await versionFile(f.root, built.version, page)]))
    const leaves = Object.entries(manifest.deps!.pages).filter(([page, deps]) => page.startsWith('topics/') && !deps.children?.length)
    expect(leaves).toHaveLength(8)
    expect(new Set(leaves.flatMap(([, deps]) => deps.points.map(point => point.point_id))).size).toBe(8)
    expect(f.topicRequests.filter(request => request.input.points).every(request => request.input.points.length === 1)).toBe(true)
    products.push(JSON.stringify({ pages, deps: manifest.deps, objects: manifest.pages, sequence: manifest.topic_sequence }))
  }
  expect(products[1]).toBe(products[0]); expect(products[2]).toBe(products[0])
})
