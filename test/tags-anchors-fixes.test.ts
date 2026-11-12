import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildLayeredLibrary, readLayeredPage } from '../src/layered/index.js'
import { publicationMetadata } from '../src/layered/frontmatter.js'
import { cleanupLayeredFixtures, snapshotManifest } from './layered-fixture.js'
import { built, header } from './tags-anchors-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
beforeAll(async () => { await built(true) })

it('模型只返回一个标签仍发布，记录不足并在下次运行零调用复用', async () => {
  const f = await built(false, undefined, output => { if (output.tags) output.tags = ['实际主题'] })
  expect(header(await readLayeredPage(f.knowledgeRoot, 'sources/S-0001.md')).tags).toEqual(['实际主题'])
  expect(f.entry.tag_status).toEqual({ message: '标签不足', count: 1, minimum: 3, personal_information_removed: 0 })
  expect(f.extraction.gaps).toEqual([])
  f.call.mockClear()
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ modelCalls: 0, unchanged: true })
  expect(f.call).not.toHaveBeenCalled()
})

it('模型零标签记录不足，合法空结果不会每次建库都被当成坏缓存', async () => {
  const f = await built(false, undefined, output => { if (output.tags) output.tags = [] })
  expect(header(await readLayeredPage(f.knowledgeRoot, 'sources/S-0001.md')).tags).toEqual([])
  expect(f.entry.tag_status).toMatchObject({ message: '标签不足', count: 0, minimum: 3 })
  f.call.mockClear()
  await buildLayeredLibrary(f.options)
  expect(f.call).not.toHaveBeenCalled()
})

it('当前路径的 JSON 缓存损坏时重提并重建依赖主题，损坏字节另留旧成果', async () => {
  const f = await built(true), original = path.join(f.root, f.entry.extract.path)
  await writeFile(original, '{损坏 JSON')
  f.call.mockClear()
  await buildLayeredLibrary(f.options)
  expect(f.call.mock.calls.some(call => JSON.parse(call[2]).paragraphs)).toBe(true)
  const next = (await snapshotManifest(f.root)).sources[0]!
  expect(next.extract.path).not.toBe(f.entry.extract.path)
  expect(await readFile(original, 'utf8')).toBe('{损坏 JSON')
  expect(header(await readLayeredPage(f.knowledgeRoot, 'topics/T-0001.md')).type).toBe('topic')
})

it('篇级缓存必需的证据成员损坏时失效，而非在发布阶段访问空成员', async () => {
  const f = await built(true), value: any = structuredClone(f.extraction)
  value.segments[0].points = [{ ...value.segments.flatMap((segment: any) => segment.points)[0], evidence: [null] }]
  await writeFile(path.join(f.root, f.entry.extract.path), JSON.stringify(value))
  f.call.mockClear()
  await buildLayeredLibrary(f.options)
  expect(f.call.mock.calls.some(call => JSON.parse(call[2]).paragraphs)).toBe(true)
  expect(header(await readLayeredPage(f.knowledgeRoot, 'sources/S-0001.md')).tags).toHaveLength(3)
})

it('非法日历日期与历史 created 不能进入头部，回退的有效时间在状态中固定', () => {
  const pending: any = { manifest: { sources: [], page_created: { 'index.md': '2026-02-30T00:00:00.000Z' } },
    added: [], card: { updated_at: '2026-11-09T00:00:00.000Z' } }
  expect(header(publicationMetadata(pending, 'index.md', '# 索引')).created).toBe(pending.card.updated_at)
  expect(pending.manifest.page_created['index.md']).toBe(pending.card.updated_at)
  pending.card.updated_at = '不是日期'
  expect(header(publicationMetadata(pending, 'index.md', '# 索引')).created).toBe('2026-11-09T00:00:00.000Z')
})
