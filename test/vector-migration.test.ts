import { copyWithEmbedding } from '../src/layered/query-vectors.js'
import { afterEach, expect, it, vi } from 'vitest'
import { readFile, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { buildLayeredLibrary, revokeLayeredSources } from '../src/layered/index.js'
import { readCurrent, readVersion } from '../src/layered/objects.js'
import { cachedPointVectors } from '../src/layered/embedding.js'
import { readExtraction } from '../src/layered/publication.js'
import { readVectorRecord } from '../src/layered/vectors.js'
import { recordIdentity, sameIdentity } from '../src/layered/vector-identity.js'
import { emptyRegistry } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { WikiQuery } from '../src/wiki/query.js'
import { cleanupLayeredFixtures, layeredTopicFixture, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => { vi.unstubAllGlobals(); cleanupLayeredFixtures() })
async function fixture(model = 'qwen3-embedding:0.6b', dimensions = 2) {
  const f = await layeredTopicFixture()
  const original = f.call.getMockImplementation()!
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (input.term_id) return JSON.stringify({ definition: [{ text: '甲组研究概念', keys: input.contributions.map((item: { key: string }) => item.key) }], usage: [], findings: [], differences: [] })
    const output = JSON.parse(await original(...args))
    if (input.paragraphs) output.terms = [{ paragraph_id: input.paragraphs[0].paragraph_id, name: '甲组研究', aliases: [], category: '概念', referent: '研究对象', locator: input.paragraphs[0].locator, note: '甲组研究概念' }]
    return JSON.stringify(output)
  })
  f.options.topics = { ...f.options.topics || {}, localEmbeddingModel: model, termThreshold50: 1 }
  f.options.embeddingClient = { identity: async () => model + '-weights', embed: async texts => texts.map(() => [1, ...Array(dimensions - 1).fill(0)]) }
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 甲组研究\n\n甲组的研究结论。')
  await buildLayeredLibrary(f.options)
  return f
}

it('不同维度跨库各自嵌入并按库内名次融合，地址和设备默认模型不改变锁定模型', async () => {
  const small = await fixture(), large = await fixture('qwen3-embedding:8b', 4), registry = emptyRegistry(), calls: string[] = []
  for (const [i, f] of [small, large].entries()) {
    f.library.id = 'vector-' + i; f.library.name = '向量库' + i; f.library.wikiPath = f.root
    f.library.layered = { localEmbeddingUrl: 'http://device-' + i, localEmbeddingModel: 'wrong-device-default' }
    registry.libraries.push(f.library)
  }
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const model = String(input).includes('device-0') ? 'qwen3-embedding:0.6b' : 'qwen3-embedding:8b', dimensions = model.endsWith('8b') ? 4 : 2
    if (String(input).endsWith('/api/tags')) return Response.json({ models: [{ name: model, digest: model + '-weights' }] })
    const body = JSON.parse(String(init?.body)); calls.push(body.model)
    expect(body.model).toBe(model); expect(body.input).toHaveLength(1)
    return Response.json({ embeddings: body.input.map(() => [1, ...Array(dimensions - 1).fill(0)]) })
  })
  const result = await new WikiQuery(new LibraryStore(() => registry)).search('甲组研究')
  expect(calls.sort()).toEqual(['qwen3-embedding:0.6b', 'qwen3-embedding:8b'])
  expect(result.groups).toHaveLength(2)
  for (const group of result.groups) {
    expect(group.results.length).toBeGreaterThan(0)
    const first = group.results[0]!
    expect(result.results.find(hit => hit.library === first.library && hit.path === first.path)?.score).toBe(1 / 61)
  }
})

it('复制跨维失败保留源代次，重试发布且术语和页面引用匹配新身份', async () => {
  const f = await fixture('qwen3-embedding:8b', 4096), old = await snapshotManifest(f.root), extractionCalls = f.requests.length
  f.options.topics = { ...f.options.topics || {}, localEmbeddingModel: 'qwen3-embedding:0.6b', embeddingUnavailable: 'continue' }
  let offline = true
  f.options.embeddingClient = { identity: async () => 'small-weights', embed: async inputs => {
    if (offline && inputs.length !== 2) throw new Error('模拟切换途中离线')
    return inputs.map(() => [1, ...Array(1023).fill(0)])
  } }
  await expect(copyWithEmbedding(f.root, { embeddingMode: 'ollama', localEmbeddingModel: 'qwen3-embedding:0.6b' }, true, { embeddingClient: f.options.embeddingClient })).rejects.toThrow('离线')
  expect((await readCurrent(f.root))?.version).toBe(old.version)
  offline = false
  const copied = await copyWithEmbedding(f.root, { embeddingMode: 'ollama', localEmbeddingModel: 'qwen3-embedding:0.6b' }, true, { embeddingClient: f.options.embeddingClient })
  const current = await snapshotManifest(copied.path)
  expect(current.vector_state!.generation).toBe(old.vector_state!.generation + 1)
  expect(current.vector_state!.identity!.dimensions).toBe(1024)
  expect(f.requests).toHaveLength(extractionCalls)
  expect(Object.keys(current.vector_state!.page_vectors!).some(page => page.startsWith('terms/TM-'))).toBe(true)
  for (const page of Object.values(current.vector_state!.page_vectors!)) for (const ref of page.vectors) {
    expect(sameIdentity(current.vector_state!.identity, recordIdentity(await readVectorRecord(copied.path, ref.vector_id)))).toBe(true)
  }
  expect((await readVersion(f.root, old.version!)).vector_state).toEqual(old.vector_state)
})

it('全文库锁定词项身份，复制后启用语义向量补齐全部输入', async () => {
  const f = await layeredTopicFixture(), original = f.options.embeddingClient!
  f.options.topics = { ...f.options.topics || {}, embeddingMode: 'none' }
  const embed = vi.fn(async () => { throw new Error('全文不能调用嵌入') })
  f.options.embeddingClient = { identity: embed, embed }
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组研究证据。')
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '新增甲组证据。')
  await buildLayeredLibrary(f.options)
  const plain = await snapshotManifest(f.root)
  expect(plain.vector_state!.mode).toBe('none'); expect(embed).not.toHaveBeenCalled()
  expect(plain.vector_state!.pending_points).toEqual([])
  const copied = await copyWithEmbedding(f.root, { embeddingMode: 'ollama', localEmbeddingModel: 'qwen3-embedding:0.6b' }, true, { embeddingClient: original })
  const recovered = await snapshotManifest(copied.path)
  expect(recovered.vector_state!.coverage.missing).toEqual([])
  expect(recovered.vector_state!.identity!.provider).toBe('ollama')
  expect(recovered.pages).toEqual(plain.pages)
})

it('离线时删除与撤权先屏蔽旧页，不受暂停策略阻塞', async () => {
  const f = await fixture(), old = await snapshotManifest(f.root)
  f.options.embeddingClient = { identity: async () => { throw new Error('服务离线') }, embed: async () => { throw new Error('服务离线') } }
  await unlink(path.join(f.knowledgeRoot, 'a.md'))
  await expect(buildLayeredLibrary(f.options)).rejects.toThrow('暂停')
  const query = new WikiQuery(new LibraryStore(() => { const registry = emptyRegistry(); f.library.wikiPath = f.root; registry.libraries = [f.library]; return registry }))
  expect((await query.search('甲组研究')).results).toEqual([])
  await revokeLayeredSources(f.knowledgeRoot, [old.sources[0]!.source_id], '合成撤权')
  expect(JSON.parse(await readFile(path.join(f.root, 'state/revocations.json'), 'utf8')).sources.length).toBeGreaterThan(0)
})

it('断点覆盖只读暖缓存且完整身份不符的记录不能算已完成', async () => {
  const f = await fixture(), manifest = await snapshotManifest(f.root), extraction = await readExtraction(f.root, manifest.sources[0]!.extract.path)
  const points = extraction.segments.flatMap(segment => segment.points), identity = manifest.vector_state!.identity!
  expect(Object.keys(await cachedPointVectors(f.root, points, identity))).toHaveLength(points.length)
  expect(await cachedPointVectors(f.root, points, { ...identity, revision: 'different' })).toEqual({})
  expect(await cachedPointVectors(f.root, points, { ...identity, dimensions: 4 })).toEqual({})
})
