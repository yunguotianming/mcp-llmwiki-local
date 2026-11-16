import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import * as publication from '../src/layered/publication.js'
import { hash, writeJson } from '../src/layered/files.js'
import { readVersion, versionPage } from '../src/layered/objects.js'
import type { PendingBuild } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, hydratedState } from './layered-fixture.js'
import { built, saveManifest } from './tags-anchors-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => { vi.restoreAllMocks(); return cleanupLayeredFixtures() })

async function inventory(root: string) {
  const files = (await readdir(root, { recursive: true, withFileTypes: true })).filter(item => item.isFile())
  return Object.fromEntries(await Promise.all(files.map(async item => {
    const file = path.join(item.parentPath, item.name)
    return [path.relative(root, file), hash(await readFile(file))]
  })))
}
async function failedPublication() {
  const f = await built('topics'), target = f.manifest.topics!.topics[0]!
  f.manifest.topic_gaps = [{ topic_id: target.id, point_ids: target.point_ids, message: 'Connection error.' }]
  delete f.manifest.pages![target.path]
  await saveManifest(f.root, f.manifest)
  const retryTopics = { topicIds: [target.id] }, options = { ...f.options, retryTopics, publish: false, automaticRecovery: true }
  const publish = vi.spyOn(publication, 'publishLibrary').mockRejectedValueOnce(new Error('测试发布中断'))
  await expect(buildLayeredLibrary(options)).rejects.toThrow('测试发布中断')
  publish.mockRestore()
  const pending = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
  expect(pending.topic_scope!.completed).toContain(target.id)
  expect(pending.topics!.gaps).toEqual([])
  f.call.mockClear()
  return { ...f, target, pending, options }
}

it('同范围主题已完成而发布中断后，完整SDK零模型恢复到预览并保原run', async () => {
  const f = await failedPublication(), before = structuredClone(f.pending)
  const result = await buildLayeredLibrary(f.options)
  expect(result).toMatchObject({ unchanged: false, modelCalls: 0 })
  const preview = await hydratedState<{ version: string }>(f.root, 'work/preview.json'), pending = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
  expect(preview.version).toBe(result.version)
  expect(pending.runId).toBe(before.runId)
  expect(pending.base_version).toBe(before.base_version)
  expect(pending.topic_scope).toEqual(before.topic_scope)
  expect(await versionPage(f.root, await readVersion(f.root, result.version), f.target.path)).toContain(f.target.id)
  expect(f.call).not.toHaveBeenCalled()
})

it('没有原主题待办的空目标保持零写入零模型', async () => {
  const f = await built('topics'), before = await inventory(f.root)
  f.call.mockClear()
  expect(await buildLayeredLibrary({ ...f.options, retryTopics: { topicIds: [] }, publish: false })).toMatchObject({ unchanged: true, modelCalls: 0 })
  expect(await inventory(f.root)).toEqual(before)
  expect(f.call).not.toHaveBeenCalled()
})

it('不同目标不能接管已完成待办，保留全部原检查点字节', async () => {
  const f = await failedPublication(), before = await inventory(f.root)
  expect(await buildLayeredLibrary({ ...f.options, retryTopics: { topicIds: ['T-9999'] } })).toMatchObject({ unchanged: true, modelCalls: 0 })
  expect(await inventory(f.root)).toEqual(before)
  expect(f.call).not.toHaveBeenCalled()
})

it('基线不同的已完成主题待办不能进入收尾或写入', async () => {
  const f = await failedPublication()
  f.pending.base_version = 'v999999'
  await writeJson(f.root, 'work/pending.json', f.pending)
  const before = await inventory(f.root)
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ unchanged: true, modelCalls: 0 })
  expect(await inventory(f.root)).toEqual(before)
  expect(f.call).not.toHaveBeenCalled()
})

it('来源恢复待办不能混入主题零目标收尾', async () => {
  const f = await failedPublication()
  f.pending.source_scope = { request: { sourceIds: [f.entry.source_id], kinds: ['summary'] }, completed: [], source_input: '', affected_topics: [], changed_points: [] }
  await writeJson(f.root, 'work/pending.json', f.pending)
  const before = await inventory(f.root)
  await expect(buildLayeredLibrary(f.options)).rejects.toThrow(/来源|补缺|范围/)
  expect(await inventory(f.root)).toEqual(before)
  expect(f.call).not.toHaveBeenCalled()
})
