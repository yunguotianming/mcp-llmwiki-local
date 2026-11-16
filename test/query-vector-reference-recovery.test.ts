import { afterEach, expect, it, vi } from 'vitest'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { writeJson } from '../src/layered/files.js'
import { writeVersion } from '../src/layered/objects.js'
import { putVector, readVectorRecord, vectorPath } from '../src/layered/vectors.js'
import { LayeredQuery } from '../src/wiki/layered-query.js'
import { cleanupLayeredFixtures, layeredTopicFixture, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

async function fixture() {
  const f = await layeredTopicFixture()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 研究资料\n\n甲组的研究结果。')
  await buildLayeredLibrary(f.options)
  const manifest = await snapshotManifest(f.root), [pointId, reference] = Object.entries(manifest.topics!.vectors)[0]!
  // 模拟历史库已有对象和缓存，但当前主题映射未收录该要点。
  delete manifest.topics!.vectors[pointId]
  manifest.version = 'v000002'; manifest.topics!.version = manifest.version
  manifest.vector_state!.coverage.missing = [pointId]
  for (const page of Object.values(manifest.deps!.pages)) for (const child of page.children ?? []) child.version = manifest.version
  await writeVersion(f.root, manifest)
  await writeJson(f.root, 'state/current.json', { version: manifest.version, revocation_generation: manifest.revocation_generation, history: ['v000001'] })
  f.library.mode = 'readonly'; f.call.mockClear(); f.embed.mockClear()
  const embed = vi.fn(async (inputs: string[]) => inputs.map(() => [1, 0]))
  const query = new LayeredQuery({ identity: f.options.embeddingClient!.identity!, embed })
  const search = () => query.search(f.library, { root: f.root, card: manifest.card! }, '研究结果')
  const cachePath = path.join(f.root, 'state/embeddings.json'), cacheBytes = await readFile(cachePath)
  const cache = JSON.parse(cacheBytes.toString()) as { format_version: number; vectors: Record<string, { input_hash: string; vector_id: string }> }
  const cacheKey = Object.keys(cache.vectors).find(key => cache.vectors[key]!.input_hash === reference.input_hash)!
  expect(cacheKey).toBeDefined()
  return { ...f, manifest, pointId, reference, search, queryEmbed: embed, cachePath, cacheBytes, cache, cacheKey }
}

it('历史主题漏引用时冷暖查询复用已校验缓存，不补算资料或修改库版本', async () => {
  const f = await fixture()
  const protectedFiles = ['state/current.json', 'versions/v000002.json', 'state/embeddings.json', f.manifest.sources[0]!.extract.path, vectorPath(f.reference.vector_id!)]
  const before = await Promise.all(protectedFiles.map(file => readFile(path.join(f.root, file))))
  for (let round = 0; round < 2; round++) {
    const result = await f.search()
    expect(result.degradation).toBeUndefined()
    expect(result.notices.some(notice => notice.reason === 'partial-coverage')).toBe(false)
    expect(result.value.some(hit => hit.type === 'source' && hit.retrieval === 'hybrid')).toBe(true)
  }
  expect(await Promise.all(protectedFiles.map(file => readFile(path.join(f.root, file))))).toEqual(before)
  expect(f.call).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled()
  expect(f.queryEmbed.mock.calls.flatMap(call => call[0])).toEqual(Array(2).fill('Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: 研究结果'))
})

it('同版本恢复缓存引用后刷新已有查询索引，不沿用缺项引用', async () => {
  const f = await fixture()
  delete f.cache.vectors[f.cacheKey]
  await writeFile(f.cachePath, JSON.stringify(f.cache))
  expect((await f.search()).notices.some(notice => notice.reason === 'partial-coverage')).toBe(true)
  await writeFile(f.cachePath, f.cacheBytes)
  const recovered = await f.search()
  expect(recovered.notices.some(notice => notice.reason === 'partial-coverage')).toBe(false)
  expect(recovered.value.some(hit => hit.retrieval === 'hybrid')).toBe(true)
  expect(f.queryEmbed).toHaveBeenCalledTimes(2); expect(f.embed).not.toHaveBeenCalled(); expect(f.call).not.toHaveBeenCalled()
})

it.each(['模型身份不符', '正文哈希不符'])('缓存%s时仍标缺口，不因文件存在误报完整覆盖', async reason => {
  const f = await fixture(), record = await readVectorRecord(f.root, f.reference.vector_id!)
  const replacement = reason === '模型身份不符'
    ? await putVector(f.root, { ...record.identity, revision: 'other-weights' }, record.vector, record.precision)
    : Object.values(f.manifest.topics!.vectors).find(ref => ref.input_hash !== f.reference.input_hash)!
  f.cache.vectors[f.cacheKey] = { input_hash: f.reference.input_hash, vector_id: replacement.vector_id! }
  await writeFile(f.cachePath, JSON.stringify(f.cache))
  const result = await f.search()
  expect(result.notices).toContainEqual(expect.objectContaining({ reason: 'partial-coverage', message: expect.stringContaining('3/4') }))
  expect(result.value.some(hit => hit.type === 'source')).toBe(true)
  expect(f.queryEmbed).toHaveBeenCalledTimes(1); expect(f.embed).not.toHaveBeenCalled(); expect(f.call).not.toHaveBeenCalled()
})

it('缓存指向已删除对象时保留全文查阅和真实缺口，不生成资料向量', async () => {
  const f = await fixture()
  await unlink(path.join(f.root, vectorPath(f.reference.vector_id!)))
  const result = await f.search()
  expect(result.notices).toContainEqual(expect.objectContaining({ reason: 'partial-coverage', message: expect.stringContaining('3/4') }))
  expect(result.value.some(hit => hit.type === 'source')).toBe(true)
  expect(f.queryEmbed).toHaveBeenCalledTimes(1); expect(f.embed).not.toHaveBeenCalled(); expect(f.call).not.toHaveBeenCalled()
})
