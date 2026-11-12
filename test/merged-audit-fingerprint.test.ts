import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { publishLibrary } from '../src/layered/publication.js'
import { prepareTopics } from '../src/layered/topics.js'
import { prepareVectorRun } from '../src/layered/vector-build.js'
import { libraryVectorState } from '../src/layered/vector-identity.js'
import { cleanupLayeredFixtures, snapshotManifest } from './layered-fixture.js'
import { auditFixture, copyLargeVectors, largeVectors, preview } from './merged-audit-fixture.js'
import type { SnapshotManifest } from '../src/layered/schema.js'

const prompt = vi.hoisted(() => ({ suffix: '' }))
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
vi.mock('../src/llm/protocol.js', async original => {
  const protocol = await original<typeof import('../src/llm/protocol.js')>()
  return { ...protocol, jsonProtocol: (...args: Parameters<typeof protocol.jsonProtocol>) => protocol.jsonProtocol(...args) + prompt.suffix }
})
afterEach(() => { prompt.suffix = ''; cleanupLayeredFixtures() })
const empty = (): SnapshotManifest => ({ format_version: 2, version: null, next_source_number: 1, revocation_generation: 0, sources: [] })

it('M04 只换建库模型不改变主题配置与构建指纹，不补标不重写', async () => {
  const f = await auditFixture(), first = await preview(f)
  f.library.models.unified.model = 'flash'; f.call.mockClear(); f.embed.mockClear()
  const next = structuredClone(first)
  await prepareTopics(f.root, next, empty(), { ...f.options, vectorIdentity: next.manifest.vector_state!.identity }, undefined)
  expect(next.topics!.configuration_fingerprint).toBe(first.topics!.configuration_fingerprint)
  expect(next.topics!.fingerprint).toBe(first.topics!.fingerprint)
  expect(f.call).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled()
})

it('M05 复制切换向量模型改变构建指纹但不改变正文配置指纹', async () => {
  const f = await auditFixture(), first = await preview(f)
  await publishLibrary(f.root, first)
  const originalRoot = f.root, original = await snapshotManifest(f.root)
  await copyLargeVectors(f)
  const committed = await snapshotManifest(f.root), next = { ...structuredClone(first), manifest: structuredClone(committed) }
  const options = await prepareVectorRun(f.root, next, committed, f.options)
  f.call.mockClear()
  await prepareTopics(f.root, next, committed, options, undefined)
  expect(next.topics!.configuration_fingerprint).toBe(first.topics!.configuration_fingerprint)
  expect(next.topics!.fingerprint).not.toBe(first.topics!.fingerprint)
  expect(next.topics!.point_hashes).toEqual(first.topics!.point_hashes)
  expect(f.call).not.toHaveBeenCalled()
  expect(await snapshotManifest(originalRoot)).toEqual(original)
})

it('M06 提示词正文改变但版本号不变使主题配置指纹失效', async () => {
  const f = await auditFixture(), first = await preview(f), next = structuredClone(first)
  prompt.suffix = '\n必须保留原文数值条件。'; vi.resetModules()
  const changed = await import('../src/layered/topics.js')
  await changed.prepareTopics(f.root, next, empty(), { ...f.options, vectorIdentity: next.manifest.vector_state!.identity }, undefined)
  expect(next.topics!.configuration_fingerprint).not.toBe(first.topics!.configuration_fingerprint)
  expect(next.topics!.fingerprint).not.toBe(first.topics!.fingerprint)
})

it('M07 改颗粒度重提一次；相同成员不改变主题正文配置，后续增量零调用', async () => {
  const f = await auditFixture(), first = await preview(f)
  await publishLibrary(f.root, first); f.requests.length = 0
  f.options.tier = 75
  const next = await preview(f)
  expect(f.requests).toHaveLength(1)
  expect(next.manifest.sources[0]!.extract.processing_fingerprint).not.toBe(first.manifest.sources[0]!.extract.processing_fingerprint)
  expect(next.topics!.configuration_fingerprint).toBe(first.topics!.configuration_fingerprint)
  await publishLibrary(f.root, next); f.call.mockClear(); f.embed.mockClear()
  await buildLayeredLibrary(f.options)
  expect(f.call).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled()
})

it('M08 旧库移除新增身份字段后从8b向量头恢复，新默认不能触发切换', async () => {
  const f = await auditFixture(); largeVectors(f)
  const first = await preview(f), legacy = structuredClone(first.manifest)
  legacy.version = 'v000001'; legacy.topics = first.topics!.state
  delete legacy.vector_state; delete legacy.topics.embedding.identity
  for (const source of legacy.sources) delete source.models
  const restored = await libraryVectorState(f.root, legacy)
  expect(restored!.identity!.model).toBe('qwen3-embedding:8b')
  const next = structuredClone(first); next.manifest = structuredClone(legacy)
  f.options.topics = { topicMergeMinSources: 1 }
  f.call.mockClear(); const embed = vi.spyOn(f.options.embeddingClient!, 'embed'); embed.mockClear()
  await prepareVectorRun(f.root, next, legacy, f.options)
  expect(next.manifest.vector_state!.identity).toEqual(restored!.identity)
  expect(next.manifest.vector_state!.generation).toBe(restored!.generation)
  expect(embed).not.toHaveBeenCalled(); expect(f.call).not.toHaveBeenCalled()
})
