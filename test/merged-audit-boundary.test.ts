import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary, readLayeredPage } from '../src/layered/index.js'
import { readExtraction } from '../src/layered/publication.js'
import { topicHeader } from '../src/layered/topics.js'
import { cleanupLayeredFixtures, snapshotManifest } from './layered-fixture.js'
import { auditFixture, pendingOf } from './merged-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('M20 权重漂移无显式切换默认暂停，跨建库模型恢复只补缺项', async () => {
  const f = await auditFixture(); await buildLayeredLibrary(f.options)
  const old = await snapshotManifest(f.root), client = f.options.embeddingClient!
  f.options.embeddingClient = { ...client, identity: async () => '同名新权重' }
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '甲组新增证据。')
  await expect(buildLayeredLibrary(f.options)).rejects.toThrow('暂停')
  const pending = await pendingOf(f.root)
  expect(pending.paused!.reason).toBe('embedding')
  expect((await snapshotManifest(f.root)).version).toBe(old.version)
  expect(pending.manifest.vector_state!.identity).toEqual(old.vector_state!.identity)
  f.library.models.unified.model = 'flash'; f.options.embeddingClient = client
  f.requests.length = 0; f.call.mockClear(); f.embed.mockClear()
  await buildLayeredLibrary(f.options)
  const now = await snapshotManifest(f.root)
  expect(f.requests).toHaveLength(0)
  expect(f.call.mock.calls.map(c => JSON.parse(c[2])).filter(d => d.label_stage)).toHaveLength(0)
  expect(f.embed.mock.calls.flatMap(c => c[0])).toHaveLength(4)
  expect(now.vector_state!.identity).toEqual(old.vector_state!.identity)
  expect(now.vector_state!.coverage.missing).toEqual([])
})

it('M21 离线继续的合法新来源恢复归属后导航页头同步，待归属标记清空', async () => {
  const f = await auditFixture(); await buildLayeredLibrary(f.options)
  const embed = f.embed.getMockImplementation()!
  f.options.topics = { ...f.options.topics || {}, embeddingUnavailable: 'continue' }
  f.embed.mockRejectedValue(new Error('合成离线'))
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '甲组新增证据。')
  await buildLayeredLibrary(f.options)
  expect((await snapshotManifest(f.root)).vector_state!.pending_points).toHaveLength(4)
  f.embed.mockImplementation(embed); f.requests.length = 0
  await buildLayeredLibrary(f.options)
  const now = await snapshotManifest(f.root), topic = now.topics!.topics[0]!
  const page = await readLayeredPage(f.knowledgeRoot, topic.path)
  expect(now.vector_state!.pending_points).toEqual([])
  expect(now.sources.every(s => !s.pending_topic_points)).toBe(true)
  expect(topicHeader(page)).toMatchObject({ title: topic.title, sources: ['S-0001', 'S-0002'] })
  expect(page.split('## 来源导航')[1]).toContain('S-0002')
  expect(await readLayeredPage(f.knowledgeRoot)).toContain(topic.title)
  expect(f.requests).toHaveLength(0)
})

it('M22 提取含篡改数字的引文只记缺口，逐字正确项保留且不中止发布', async () => {
  const f = await auditFixture(), original = f.call.getMockImplementation()!
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组经验3至28年，免费重考。')
  f.call.mockImplementation(async (...args) => {
    const d = JSON.parse(args[2])
    if (d.correction_stage) return '{"items":[]}'
    const output = JSON.parse(await original(...args))
    if (d.paragraphs) output.points.push({ ...structuredClone(output.points[0]), text: '甲组经验3至99年。', evidence: [{ locator: d.paragraphs[0].locator, quote: '甲组经验3至99年，免费重考。' }] })
    return JSON.stringify(output)
  })
  await buildLayeredLibrary(f.options)
  const manifest = await snapshotManifest(f.root), extraction = await readExtraction(f.root, manifest.sources[0]!.extract.path)
  expect(extraction.segments.flatMap(s => s.points)).toHaveLength(4)
  expect(extraction.gaps!.some(gap => gap.kind === 'point')).toBe(true)
  const page = await readLayeredPage(f.knowledgeRoot, 'sources/S-0001.md')
  expect(page).toContain('3至28年'); expect(page).not.toContain('99年')
})
