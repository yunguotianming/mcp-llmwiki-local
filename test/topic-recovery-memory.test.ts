import { readdir, unlink } from 'node:fs/promises'
import { afterEach, expect, expectTypeOf, it, vi } from 'vitest'
import { layeredSettings } from '../src/domain/config.js'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { hash, writeJson } from '../src/layered/files.js'
import * as vectors from '../src/layered/vectors.js'
import { prepareTopics, previousState } from '../src/layered/topics.js'
import type { PendingBuild, TopicState } from '../src/layered/schema.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'
import { pendingFixture } from './pipeline-audit-fixture.js'
import { built } from './tags-anchors-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => { vi.unstubAllGlobals(); cleanupLayeredFixtures() })

function largeVectors(): TopicState['vectors'] {
  // 64 MiB 原始双精度数据；深克隆会另分配整库数值和数组槽位。
  return Object.fromEntries(Array.from({ length: 2048 }, (_, index) => [
    'synthetic:' + index, { vector_id: hash('vector-' + index), input_hash: hash('input-' + index),
      vector: Array.from({ length: 4096 }, (_, dimension) => dimension === index % 4096 ? 1 : 0) },
  ]))
}

it('大型向量状态定向续建保持页面与范围，克隆共享只读向量而元数据独立', async () => {
  const f = await pendingFixture(), original = structuredClone(f.pending), target = original.topics!.state.topics[0]!
  const options = { ...f.options, retryTopics: { topicIds: [target.id] } }
  const missing = (pending: PendingBuild) => {
    delete pending.topics!.pages[target.path]
    pending.topics!.gaps = [{ topic_id: target.id, point_ids: target.point_ids, message: 'Connection error.' }]
  }
  missing(f.pending)
  await prepareTopics(f.root, f.pending, f.committed, options, undefined)
  const expected = structuredClone(f.pending.topics!.pages)
  for (const file of await readdir(f.root + '/cache/tasks')) await unlink(f.root + '/cache/tasks/' + file)
  f.pending = original
  const baseline = f.pending.topics!.state
  Object.assign(baseline.vectors, largeVectors())
  const before = vectors.storageJson(baseline.vectors)
  await writeJson(f.root, 'state/topics.json', { ...baseline, version: 'v-obsolete' })
  missing(f.pending)
  f.call.mockClear(); f.topicRequests.splice(0)
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('禁止网络调用') }))
  await prepareTopics(f.root, f.pending, f.committed, options, undefined)
  expect(f.pending.topics!.pages).toEqual(expected)
  expect(f.pending.topic_scope!.completed).toEqual([target.id])
  expect(f.call.mock.calls.every(call => JSON.parse(call[2]).topic_id === target.id)).toBe(true)
  const cloned = f.pending.topics!.state
  expectTypeOf<TopicState['vectors'][string]['vector']>().toEqualTypeOf<readonly number[]>()
  expect(cloned).not.toBe(baseline)
  expect(cloned.vectors).not.toBe(baseline.vectors)
  expect(Object.keys(cloned.vectors)).toHaveLength(Object.keys(baseline.vectors).length)
  for (const id of Object.keys(baseline.vectors)) {
    expect(cloned.vectors[id]).not.toBe(baseline.vectors[id])
    expect(cloned.vectors[id]!.vector).toBe(baseline.vectors[id]!.vector)
  }
  cloned.vectors['synthetic:0']!.vector = [7]
  expect(baseline.vectors['synthetic:0']!.vector[0]).toBe(1)
  expect(vectors.storageJson(baseline.vectors)).toBe(before)
  expect(fetch).not.toHaveBeenCalled()
}, 30_000)

it('过期主题缓存先判版本再水合，合法旧引用仍恢复且写出字节不变', async () => {
  const f = await built('topics'), state = f.manifest.topics!, deps = f.manifest.deps!
  const stale = { ...state, version: 'v-obsolete', vectors: largeVectors() }
  await writeJson(f.root, 'state/topics.json', stale)
  const hydrate = vi.spyOn(vectors, 'hydrateVectors')
  const restored = await previousState(f.root, f.manifest, deps, layeredSettings(f.options.topics || {}))
  expect(hydrate.mock.calls.some(([, value]) => (value as TopicState)?.version === 'v-obsolete')).toBe(false)
  expect(vectors.storageJson(restored)).toBe(vectors.storageJson(state))
  await writeJson(f.root, 'state/topics.json', state)
  const valid = await previousState(f.root, f.manifest, deps, layeredSettings(f.options.topics || {}))
  expect(vectors.storageJson(valid)).toBe(vectors.storageJson(state))
})

it('检查点基线不匹配时零向量水合并保留检查点', async () => {
  const f = await pendingFixture()
  f.pending.base_version = 'v-obsolete'
  await writeJson(f.root, 'work/pending.json', f.pending)
  const hydrate = vi.spyOn(vectors, 'hydrateVectors')
  f.call.mockClear()
  await expect(buildLayeredLibrary(f.options)).rejects.toThrow('待更新清单基线不匹配')
  expect(hydrate).not.toHaveBeenCalled()
  expect(f.call).not.toHaveBeenCalled()
})

it('定向检查点嵌入身份不匹配时先拒绝而不水合', async () => {
  const f = await built('topics'), target = f.manifest.topics!.topics[0]!
  const state = structuredClone(f.manifest.topics!)
  state.embedding.identity!.revision = '不同权重'
  const pending: PendingBuild = { format_version: 2, base_version: f.manifest.version, version: null,
    manifest: structuredClone(f.manifest), card: f.manifest.card!, added: [], model_calls: 0, started_at: new Date().toISOString(),
    topic_scope: { targets: [target.id], completed: [] },
    topics: { fingerprint: '', state, pages: {}, rewritten: [], model_calls: 0 } }
  await writeJson(f.root, 'work/pending.json', pending)
  const hydrate = vi.spyOn(vectors, 'hydrateVectors')
  f.call.mockClear()
  await expect(buildLayeredLibrary(f.options)).rejects.toMatchObject({ code: 'TOPIC_SCOPE_EMBEDDING_CHANGED' })
  expect(hydrate).not.toHaveBeenCalled()
  expect(f.call).not.toHaveBeenCalled()
})
