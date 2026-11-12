import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { publishLibrary } from '../src/layered/publication.js'
import { readVectorRecord } from '../src/layered/vectors.js'
import { recordIdentity } from '../src/layered/vector-identity.js'
import { cleanupLayeredFixtures, snapshotManifest } from './layered-fixture.js'
import { auditFixture, copyLargeVectors, largeVectors, preview, products } from './merged-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => { vi.useRealTimers(); cleanupLayeredFixtures() })

it('M01 建库模型往返与复制切换向量的两种顺序同结果，固定成员正文不重写', async () => {
  vi.setSystemTime(new Date('2026-11-10T00:00:00Z'))
  const results: unknown[] = []
  for (const vectorFirst of [false, true]) {
    const f = await auditFixture(2)
    await buildLayeredLibrary(f.options)
    const originalRoot = f.root, old = await snapshotManifest(f.root), before = await products(f)
    f.call.mockClear(); f.embed.mockClear(); f.requests.length = 0
    let upgraded: ReturnType<typeof largeVectors>
    if (vectorFirst) { upgraded = await copyLargeVectors(f); await buildLayeredLibrary(f.options) }
    f.library.models.unified.model = 'flash'; await buildLayeredLibrary(f.options)
    if (!vectorFirst) { upgraded = await copyLargeVectors(f); await buildLayeredLibrary(f.options) }
    f.library.models.unified.model = 'terra'; await buildLayeredLibrary(f.options)
    const now = await snapshotManifest(f.root)
    expect(await snapshotManifest(originalRoot)).toEqual(old)
    expect(f.requests).toHaveLength(0); expect(f.call).not.toHaveBeenCalled()
    expect(upgraded!.mock.calls.map(call => call[0].length)).toEqual([2, 8])
    expect(now.topics!.topics.map(t => t.point_ids)).toEqual(old.topics!.topics.map(t => t.point_ids))
    expect(now.vector_state!.generation).toBe(old.vector_state!.generation + 1)
    for (const ref of Object.values(now.topics!.vectors)) expect(recordIdentity(await readVectorRecord(f.root, ref.vector_id!))).toEqual(now.vector_state!.identity)
    const after = await products(f)
    expect(after.pages.filter(([p]) => p.startsWith('topics/'))).toEqual(before.pages.filter(([p]) => p.startsWith('topics/')))
    results.push({ products: after, identity: now.vector_state!.identity, members: now.topics!.topics.map(t => t.point_ids) })
  }
  expect(results[1]).toEqual(results[0])
})

it('M02 同轮换建库模型并复制切换向量，原库不变且副本重新发布和未变增量零调用', async () => {
  const f = await auditFixture(); await buildLayeredLibrary(f.options)
  const originalRoot = f.root, before = await snapshotManifest(f.root)
  f.library.models.unified.model = 'flash'; await copyLargeVectors(f); f.call.mockClear()
  // 改库说明生成副本预览；来源、成员和正文仍完全相同。
  f.options.domain = '副本说明'
  const pending = await preview(f)
  expect((await snapshotManifest(originalRoot)).vector_state).toEqual(before.vector_state)
  expect(pending.manifest.vector_state!.identity!.model).toBe('qwen3-embedding:8b')
  expect(f.call).not.toHaveBeenCalled()
  await publishLibrary(f.root, pending)
  pending.base_version = (await snapshotManifest(f.root)).version
  const embed = vi.spyOn(f.options.embeddingClient!, 'embed'); embed.mockClear()
  await publishLibrary(f.root, pending)
  await buildLayeredLibrary(f.options)
  expect(f.call).not.toHaveBeenCalled(); expect(embed).not.toHaveBeenCalled()
})

it('M03 30、3、1路的提取补标依赖及全部发布页逐字节一致', async () => {
  vi.setSystemTime(new Date('2026-11-10T00:00:00Z'))
  const outputs: string[] = []
  for (const concurrency of [30, 3, 1]) {
    const f = await auditFixture(3); f.policy.pageGenerationConcurrency = concurrency
    // 保留本项对补标依赖的逐字节验收，显式开启独立补标。
    f.options.topics = { ...f.options.topics || {}, pointLabelsOnBuild: true }
    await buildLayeredLibrary(f.options)
    outputs.push(JSON.stringify(await products(f)))
    f.call.mockClear(); f.embed.mockClear()
    await buildLayeredLibrary(f.options)
    expect(f.call).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled()
  }
  expect(outputs[1]).toBe(outputs[0]); expect(outputs[2]).toBe(outputs[0])
})
