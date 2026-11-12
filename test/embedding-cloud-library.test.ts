import { randomUUID } from 'node:crypto'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { emptyRegistry } from '../src/domain/config.js'
import { exportConfig, importConfig } from '../src/domain/config-io.js'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { readExtraction } from '../src/layered/publication.js'
import { copyWithEmbedding } from '../src/layered/query-vectors.js'
import { safePath } from '../src/storage/paths.js'
import { hydrateVectors, readVectorRecord } from '../src/layered/vectors.js'
import { libraryVectorState, recordIdentity } from '../src/layered/vector-identity.js'
import { LayeredQuery } from '../src/wiki/layered-query.js'
import { cleanupLayeredFixtures, layeredTopicFixture, snapshotManifest } from './layered-fixture.js'
import type { PendingBuild } from '../src/layered/schema.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
const cloud = { cloudEmbeddingUrl: 'https://embedding.invalid/v1', cloudEmbeddingModel: 'test-embedding', cloudEmbeddingKeyEnv: 'LLMWIKI_TEST_CLOUD_KEY' }
let key: string
beforeEach(() => { key = randomUUID(); vi.stubEnv(cloud.cloudEmbeddingKeyEnv, key) })
afterEach(() => { cleanupLayeredFixtures(); vi.unstubAllEnvs(); vi.unstubAllGlobals() })
async function fixture(mode: 'ollama' | 'cloud', withTerms = false) {
  const f = await layeredTopicFixture()
  f.options.topics = { ...f.options.topics || {}, ...cloud, embeddingMode: mode }
  if (withTerms) {
    f.options.topics.termThreshold50 = 1
    const original = f.call.getMockImplementation()!
    f.call.mockImplementation(async (...args) => {
      const input = JSON.parse(args[2])
      if (input.term_id) return JSON.stringify({ definition: [{ text: '甲组研究概念', keys: input.contributions.map((item: { key: string }) => item.key) }], usage: [], findings: [], differences: [] })
      const output = JSON.parse(await original(...args))
      if (input.paragraphs) output.terms = [{ paragraph_id: input.paragraphs[0].paragraph_id, name: '甲组研究', aliases: [], category: '概念', referent: '研究对象', locator: input.paragraphs[0].locator, note: '甲组研究概念' }]
      return JSON.stringify(output)
    })
  }
  delete f.options.embeddingClient
  f.library.wikiPath = f.root; f.library.sourceRoots = [f.knowledgeRoot]
  f.library.layered = { ...f.options.topics }
  let offline = false
  const request = vi.fn<typeof fetch>(async (url, init) => {
    const address = String(url)
    if (address === 'http://127.0.0.1:11434/api/tags') return Response.json({ models: [{ name: 'qwen3-embedding:0.6b', digest: 'local-weights', capabilities: ['embedding'] }] })
    if (address !== cloud.cloudEmbeddingUrl + '/embeddings' && address !== 'http://127.0.0.1:11434/api/embed') throw new Error('测试禁止未声明的网络请求')
    const input = JSON.parse(String(init!.body)).input as string[]
    if (address.endsWith('/api/embed')) return Response.json({ embeddings: input.map(() => [1, 0]) })
    if (offline) return new Response(key, { status: 401 })
    return Response.json({ data: input.map((_, index) => ({ index, embedding: [1, 0, 0] })) })
  })
  vi.stubGlobal('fetch', request)
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 甲组\n\n甲组的研究结果。')
  await buildLayeredLibrary(f.options)
  return { ...f, request, offline: (value: boolean) => { offline = value } }
}
async function pendingOf(root: string): Promise<PendingBuild> {
  return hydrateVectors(root, JSON.parse(await readFile(path.join(root, 'work/pending.json'), 'utf8')))
}
async function noSecret(root: string) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  for (const entry of entries.filter(entry => entry.isFile())) expect((await readFile(path.join(entry.parentPath, entry.name))).includes(Buffer.from(key))).toBe(false)
}

it.each(['ollama', 'cloud'] as const)('L01 %s复制切换另一供应商，全库重嵌入、零提取、源库保持且密钥不落盘', async mode => {
  const f = await fixture(mode, true), old = await snapshotManifest(f.root)
  const next = mode === 'ollama' ? 'cloud' : 'ollama'
  f.call.mockClear(); f.requests.length = 0; f.request.mockClear()
  const target = next === 'cloud' ? { ...cloud, embeddingMode: next } : { embeddingMode: next, localEmbeddingModel: 'qwen3-embedding:0.6b' }
  const copied = await copyWithEmbedding(f.root, target, true, { settings: f.options.topics || {} })
  const manifest = await snapshotManifest(copied.path), state = manifest.vector_state!
  expect(f.requests).toHaveLength(0); expect(f.call).not.toHaveBeenCalled()
  expect((await snapshotManifest(f.root)).vector_state).toEqual(old.vector_state)
  expect(state.mode).toBe(next); expect(state.generation).toBe(old.vector_state!.generation + 1)
  expect(state.identity!.provider).toBe(next); expect(state.identity!.dimensions).toBe(next === 'cloud' ? 3 : 2)
  expect(state.coverage.missing).toEqual([]); expect(state.page_vectors!['sources/S-0001.md']).toBeDefined()
  const points = (await Promise.all(manifest.sources.map(source => readExtraction(copied.path, source.extract.path)))).flatMap(extraction => extraction.segments.flatMap(segment => segment.points))
  const sent = f.request.mock.calls.filter(([url]) => String(url).endsWith(next === 'cloud' ? '/embeddings' : '/api/embed')).flatMap(([, init]) => JSON.parse(String(init!.body)).input as string[])
  for (const point of points) expect(sent.filter(text => text === point.text)).toHaveLength(1)
  expect(sent.filter(text => text === '甲组研究')).toHaveLength(1)
  expect(Object.keys(state.page_vectors!).some(page => page.startsWith('terms/TM-'))).toBe(true)
  for (const page of Object.values(state.page_vectors!)) for (const ref of page.vectors)
    expect(recordIdentity(await readVectorRecord(copied.path, ref.vector_id))).toEqual(state.identity)
  for (const ref of Object.values(manifest.topics!.vectors)) expect(recordIdentity(await readVectorRecord(copied.path, ref.vector_id!))).toEqual(state.identity)
  expect(manifest.pages).toEqual(old.pages)
  expect(manifest.topics!.topics).toEqual(old.topics!.topics)
  const query = await new LayeredQuery().search(f.library, { root: f.root, card: old.card! }, '研究结果')
  expect(query.view.version).toBe(old.version); expect(query.degradation).toBeUndefined()
  expect(query.value.some(hit => hit.retrieval === 'hybrid')).toBe(true)
  const serialized = exportConfig({ ...emptyRegistry(), libraries: [f.library] })
  expect(serialized).not.toContain(key); expect(serialized).toContain(cloud.cloudEmbeddingKeyEnv)
  expect(importConfig(serialized, emptyRegistry(), 'replace').libraries[0]!.layered).toEqual(f.library.layered)
  expect(await readFile(await safePath(copied.path, `versions/${copied.version}.json`), 'utf8')).not.toContain(key)
  await noSecret(f.root); await noSecret(copied.path)
  const now = await snapshotManifest(copied.path)
  expect(now.vector_state!.mode).toBe(next)
  if (next === 'cloud') {
    delete now.vector_state
    expect((await libraryVectorState(copied.path, now))!.identity).toEqual(state.identity)
  }
})

it('L02 云端离线默认暂停保留断点，换密钥变量续跑零重提且不换代次', async () => {
  const f = await fixture('cloud'), old = await snapshotManifest(f.root)
  f.options.previewContext = { registrationKey: JSON.stringify({ id: 'library', layered: f.options.topics }), policyRevision: 'fixed' }
  f.offline(true)
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '# 乙\n\n甲组的新增研究结果。')
  await expect(buildLayeredLibrary(f.options)).rejects.toThrow('暂停')
  const pending = await pendingOf(f.root)
  expect(pending.paused!.reason).toBe('embedding'); expect(pending.manifest.sources).toHaveLength(2)
  expect(pending.manifest.vector_state!.identity).toEqual(old.vector_state!.identity)
  expect((await snapshotManifest(f.root)).version).toBe(old.version)
  await noSecret(f.root)
  f.requests.length = 0; f.call.mockClear(); f.offline(false)
  vi.stubEnv('LLMWIKI_TEST_ROTATED_KEY', key)
  f.options.topics = { ...f.options.topics || {}, cloudEmbeddingKeyEnv: 'LLMWIKI_TEST_ROTATED_KEY' }
  f.options.previewContext.registrationKey = JSON.stringify({ id: 'library', layered: f.options.topics })
  await buildLayeredLibrary(f.options)
  expect(f.requests).toHaveLength(0)
  const recovered = await snapshotManifest(f.root)
  expect(recovered.vector_state!.coverage.missing).toEqual([])
  expect(recovered.vector_state!.generation).toBe(old.vector_state!.generation)
})

it('L03 云端离线继续保留旧主题并发布待归属要点，恢复补齐', async () => {
  const f = await fixture('cloud'), old = await snapshotManifest(f.root)
  f.options.topics = { ...f.options.topics || {}, embeddingUnavailable: 'continue' }
  f.offline(true)
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '# 乙\n\n甲组的新增研究结果。')
  await buildLayeredLibrary(f.options)
  const deferred = await snapshotManifest(f.root)
  expect(deferred.topics!.topics.map(topic => topic.point_ids)).toEqual(old.topics!.topics.map(topic => topic.point_ids))
  expect(deferred.vector_state!.pending_points.length).toBeGreaterThan(0)
  expect(deferred.vector_state!.coverage.missing.length).toBeGreaterThan(0)
  f.offline(false); f.requests.length = 0
  await buildLayeredLibrary(f.options)
  const recovered = await snapshotManifest(f.root)
  expect(recovered.vector_state!.pending_points).toEqual([]); expect(recovered.vector_state!.coverage.missing).toEqual([])
  expect(recovered.vector_state!.identity).toEqual(old.vector_state!.identity); expect(f.requests).toHaveLength(0)
})

it('L04 云端查询不可用降级全文并标注，日志和库文件不含密钥', async () => {
  const f = await fixture('cloud'), old = await snapshotManifest(f.root), warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  f.offline(true); f.request.mockClear()
  const result = await new LayeredQuery().search(f.library, { root: f.root, card: old.card! }, '研究结果')
  expect(result.degradation).toMatchObject({ stage: 'embedding', retrieval: 'fts' })
  expect(result.degradation!.message).toContain('降级')
  expect(result.value.some(hit => hit.type === 'source')).toBe(true)
  expect(result.value.every(hit => hit.retrieval === 'fts')).toBe(true)
  expect(f.request).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(warn.mock.calls) + JSON.stringify(result.degradation)).not.toContain(key)
  expect((await snapshotManifest(f.root)).vector_state).toEqual(old.vector_state)
  await noSecret(f.root)
})
