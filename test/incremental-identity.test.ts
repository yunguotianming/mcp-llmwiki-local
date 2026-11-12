import { readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary, readLayeredDocument, readLayeredPage } from '../src/layered/index.js'
import { sourceSimilarity } from '../src/ingest/source-identity.js'
import type { Extraction } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, layeredIncrementalFixture, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
const extraction = async (root: string, file: string): Promise<Extraction> => JSON.parse(await readFile(path.join(root, file), 'utf8'))

it('三文件循环重编号先对应内容，来源要点主题身份全部保留且零调用', async () => {
  const f = await layeredIncrementalFixture()
  const names = ['01.md', '02.md', '03.md'], texts = ['甲组文档一。', '甲组文档二。', '乙组文档三。']
  for (let i = 0; i < names.length; i++) await writeFile(path.join(f.knowledgeRoot, names[i]!), texts[i]!)
  await buildLayeredLibrary(f.options)
  const before = await snapshotManifest(f.root)
  const points = await Promise.all(before.sources.map(source => extraction(f.root, source.extract.path)))
  f.call.mockClear(); f.requests.length = 0
  for (let i = 0; i < names.length; i++) await writeFile(path.join(f.knowledgeRoot, names[(i + 1) % 3]!), texts[i]!)
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ modelCalls: 0, added: [] })
  expect(f.call).not.toHaveBeenCalled()
  const after = await snapshotManifest(f.root)
  for (let i = 0; i < before.sources.length; i++) {
    const old = before.sources[i]!, next = after.sources.find(source => source.source_id === old.source_id)!
    expect(next).toMatchObject({ current_path: names[(i + 1) % 3], content_hash: old.content_hash, previous_paths: [names[i]] })
    expect(await extraction(f.root, next.extract.path)).toEqual(points[i])
    expect(await readLayeredPage(f.knowledgeRoot, 'sources/' + old.source_id + '.md')).toContain(texts[i])
  }
  expect(after.topics?.topics.map(topic => [topic.id, topic.point_ids, topic.sources])).toEqual(before.topics?.topics.map(topic => [topic.id, topic.point_ids, topic.sources]))
})

it('同路径高重合修改保留身份和旧段要点，手改来源页冲突保留', async () => {
  const f = await layeredIncrementalFixture(), file = path.join(f.knowledgeRoot, '原稿.md')
  await writeFile(file, '甲组固定甲。\n\n甲组固定乙。\n\n甲组旧结论。')
  await buildLayeredLibrary(f.options)
  const old = (await snapshotManifest(f.root)).sources[0]!, before = await extraction(f.root, old.extract.path)
  await writeFile(path.join(f.root, 'wiki/sources/' + old.source_id + '.md'), '用户手改保留')
  await writeFile(file, '甲组固定甲。\n\n甲组固定乙。\n\n甲组新结论。')
  f.requests.length = 0
  await buildLayeredLibrary(f.options)
  const next = (await snapshotManifest(f.root)).sources[0]!, after = await extraction(f.root, next.extract.path)
  expect(next.source_id).toBe(old.source_id)
  expect(after.segments.slice(0, 2).map(segment => segment.points.map(point => point.point_id))).toEqual(before.segments.slice(0, 2).map(segment => segment.points.map(point => point.point_id)))
  expect(f.requests.flatMap(request => request.input.paragraphs.map(part => part.text))).toEqual(['甲组新结论。'])
  expect(await readFile(path.join(f.root, 'wiki/sources/' + old.source_id + '.md'), 'utf8')).toBe('用户手改保留')
  expect(sourceSimilarity(['a', 'a', 'b'], ['a', 'c'])).toBe(0.5)
})

it('同路径低重合与路径内容同时变化均新建身份并撤销旧来源', async () => {
  const f = await layeredIncrementalFixture(), file = path.join(f.knowledgeRoot, '原稿.md')
  await writeFile(file, '甲组旧文档。'); await buildLayeredLibrary(f.options)
  const first = (await snapshotManifest(f.root)).sources[0]!
  await writeFile(file, '乙组另一篇内容。'); await buildLayeredLibrary(f.options)
  const second = (await snapshotManifest(f.root)).sources[0]!
  expect(second.source_id).not.toBe(first.source_id)
  expect((await readLayeredDocument(f.knowledgeRoot, 'sources/' + first.source_id + '.md')).status).not.toBe('ok')
  await rename(file, path.join(f.knowledgeRoot, '改名.md'))
  await writeFile(path.join(f.knowledgeRoot, '改名.md'), '乙组改名后新内容。'); await buildLayeredLibrary(f.options)
  const third = (await snapshotManifest(f.root)).sources[0]!
  expect(third.source_id).not.toBe(second.source_id)
  const manifest = await snapshotManifest(f.root)
  expect(Object.values(manifest.deps!.pages).flatMap(page => page.sources)).not.toContain(first.source_id)
  expect(Object.values(manifest.deps!.pages).flatMap(page => page.sources)).not.toContain(second.source_id)
})

it('新增相同副本只保留一个来源，删别名与删原件均复用，全部删才撤权', async () => {
  const f = await layeredIncrementalFixture(), original = path.join(f.knowledgeRoot, '原稿.md'), copy = path.join(f.knowledgeRoot, '副本.md')
  await writeFile(original, '甲组唯一内容。'); await buildLayeredLibrary(f.options)
  const old = (await snapshotManifest(f.root)).sources[0]!
  f.call.mockClear(); await writeFile(copy, '甲组唯一内容。')
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ modelCalls: 0, added: [] })
  let sources = (await snapshotManifest(f.root)).sources
  expect(sources).toHaveLength(1); expect(sources[0]).toMatchObject({ source_id: old.source_id, current_path: '原稿.md', alias_paths: ['副本.md'] })
  const page = await readLayeredPage(f.knowledgeRoot, 'sources/' + old.source_id + '.md')
  expect(page).toContain('原稿.md'); expect(page).toContain('副本.md')
  await unlink(copy); expect(await buildLayeredLibrary(f.options)).toMatchObject({ modelCalls: 0 })
  expect((await snapshotManifest(f.root)).sources[0]?.alias_paths ?? []).toEqual([])
  await writeFile(copy, '甲组唯一内容。'); await buildLayeredLibrary(f.options)
  await unlink(original); expect(await buildLayeredLibrary(f.options)).toMatchObject({ modelCalls: 0 })
  sources = (await snapshotManifest(f.root)).sources
  expect(sources).toHaveLength(1); expect(sources[0]).toMatchObject({ source_id: old.source_id, current_path: '副本.md', previous_paths: expect.arrayContaining(['原稿.md']) })
  expect(f.call).not.toHaveBeenCalled()
  await unlink(copy); await buildLayeredLibrary(f.options)
  expect((await snapshotManifest(f.root)).sources).toEqual([])
  expect((await readLayeredDocument(f.knowledgeRoot, 'sources/' + old.source_id + '.md')).status).not.toBe('ok')
})

it('首扫多个相同副本只提取一次，相似度设置影响同路径修改判定', async () => {
  const f = await layeredIncrementalFixture()
  for (const name of ['a.md', 'b.md', 'c.md']) await writeFile(path.join(f.knowledgeRoot, name), '甲组固定。\n\n甲组旧段。')
  await buildLayeredLibrary(f.options)
  expect(f.requests).toHaveLength(1); expect((await snapshotManifest(f.root)).sources).toHaveLength(1)
  const oldId = (await snapshotManifest(f.root)).sources[0]!.source_id
  for (const name of ['b.md', 'c.md']) await unlink(path.join(f.knowledgeRoot, name))
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组固定。\n\n甲组新段。')
  await buildLayeredLibrary({ ...f.options, topics: { sourceMatchThreshold: 0.6, topicMergeMinSources: 1 } })
  expect((await snapshotManifest(f.root)).sources[0]!.source_id).not.toBe(oldId)
})
