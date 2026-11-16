import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { compactCitationVersions, evidenceBlockIds, expandCitationVersions, restoreCitationVersions } from '../src/layered/anchors.js'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { prepareTopics } from '../src/layered/topics.js'
import { hydrateVectors } from '../src/layered/vectors.js'
import type { PendingBuild, Point } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, layeredIncrementalFixture, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

async function fixture() {
  const f = await layeredIncrementalFixture()
  f.options.topics = { topicMergeMinSources: 1, topicMaxChars: 1700 }
  const original = f.call.getMockImplementation()!
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (!input.topic_id || input.review_stage) return original(...args)
    f.topicRequests.push({ system: args[1], input })
    return JSON.stringify({ title: '甲组主题', summary: '甲组研究范围', aliases: [], consensus: [], differences: [],
      conditions: Array.from({ length: 12 }, () => ({ text: input.points.at(-1).text, point_ids: [input.points.at(-1).point_id] })) })
  })
  const source = path.join(f.knowledgeRoot, '研究.md')
  await writeFile(source, '甲组旧证据。')
  await buildLayeredLibrary(f.options)
  const committed = await hydrateVectors(f.root, await snapshotManifest(f.root), true)
  await writeFile(source, '甲组旧证据。\n\n甲组新增证据。')
  await buildLayeredLibrary({ ...f.options, publish: false })
  const pending = await hydrateVectors(f.root, JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8'))) as PendingBuild
  for (const page of Object.values(pending.topics!.pages)) {
    const id = (page as typeof page & { content_id: string }).content_id
    page.content = await readFile(path.join(f.root, 'objects/pages', id.slice(7) + '.md'), 'utf8')
  }
  f.options.vectorIdentity = pending.topics!.state.embedding.identity!
  f.call.mockClear(); f.topicRequests.length = 0
  return { ...f, pending, committed, run: () => prepareTopics(f.root, pending, committed, f.options, undefined) }
}

it('新要点的压缩页经过统一重绑仍保留唯一映射，复用检查点零调用', async () => {
  const f = await fixture(), page = Object.values(f.pending.topics!.pages)[0]!
  expect(page.content).toMatch(/\[S-0001#L3-L3\]/)
  expect(page.content.match(/^- 来源版本：/gm)).toHaveLength(1)
  expect(() => expandCitationVersions(page.content)).not.toThrow()
  const before = page.content
  await f.run()
  expect(Object.values(f.pending.topics!.pages)[0]!.content).toBe(before)
  expect(f.call).not.toHaveBeenCalled()
})

it('检查点缺失映射按当前成员证据本地恢复，反复续跑零调用', async () => {
  const f = await fixture(), page = Object.values(f.pending.topics!.pages)[0]!
  page.content = page.content.replace(/^- 来源版本：[^\n]+\n?/gm, '')
  expect(() => expandCitationVersions(page.content)).toThrow('缺少来源版本')
  await f.run(); await f.run()
  const restored = Object.values(f.pending.topics!.pages)[0]!.content
  expect(restored).toContain('- 来源版本：S-0001@')
  expect(() => expandCitationVersions(restored)).not.toThrow()
  expect(f.call).not.toHaveBeenCalled()
})

it('检查点缺失映射且块证据无效时重新生成，不发布坏页或中止续跑', async () => {
  const f = await fixture(), page = Object.values(f.pending.topics!.pages)[0]!
  page.content = page.content.replace(/^- 来源版本：[^\n]+\n?/gm, '').replace(/#\^p[a-f0-9]+/g, '#^punknown')
  await expect(f.run()).resolves.toBeDefined()
  expect(f.topicRequests).toHaveLength(1)
  const restored = Object.values(f.pending.topics!.pages)[0]!.content
  expect(restored).not.toContain('punknown')
  expect(() => expandCitationVersions(restored)).not.toThrow()
})

it('同来源多版本保留完整引用，混合已压缩引用再次压缩也不丢版本', () => {
  const one = '[S-0001@版本一#L1-L1](../sources/S-0001.md#^p1)'
  const two = '[S-0001@版本二#L2-L2](../sources/S-0001.md#^p2)'
  const full = one + '\n' + two + '\n## 来源导航\n'
  expect(compactCitationVersions(full)).toBe(full)
  expect(expandCitationVersions(full)).toBe(full)
  const mixed = compactCitationVersions(one + '\n## 来源导航\n') + two + '\n'
  const restored = compactCitationVersions(mixed)
  expect(restored).toContain(one); expect(restored).toContain(two)
  expect(restored).not.toContain('[S-0001#')
  expect(() => expandCitationVersions(restored)).not.toThrow()
  expect(compactCitationVersions(restored)).toBe(restored)
})

it('恢复必须同时匹配成员、来源、块和定位，冲突版本仍严格拒绝', () => {
  const point = { point_id: 'S-0001:要点', evidence: [{ source_id: 'S-0001', source_version: '版本一', locator: 'L1-L1', quote: '证据' }] } as Point
  const anchor = evidenceBlockIds([point]).get(point.point_id)![0]
  const citation = `[S-0001#L1-L1](../sources/S-0001.md#^${anchor})`
  expect(restoreCitationVersions(citation, [point])).toContain('[S-0001@版本一#L1-L1]')
  expect(() => restoreCitationVersions(citation, [])).toThrow('唯一恢复')
  expect(() => restoreCitationVersions(citation.replace('L1-L1', 'L2-L2'), [point])).toThrow('唯一恢复')
  expect(() => restoreCitationVersions(citation.replace('sources/S-0001', 'sources/S-0002'), [point])).toThrow('唯一恢复')
  expect(() => restoreCitationVersions(citation + '\n- 来源版本：S-0001@版本一\n- 来源版本：S-0001@版本二\n', [point])).toThrow('不唯一')
  const ambiguous = { ...point, evidence: [...point.evidence, { ...point.evidence[0]!, source_version: '版本二' }] }
  expect(() => restoreCitationVersions(citation, [ambiguous])).toThrow('唯一恢复')
})
