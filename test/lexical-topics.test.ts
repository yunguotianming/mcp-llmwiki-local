import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { copyWithEmbedding } from '../src/layered/query-vectors.js'
import { lexicalCorpus } from '../src/layered/lexical-vectors.js'
import { readExtraction } from '../src/layered/publication.js'
import { hydrateVectors, readVectorRecord } from '../src/layered/vectors.js'
import { recordIdentity, sameIdentity } from '../src/layered/vector-identity.js'
import { LayeredQuery } from '../src/wiki/layered-query.js'
import { cleanupLayeredFixtures, layeredTopicFixture, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => { cleanupLayeredFixtures(); vi.unstubAllGlobals() })

async function fixture() {
  const f = await layeredTopicFixture()
  f.options.topics = { ...f.options.topics || {}, embeddingMode: 'none' }
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 甲组\n\n甲组的研究结果。')
  return f
}

it('none先补标再综合主题，零嵌入请求，查询仍为全文且带原有提示', async () => {
  const f = await fixture(), forbidden = vi.fn(() => { throw new Error('不能请求嵌入服务') })
  vi.stubGlobal('fetch', forbidden); f.options.embeddingClient = { identity: forbidden, embed: forbidden }
  await buildLayeredLibrary(f.options)
  const manifest = await snapshotManifest(f.root)
  expect(manifest.vector_state!.identity!.provider).toBe('lexical')
  expect(manifest.vector_state!.coverage.missing).toEqual([]); expect(manifest.vector_state!.pending_points).toEqual([])
  expect(Object.keys(manifest.pages!).filter(page => page.startsWith('topics/'))).toHaveLength(1)
  const stages = f.call.mock.calls.map(args => JSON.parse(args[2]))
  expect(stages.findIndex(input => input.label_stage)).toBeLessThan(stages.findIndex(input => input.topic_id))
  const extraction = await readExtraction(f.root, manifest.sources[0]!.extract.path)
  const expected = lexicalCorpus(extraction.segments.flatMap(segment => segment.points), manifest.point_labels)
  expect(manifest.vector_state!.identity).toEqual(expected.identity)
  const result = await new LayeredQuery({ identity: forbidden, embed: forbidden }).search(f.library, { root: f.root, card: manifest.card! }, '研究结果')
  expect(result.value.some(hit => hit.type === 'topic')).toBe(true)
  expect(result.value.every(hit => hit.retrieval === 'fts')).toBe(true)
  expect(result.notices.some(notice => notice.reason === 'none' && notice.message.includes('本库不使用向量'))).toBe(true)
  expect(forbidden).not.toHaveBeenCalled()
})

it.each(['ollama', 'cloud'] as const)('none复制为%s，缓存身份与全部质心隔离且不重新提取', async mode => {
  const f = await fixture()
  await buildLayeredLibrary(f.options)
  const local = await snapshotManifest(f.root), extractionCalls = f.requests.length
  const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, ...Array(2047).fill(0)]))
  const client = { embed, identity: async () => mode + '-weights' }
  const target = mode === 'ollama' ? { embeddingMode: mode, localEmbeddingModel: 'mock-semantic' }
    : { embeddingMode: mode, cloudEmbeddingUrl: 'https://embedding.invalid/v1', cloudEmbeddingModel: 'mock-semantic', cloudEmbeddingKeyEnv: 'MOCK_KEY' }
  const copied = await copyWithEmbedding(f.root, target, true, { embeddingClient: client, settings: f.options.topics || {} })
  const semantic = await snapshotManifest(copied.path)
  expect(semantic.vector_state!.identity!.provider).toBe(mode)
  expect(semantic.vector_state!.generation).toBe(local.vector_state!.generation + 1)
  expect(embed.mock.calls.flatMap(([texts]) => texts).filter(text => text.includes('甲组的研究结果'))).toHaveLength(4)
  for (const reference of Object.values(semantic.topics!.vectors)) {
    expect(Object.values(local.topics!.vectors).some(old => old.vector_id === reference.vector_id)).toBe(false)
    expect(sameIdentity(semantic.vector_state!.identity, recordIdentity(await readVectorRecord(copied.path, reference.vector_id!)))).toBe(true)
  }
  const hydrated = await hydrateVectors(copied.path, structuredClone(semantic.topics!))
  expect(hydrated.topics.filter(topic => !topic.archived).map(topic => topic.centroid)).toEqual([[1, ...Array(2047).fill(0)]])
  embed.mockClear()
  expect(await buildLayeredLibrary({ ...f.options, wikiPath: copied.path, name: copied.name, topics: { ...f.options.topics || {}, ...target }, embeddingClient: client })).toMatchObject({ unchanged: true, modelCalls: 0 })
  const returned = await snapshotManifest(f.root)
  expect(returned.vector_state!.identity).toEqual(local.vector_state!.identity)
  expect(returned.topics!.vectors).toEqual(local.topics!.vectors)
  expect(returned.vector_state!.page_vectors).toBeUndefined()
  expect(returned).toEqual(local)
  expect(f.requests).toHaveLength(extractionCalls); expect(embed).not.toHaveBeenCalled()
})

it('增量全库IDF重新计算，旧点对象同步换代；无变化续跑零模型零嵌入', async () => {
  const f = await fixture()
  await buildLayeredLibrary(f.options)
  const before = await snapshotManifest(f.root)
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '# 新来源\n\n随机试验需要盲法。')
  await buildLayeredLibrary(f.options)
  const after = await snapshotManifest(f.root)
  expect(after.vector_state!.identity!.revision).not.toBe(before.vector_state!.identity!.revision)
  for (const [id, old] of Object.entries(before.topics!.vectors)) expect(after.topics!.vectors[id]!.vector_id).not.toBe(old.vector_id)
  f.call.mockClear(); f.embed.mockClear()
  expect(await buildLayeredLibrary(f.options)).toEqual({ version: after.version, added: [], modelCalls: 0, unchanged: true })
  expect(f.call).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled()
})

it('30/3/1路建库产生相同词项对象、主题成员和页面内容', async () => {
  const products: string[] = []
  for (const concurrency of [30, 3, 1]) {
    const f = await fixture(); f.policy.pageGenerationConcurrency = concurrency
    await writeFile(path.join(f.knowledgeRoot, 'b.md'), '# 乙组\n\n乙组的研究结果。')
    await writeFile(path.join(f.knowledgeRoot, 'c.md'), '# 丙组\n\n丙组的研究结果。')
    await buildLayeredLibrary(f.options)
    const manifest = await snapshotManifest(f.root)
    // 时间和来源文件 mtime 属于溯源元数据；比较聚类身份、成员和正文。
    const pages = await Promise.all(Object.entries(manifest.pages!).filter(([name]) => name.startsWith('topics/')).sort().map(async ([name, id]) => {
      const content = await readFile(path.join(f.root, 'objects/pages', id.slice(7) + '.md'), 'utf8')
      return [name, content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').replace(/sha256:[a-f0-9]{64}/g, '来源版本')]
    }))
    products.push(JSON.stringify([manifest.vector_state!.identity, manifest.topics!.vectors,
      manifest.topics!.topics.map(topic => [topic.id, topic.point_ids]), pages]))
    expect(f.embed).not.toHaveBeenCalled()
  }
  expect(products[0]).toBe(products[1]); expect(products[1]).toBe(products[2])
})
