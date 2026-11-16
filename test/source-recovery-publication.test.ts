import { unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { hash } from '../src/layered/files.js'
import { readPageObject, versionPage } from '../src/layered/objects.js'
import { storageJson } from '../src/layered/vectors.js'
import { cleanupLayeredFixtures, snapshotManifest } from './layered-fixture.js'
import { sourceRecoveryFixture } from './source-recovery-fixture.js'
import { built } from './tags-anchors-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it.each([false, true])('摘要补缺保留未重建主题的对象、依赖、别名与导航，旧主题状态缺失=%s', async legacy => {
  const f = await sourceRecoveryFixture()
  f.manifest.aliases = { 'T-0099': f.manifest.topics!.topics[0]!.id }
  if (legacy) {
    delete f.manifest.topics
    await unlink(path.join(f.root, 'state/topics.json'))
  }
  await writeFile(path.join(f.root, 'versions', f.manifest.version! + '.json'), JSON.stringify({ checksum: hash(storageJson(f.manifest)), manifest: f.manifest }, null, 2) + '\n')
  const pages = Object.entries(f.manifest.pages!).filter(([page]) => page.startsWith('topics/'))
  const bytes = await Promise.all(pages.map(([, digest]) => readPageObject(f.root, digest)))
  await buildLayeredLibrary({ ...f.options, retrySources: f.retrySources })
  const next = await snapshotManifest(f.root), index = await versionPage(f.root, next, 'index.md')
  expect(next.aliases).toEqual(f.manifest.aliases)
  expect(next.topics).toEqual(f.manifest.topics)
  for (const [offset, [page, digest]] of pages.entries()) {
    expect(next.pages![page]).toBe(digest)
    expect(await versionPage(f.root, next, page)).toBe(bytes[offset])
    expect(next.deps!.pages[page]).toEqual(f.manifest.deps!.pages[page])
    expect(index).toContain(`](${page})`)
  }
  expect(f.calls).toHaveLength(1)
  expect(await buildLayeredLibrary({ ...f.options, retrySources: f.retrySources })).toMatchObject({ unchanged: true, modelCalls: 0 })
  expect(f.calls).toHaveLength(1)
})

it('来源补摘要跳过术语阶段仍保留既有术语整页、分节依赖与索引导航', async () => {
  const f = await built(true), extraction = structuredClone(f.extraction)
  const group = Object.values(extraction.group_cache!)[0]!
  group.missing_summary = true
  extraction.gaps = [{ kind: 'summary', segment_hashes: group.parts.map(part => part.text_hash), item: null,
    reasons: [{ rule: 'summary-support', expected: '有效摘要', actual: '测试摘要缺口' }] }]
  f.entry.extract.path = f.entry.extract.path.replace(/\.json$/, '-summary-gap.json')
  await writeFile(path.join(f.root, f.entry.extract.path), JSON.stringify(extraction, null, 2) + '\n')
  await writeFile(path.join(f.root, 'versions', f.manifest.version! + '.json'), JSON.stringify({ checksum: hash(storageJson(f.manifest)), manifest: f.manifest }, null, 2) + '\n')
  const pages = Object.entries(f.manifest.pages!).filter(([page]) => page.startsWith('terms/'))
  expect(pages.length).toBeGreaterThan(0)
  const bytes = await Promise.all(pages.map(([, digest]) => readPageObject(f.root, digest)))
  f.call.mockClear(); f.call.mockImplementation(async (_task, _prompt, input) => {
    const request = JSON.parse(input)
    expect(request.summary_id).toBeTruthy()
    return JSON.stringify({ point_ids: request.children.flatMap((child: any) => child.points.map((point: any) => point.point_id)).slice(0, request.point_limit) })
  })
  await buildLayeredLibrary({ ...f.options, retrySources: { sourceIds: [f.entry.source_id], kinds: ['summary'] } })
  const next = await snapshotManifest(f.root), index = await versionPage(f.root, next, 'index.md')
  for (const [offset, [page, digest]] of pages.entries()) {
    expect(next.pages![page]).toBe(digest)
    expect(await versionPage(f.root, next, page)).toBe(bytes[offset])
    if (page.includes('/index-')) expect(index).toContain(`](${page})`)
  }
  for (const [page, dependency] of Object.entries(f.manifest.deps!.pages).filter(([page]) => page.startsWith('terms/'))) {
    expect(next.deps!.pages[page]).toEqual({ ...dependency, ...(dependency.children ? { children: dependency.children.map(child => ({ ...child, version: next.version! })) } : {}) })
  }
  expect(f.call).toHaveBeenCalledTimes(1)
})
