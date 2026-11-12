import { afterEach, expect, it, vi } from 'vitest'
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { LayeredQuery } from '../src/wiki/layered-query.js'
import { cleanupLayeredFixtures, layeredTopicFixture, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
async function fixture(none = false) {
  const f = await layeredTopicFixture()
  if (none) f.options.topics = { embeddingMode: 'none' }
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 甲组\n\n甲组的研究结果。')
  await buildLayeredLibrary(f.options)
  const manifest = await snapshotManifest(f.root)
  f.library.mode = 'readonly'
  return { ...f, manifest, layered: { root: f.root, card: manifest.card! } }
}

it('不使用向量不探测不嵌入，来源页全文可查并保留不使用向量提示', async () => {
  const f = await fixture(true), embed = vi.fn(), identity = vi.fn()
  const result = await new LayeredQuery({ embed, identity }).search(f.library, f.layered, '研究结果')
  expect(result.value.some(hit => hit.type === 'source')).toBe(true)
  expect(result.value.every(hit => hit.retrieval === 'fts')).toBe(true)
  expect(result.notices.some(notice => notice.reason === 'none')).toBe(true)
  expect(embed).not.toHaveBeenCalled(); expect(identity).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled()
  expect(f.manifest.vector_state?.pending_points.length).toBeGreaterThan(0)
})

it('同维不同权重的只读设备只走全文，失败缓存一分钟且不写库身份', async () => {
  const f = await fixture(), identity = vi.fn(async () => 'another-weights'), embed = vi.fn(async (input: string[]) => input.map(() => [1, 0]))
  const before = await readFile(path.join(f.root, 'state/current.json')), query = new LayeredQuery({ identity, embed })
  const result = await query.search(f.library, f.layered, '研究结果')
  expect(result.degradation?.reason).toContain('身份')
  expect(result.value.every(hit => hit.retrieval === 'fts')).toBe(true)
  await query.search(f.library, f.layered, '甲组')
  expect(identity).toHaveBeenCalledTimes(1); expect(embed).not.toHaveBeenCalled()
  expect(await readFile(path.join(f.root, 'state/current.json'))).toEqual(before)
  expect((await snapshotManifest(f.root)).vector_state).toEqual(f.manifest.vector_state)
})

it('丢失所有向量仍读取当前页面并全文检索，不补写向量', async () => {
  const f = await fixture(), folder = path.join(f.root, 'objects/vectors')
  for (const file of await readdir(folder)) await unlink(path.join(folder, file))
  const result = await new LayeredQuery(f.options.embeddingClient).search(f.library, f.layered, '研究结果')
  expect(result.value.some(hit => hit.type === 'source')).toBe(true)
  expect(result.value.every(hit => hit.retrieval === 'fts')).toBe(true)
  expect(result.notices.some(notice => notice.reason === 'partial-coverage')).toBe(true)
  expect(await readdir(folder)).toEqual([])
})

it('不同设备地址不改变完整身份；查询应用锁定的前处理且只嵌入查询词', async () => {
  const f = await fixture(), embed = vi.fn(async (input: string[]) => input.map(() => [1, 0]))
  f.library.layered = { localEmbeddingUrl: 'http://another-device:11434', localEmbeddingModel: 'default-that-does-not-matter' }
  const result = await new LayeredQuery({ identity: async () => 'fixture-weights-v1', embed }).search(f.library, f.layered, '甲组')
  expect(result.degradation).toBeUndefined()
  expect(result.value.some(hit => hit.retrieval === 'hybrid')).toBe(true)
  expect(embed).toHaveBeenCalledTimes(1)
  expect(embed.mock.calls[0]![0]).toEqual(['Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: 甲组'])
})

it('查询维度漂移立即退回全文，不能比较不同向量空间', async () => {
  const f = await fixture()
  const result = await new LayeredQuery({ identity: async () => 'fixture-weights-v1', embed: async input => input.map(() => [1, 0, 0]) }).search(f.library, f.layered, '甲组')
  expect(result.degradation).toBeDefined()
  expect(result.value.every(hit => hit.retrieval === 'fts')).toBe(true)
})
