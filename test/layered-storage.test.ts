import { copyWithEmbedding } from '../src/layered/query-vectors.js'
// 20 来源用不同标题区分身份，相同要点仍检验向量去重；同路径新版保留标题满足相似度。
import { readFile, writeFile, readdir, rm, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildLayeredLibrary, readLayeredPage } from '../src/layered/index.js'
import { readVersion, putPage, pageObjectPath } from '../src/layered/objects.js'
import { collectGarbage, pinVersion } from '../src/layered/retention.js'
import { putVector, readVector, encodeVector, decodeVector } from '../src/layered/vectors.js'
import { centroid, normalized, similarity } from '../src/layered/embedding.js'
import { hash, writeJson } from '../src/layered/files.js'
import { layeredIndex } from '../src/storage/jobs.js'
import { LayeredQuery } from '../src/wiki/layered-query.js'
import { initializeStateLayout, migrateDefaultStateLayout } from '../src/storage/paths.js'
import { localDevice } from '../src/layered/devices.js'
import { cleanupLayeredFixtures, layeredIncrementalFixture, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('长文扩额的提取结果可以发布，发布上限与 point_limit 一致', async () => {
  const f = await layeredIncrementalFixture()
  f.options.tier = 5
  f.options.topics = { sourcePointBaseChars: 50, sourcePointMaxMultiplier: 4 }
  f.options.maxInputBytes = 6500
  await writeFile(path.join(f.knowledgeRoot, 'book.md'), Array.from({ length: 8 }, (_, i) => `## 章节${i}\n\n甲组第${i}条结论。${'原文条件。'.repeat(100)}`).join('\n\n'))
  await buildLayeredLibrary(f.options)
  const entry = (await snapshotManifest(f.root)).sources[0]!
  const extraction = JSON.parse(await readFile(path.join(f.root, entry.extract.path), 'utf8'))
  expect(extraction.point_limit).toBe(20)
  expect(extraction.segments.flatMap((segment: any) => segment.points).length).toBeGreaterThan(5)
})

describe('20 来源存储夹具', () => {
let f: Awaited<ReturnType<typeof layeredIncrementalFixture>>
beforeAll(async () => {
  f = await layeredIncrementalFixture()
  f.embed.mockImplementation(async texts => texts.map(() => normalized([0.87654, 0.12345])))
  await Promise.all(Array.from({ length: 20 }, (_, i) => writeFile(path.join(f.knowledgeRoot, `${String(i).padStart(2, '0')}.md`), `# 来源${i}\n\n甲组完全相同的结论。`)))
  await buildLayeredLibrary(f.options)
}, 60_000)
afterAll(async () => {
  if (f) await rm(f.knowledgeRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
}, 60_000)
it('20 来源只存不同输入的二进制向量，float16 检索聚类稳定且 SQLite 可删除重建', async () => {
  const memberships: string[][] = [], rankings: string[][] = []
  for (const precision of ['float32', 'float16'] as const) {
    f.options.topics = { topicMergeMinSources: 1, vectorPrecision: precision }
    if (precision === 'float16') {
      const copied = await copyWithEmbedding(f.root, { embeddingMode: 'ollama', localEmbeddingModel: 'qwen3-embedding:0.6b' }, true, { embeddingClient: f.options.embeddingClient!, settings: f.options.topics })
      f.root = copied.path; f.options.wikiPath = copied.path; f.options.name = copied.name
      expect(copied.generation_calls).toBe(0)
    } else await buildLayeredLibrary(f.options)
    const manifest = await snapshotManifest(f.root)
    expect(manifest.sources).toHaveLength(20)
    // 切换精度后上一版仍引用 float32；每种编码只保存一条实际输入向量。
    expect(await readdir(path.join(f.root, 'objects/vectors'))).toHaveLength(precision === 'float32' ? 1 : 2)
    const ids = Object.values(manifest.topics!.vectors).map(item => item.vector_id!)
    expect(new Set(ids).size).toBe(1)
    const bytes = await readFile(path.join(f.root, 'objects/vectors', ids[0]!.slice(7) + '.bin'))
    const headerLength = bytes.readUInt32LE(4)
    expect(JSON.parse(bytes.subarray(8, 8 + headerLength).toString('utf8')).precision).toBe(precision)
    expect(bytes.length - 8 - headerLength).toBe(precision === 'float16' ? 4 : 8)
    const vector = normalized(await readVector(f.root, ids[0]!))
    expect(similarity(vector, normalized([0.87654, 0.12345]))).toBeGreaterThan(0.99999)
    memberships.push(manifest.topics!.topics.map(topic => topic.point_ids.join(',')))
    const settings = Object.assign(f.library, { wikiPath: f.knowledgeRoot, layered: f.options.topics })
    const layered = { root: f.root, card: manifest.card! }, query = new LayeredQuery(f.options.embeddingClient)
    const first = await query.search(settings, layered, '相同')
    rankings.push(first.value.map(page => page.path))
    const rows = await layeredIndex<{ data: string }[]>(f.root, 'index-read')
    for (const row of rows) expect(row.data).not.toMatch(/"(?:vector|pointVectors|centroid)"\s*:/)
    for (const folder of ['state', 'versions', 'work']) for (const name of await readdir(path.join(f.root, folder), { recursive: true })) {
      if (!name.endsWith('.json')) continue
      expect(await readFile(path.join(f.root, folder, name), 'utf8')).not.toMatch(/"(?:vector|centroid)"\s*:\s*\[/)
    }
    const before = await readFile(path.join(f.root, 'wiki/sources/S-0001.md'), 'utf8')
    await rm(path.join(f.root, 'cache'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
    expect(await readLayeredPage(f.knowledgeRoot, 'S-0001')).toBe(before)
    expect((await query.search(settings, layered, '相同')).value.map(page => page.path)).toEqual(rankings.at(-1))
  }
  expect(memberships[0]).toEqual(memberships[1]); expect(rankings[0]).toEqual(rankings[1])
}, 60_000)
})

it('三次增量后仅留当前和上版，页面共用并保护进程内读者与未完成作业', async () => {
  const f = await layeredIncrementalFixture()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组固定。')
  const first = await buildLayeredLibrary(f.options), old = await readVersion(f.root, first.version)
  const pinned = await pinVersion(f.root)
  for (let i = 0; i < 3; i++) {
    await writeFile(path.join(f.knowledgeRoot, 'b.md'), `乙组第${i}次修改。`)
    await buildLayeredLibrary(f.options)
  }
  expect(await readdir(path.join(f.root, 'versions'))).toHaveLength(3)
  expect(await readLayeredPage(f.knowledgeRoot, 'S-0001')).toBe(await readFile(path.join(f.root, pageObjectPath(old.pages!['sources/S-0001.md']!)), 'utf8'))
  pinned.release()
  const workObject = await putPage(f.root, '未完成任务独占的正文')
  await writeJson(f.root, 'work/fixture.json', { content_id: workObject })
  await collectGarbage(f.root)
  const names = await readdir(path.join(f.root, 'versions'))
  expect(names.sort()).toEqual(['v000003.json', 'v000004.json'])
  const manifests = await Promise.all(names.map(name => readVersion(f.root, name.slice(0, -5))))
  expect(manifests.map(value => value.pages!['sources/S-0001.md'])).toEqual([old.pages!['sources/S-0001.md'], old.pages!['sources/S-0001.md']])
  const reachable = new Set(manifests.flatMap(value => Object.values(value.pages!)))
  expect((await readdir(path.join(f.root, 'objects/pages'))).length).toBe(reachable.size + 1)
  expect(await readFile(path.join(f.root, pageObjectPath(workObject)), 'utf8')).toBe('未完成任务独占的正文')
})

it('异机可查不可建，显式接管生效，缺对象回退整版且无完整版本时明确报错', async () => {
  const f = await layeredIncrementalFixture()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 稳定来源\n\n甲组旧版。')
  await buildLayeredLibrary(f.options)
  await writeJson(f.root, 'state/writer.json', { id: '另一台电脑', name: '原建库电脑' })
  expect(await readLayeredPage(f.knowledgeRoot, 'S-0001')).toContain('甲组旧版')
  await expect(buildLayeredLibrary(f.options)).rejects.toThrow('原建库电脑')
  await expect(buildLayeredLibrary(f.options)).rejects.toThrow('接管建库设备')
  f.options.topics = { ...f.options.topics, writerTakeoverToken: '01234567-1234-1234-1234-012345678901' }
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 稳定来源\n\n甲组新版。')
  const built = await buildLayeredLibrary(f.options), latest = await readVersion(f.root, built.version)
  const writer = JSON.parse(await readFile(path.join(f.root, 'state/writer.json'), 'utf8'))
  expect(writer.id).toBe((await localDevice()).id)
  await writeJson(f.root, 'state/writer.json', { ...writer, id: '再次接管的设备', takeover: '最新接管操作' })
  await expect(buildLayeredLibrary(f.options)).rejects.toThrow('接管建库设备')
  await writeJson(f.root, 'state/writer.json', writer)
  await rm(path.join(f.root, pageObjectPath(latest.pages!['sources/S-0001.md']!)))
  const pinned = await pinVersion(f.root)
  expect(pinned.manifest.version).toBe('v000001'); expect(pinned.warning).toContain('更新未完整'); pinned.release()
  expect(await readLayeredPage(f.knowledgeRoot, 'S-0001')).toContain('甲组旧版')
  const previous = await readVersion(f.root, 'v000001')
  await rm(path.join(f.root, pageObjectPath(previous.pages!['index.md']!)))
  await expect(readLayeredPage(f.knowledgeRoot)).rejects.toThrow('更新未完整')
})

it('旧分层格式不迁移，旧流程不能触碰分层 state；向量校验和与零向量回退保持', async () => {
  const f = await layeredIncrementalFixture()
  await mkdir(path.join(f.root, 'state'), { recursive: true })
  await writeFile(path.join(f.root, 'library.yaml'), 'format_version: 1\n')
  await writeFile(path.join(f.root, 'state/preserved.json'), '{"保留":true}')
  await expect(buildLayeredLibrary(f.options)).rejects.toThrow('请重建')
  await expect(initializeStateLayout(f.root)).rejects.toThrow('分层')
  await expect(migrateDefaultStateLayout(f.root)).rejects.toThrow('分层')
  expect(await readFile(path.join(f.root, 'state/preserved.json'), 'utf8')).toBe('{"保留":true}')
  expect(await readdir(f.knowledgeRoot)).toEqual(['.llmwiki'])
  for (const precision of ['float32', 'float16'] as const) {
    expect(decodeVector(encodeVector([0, -0, 1, -2, 2 ** -24], precision), precision)).toEqual([0, -0, 1, -2, 2 ** -24])
    const value = await putVector(f.root, { provider: 'mock', model: 'm', revision: 'weights', preprocessing: 'v1', dimensions: 2, input_hash: hash('输入') }, [1, 0], precision)
    expect(centroid([value.vector, value.vector.map(x => -x)])).toEqual([1, 0])
    const filename = path.join(f.root, 'objects/vectors', value.vector_id.slice(7) + '.bin'), bytes = await readFile(filename)
    bytes[bytes.length - 1] ^= 1; await writeFile(filename, bytes)
    await expect(readVector(f.root, value.vector_id)).rejects.toThrow('校验和')
  }
})
