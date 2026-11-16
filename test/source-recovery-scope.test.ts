import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { sourceRecoveryFixture, sourceRecoveryExtraction } from './source-recovery-fixture.js'
import type { PendingBuild } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, hydratedState, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('摘要-only只派发所选摘要，有限预算不重分旧计划，旧点/向量/范围外来源与主题保持', async () => {
  const f = await sourceRecoveryFixture(), before = await sourceRecoveryExtraction(f.root, f.manifest, 'S-0001')
  const outside = await readFile(path.join(f.root, f.manifest.sources[1]!.extract.path))
  const vectors = await readFile(path.join(f.root, 'state/embeddings.json'))
  const result = await buildLayeredLibrary({ ...f.options, maxInputBytes: 1600, retrySources: f.retrySources })
  const next = await snapshotManifest(f.root), after = await sourceRecoveryExtraction(f.root, next, 'S-0001')
  expect(result.modelCalls).toBe(1)
  expect(f.calls.map(call => call.source_id)).toEqual(['S-0001'])
  expect(after.segments).toEqual(before.segments)
  expect(after.chunk_plan).toEqual(before.chunk_plan)
  expect(after.plan_quotas).toEqual(before.plan_quotas)
  expect(next.sources[1]).toEqual(f.manifest.sources[1])
  expect(await readFile(path.join(f.root, next.sources[1]!.extract.path))).toEqual(outside)
  expect(await readFile(path.join(f.root, 'state/embeddings.json'))).toEqual(vectors)
  expect(next.vector_state).toEqual(f.manifest.vector_state)
  expect(next.topics).toEqual(f.manifest.topics)
  expect(next.topic_gaps).toEqual(f.manifest.topic_gaps)
  expect(f.embed).not.toHaveBeenCalled()
})

it('无有效成员的组留下排除原因，保留旧点且重复同范围零派发', async () => {
  const f = await sourceRecoveryFixture(true), before = await sourceRecoveryExtraction(f.root, f.manifest, 'S-0001')
  await buildLayeredLibrary({ ...f.options, retrySources: f.retrySources })
  const next = await snapshotManifest(f.root), after = await sourceRecoveryExtraction(f.root, next, 'S-0001')
  expect(after.segments).toEqual(before.segments)
  expect(Object.values(after.group_cache!)[0]!.summary_excluded_reason).toContain('无可用摘要依据')
  expect(Object.values(after.group_cache!)[0]!.missing_summary).toBe(false)
  expect(f.call).not.toHaveBeenCalled()
  expect(await buildLayeredLibrary({ ...f.options, retrySources: f.retrySources })).toMatchObject({ modelCalls: 0, unchanged: true })
  expect(f.call).not.toHaveBeenCalled()
})

it('范围外新增资料在派发及发布前暂停', async () => {
  const f = await sourceRecoveryFixture(), current = await readFile(path.join(f.root, 'state/current.json'))
  await writeFile(path.join(f.knowledgeRoot, 'c.md'), '范围外新增事实。')
  await expect(buildLayeredLibrary({ ...f.options, retrySources: f.retrySources })).rejects.toThrow('新增、修改、删除或改名')
  expect(f.call).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled()
  expect(await readFile(path.join(f.root, 'state/current.json'))).toEqual(current)
})

it('暂停续做锁定同一范围，不同范围报错，省略选择器仍只继续原单元', async () => {
  const f = await sourceRecoveryFixture(), respond = f.call.getMockImplementation()!
  f.call.mockImplementation(async (...args) => { throw Object.assign(new Error('测试预算暂停'), { budgetPause: true }) })
  await expect(buildLayeredLibrary({ ...f.options, retrySources: f.retrySources })).rejects.toThrow('测试预算暂停')
  const saved = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
  expect(saved.source_scope?.request).toEqual(f.retrySources)
  f.call.mockClear()
  await expect(buildLayeredLibrary({ ...f.options, retrySources: { ...f.retrySources, sourceIds: ['S-0002'] } })).rejects.toThrow('范围或种类已变化')
  expect(f.call).not.toHaveBeenCalled()
  f.call.mockImplementation(respond)
  await buildLayeredLibrary(f.options)
  expect(f.calls.map(call => call.source_id)).toEqual(['S-0001'])
  expect(f.embed).not.toHaveBeenCalled()
})

it('非法空范围在派发和创建pending前拒绝', async () => {
  const f = await sourceRecoveryFixture()
  await expect(buildLayeredLibrary({ ...f.options, retrySources: { sourceIds: [], kinds: ['summary'] } })).rejects.toThrow('非空')
  expect(f.call).not.toHaveBeenCalled()
  await expect(readFile(path.join(f.root, 'work/pending.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})
