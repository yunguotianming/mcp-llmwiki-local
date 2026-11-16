import { unlink } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import * as publication from '../src/layered/publication.js'
import { writeJson } from '../src/layered/files.js'
import { readVersion } from '../src/layered/objects.js'
import { storageJson, vectorPath } from '../src/layered/vectors.js'
import { prepareTopics } from '../src/layered/topics.js'
import { safePath } from '../src/storage/paths.js'
import type { PendingBuild } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, hydratedState } from './layered-fixture.js'
import { built, saveManifest } from './tags-anchors-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); return cleanupLayeredFixtures() })

async function interrupted() {
  const f = await built('topics'), target = f.manifest.topics!.topics[0]!
  f.manifest.topic_gaps = [{ topic_id: target.id, point_ids: target.point_ids, message: 'Connection error.' }]
  delete f.manifest.pages![target.path]
  await saveManifest(f.root, f.manifest)
  const embed = vi.fn(async () => { throw new Error('定向恢复不能执行嵌入') })
  const identity = vi.fn(async () => { throw new Error('定向恢复不能探测模型') })
  const request = vi.fn(async () => { throw new Error('定向恢复不能访问网络') })
  vi.stubGlobal('fetch', request)
  const options = { ...f.options, embeddingClient: { embed, identity }, retryTopics: { topicIds: [target.id] }, publish: false, automaticRecovery: true }
  const publish = vi.spyOn(publication, 'publishLibrary').mockRejectedValueOnce(new Error('测试发布中断'))
  await expect(buildLayeredLibrary(options)).rejects.toThrow('测试发布中断')
  publish.mockRestore()
  const pending = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
  f.call.mockClear()
  return { ...f, pending, options, embed, identity, request }
}

it('定向恢复首轮及已完成收尾保留原嵌入身份和完整向量映射', async () => {
  const f = await interrupted(), original = f.manifest.topics!
  expect(f.pending.topics!.state.embedding).toEqual(original.embedding)
  expect(storageJson(f.pending.topics!.state.vectors)).toBe(storageJson(original.vectors))
  const result = await buildLayeredLibrary(f.options), preview = await readVersion(f.root, result.version)
  expect(preview.topics!.embedding).toEqual(original.embedding)
  expect(storageJson(preview.topics!.vectors)).toBe(storageJson(original.vectors))
  expect(f.embed).not.toHaveBeenCalled(); expect(f.identity).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled()
  expect(f.call).not.toHaveBeenCalled()
})

it('旧完成检查点丢失身份且映射被清空时从同基线对象零模型恢复并保原run', async () => {
  const f = await interrupted(), original = f.manifest.topics!, before = structuredClone(f.pending)
  delete f.pending.topics!.state.embedding.identity
  f.pending.topics!.state.vectors = {}
  f.pending.manifest.topics = structuredClone(f.pending.topics!.state)
  await writeJson(f.root, 'work/pending.json', f.pending)
  const result = await buildLayeredLibrary(f.options), preview = await readVersion(f.root, result.version)
  const pending = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
  expect(result.modelCalls).toBe(0)
  expect(preview.topics!.embedding).toEqual(original.embedding)
  expect(storageJson(preview.topics!.vectors)).toBe(storageJson(original.vectors))
  expect(pending.runId).toBe(before.runId); expect(pending.base_version).toBe(before.base_version)
  expect(pending.topic_scope).toEqual(before.topic_scope)
  expect(f.embed).not.toHaveBeenCalled(); expect(f.identity).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled()
  expect(f.call).not.toHaveBeenCalled()
})

it('已有非空不同模型身份必须拒绝，不能降级后发布', async () => {
  const f = await interrupted()
  f.pending.topics!.state.embedding.identity!.revision = '另一份权重'
  await writeJson(f.root, 'work/pending.json', f.pending)
  const publish = vi.spyOn(publication, 'publishLibrary')
  await expect(buildLayeredLibrary(f.options)).rejects.toMatchObject({ code: 'TOPIC_SCOPE_EMBEDDING_CHANGED' })
  expect(publish).not.toHaveBeenCalled(); expect(f.call).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled()
})

it('旧检查点来源提取身份不同不能借用基线嵌入身份或向量', async () => {
  const f = await interrupted()
  delete f.pending.topics!.state.embedding.identity
  f.pending.topics!.state.vectors = {}
  f.pending.manifest.sources[0]!.extract.processing_fingerprint = 'sha256:' + '1'.repeat(64)
  await writeJson(f.root, 'work/pending.json', f.pending)
  const publish = vi.spyOn(publication, 'publishLibrary')
  await expect(buildLayeredLibrary(f.options)).rejects.toMatchObject({ code: 'TOPIC_SCOPE_EMBEDDING_CHANGED' })
  expect(publish).not.toHaveBeenCalled(); expect(f.call).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled()
})

it('旧检查点端点不符时不能只补身份冒充原成果', async () => {
  const f = await interrupted()
  delete f.pending.topics!.state.embedding.identity
  f.pending.topics!.state.embedding.url = 'http://127.0.0.1:9999'
  f.pending.topics!.state.vectors = {}
  await writeJson(f.root, 'work/pending.json', f.pending)
  const publish = vi.spyOn(publication, 'publishLibrary')
  await expect(buildLayeredLibrary(f.options)).rejects.toMatchObject({ code: 'TOPIC_SCOPE_EMBEDDING_CHANGED' })
  expect(publish).not.toHaveBeenCalled(); expect(f.call).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled()
})

it('原向量对象缺失时拒绝恢复映射且不重算向量', async () => {
  const f = await interrupted(), reference = Object.values(f.manifest.topics!.vectors)[0]!
  delete f.pending.topics!.state.embedding.identity
  f.pending.topics!.state.vectors = {}
  await writeJson(f.root, 'work/pending.json', f.pending)
  await unlink(await safePath(f.root, vectorPath(reference.vector_id!)))
  const publish = vi.spyOn(publication, 'publishLibrary')
  await expect(buildLayeredLibrary(f.options)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(publish).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled()
})

it('已有完整身份的合法检查点保留自身映射，不盲目覆盖为基线', async () => {
  const f = await interrupted()
  f.pending.topics!.state.vectors = {}
  const result = await prepareTopics(f.root, f.pending, f.manifest, f.options, undefined)
  expect(result).toEqual({ changed: false, modelCalls: 0 })
  expect(f.pending.topics!.state.vectors).toEqual({})
  expect(f.call).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled()
})
