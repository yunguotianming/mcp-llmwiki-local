import { readFile, readdir, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { emptyRegistry } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { ChangeStore } from '../src/storage/changes.js'
import { safePath } from '../src/storage/paths.js'
import { hash, writeJson } from '../src/layered/files.js'
import { readCurrent, readVersion, versionPage } from '../src/layered/objects.js'
import { publishLibrary } from '../src/layered/publication.js'
import { collectGarbage } from '../src/layered/retention.js'
import { storageJson } from '../src/layered/vectors.js'
import type { PendingBuild } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, hydratedState } from './layered-fixture.js'
import { built } from './tags-anchors-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); return cleanupLayeredFixtures() })

async function inventory(root: string) {
  const files = (await readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
  return Object.fromEntries(await Promise.all(files.map(async entry => {
    const file = path.join(entry.parentPath, entry.name)
    return [path.relative(root, file), hash(await readFile(file))]
  })))
}
async function brokenPreview(historicalAcceptance = false) {
  const f = await built('topics')
  f.library.wikiPath = f.root; f.library.sourceRoots = [f.knowledgeRoot]
  const registry = emptyRegistry(); registry.libraries = [f.library]
  const store = new LibraryStore(() => registry), policy = await store.initialize(f.library.id), changes = new ChangeStore(store)
  const state = structuredClone(f.manifest.topics!)
  delete state.embedding.identity; state.vectors = {}
  const pages = Object.fromEntries(await Promise.all(state.topics.map(async topic => [topic.path,
    { content: await versionPage(f.root, f.manifest, topic.path), dependencies: structuredClone(f.manifest.deps!.pages[topic.path]!) }])))
  const pending: PendingBuild = { format_version: f.manifest.format_version, base_version: f.manifest.version, version: null,
    manifest: structuredClone(f.manifest), card: structuredClone(f.manifest.card!), added: [], model_calls: 0,
    runId: randomUUID(), started_at: new Date().toISOString(),
    topic_scope: { targets: [state.topics[0]!.id], completed: [state.topics[0]!.id], review_inputs: {} },
    topics: { fingerprint: hash('旧版未执行嵌入'), state, pages, rewritten: [], model_calls: 0, aliases: {} } }
  if (historicalAcceptance) pending.manifest.sources[0]!.acceptedRef = {
    taskId: 't:' + '3'.repeat(64), digest: 'sha256:' + '4'.repeat(64), path: `work/accepted/tasks/${'3'.repeat(64)}.json` }
  const version = await publishLibrary(f.root, pending, undefined, false)
  const batch = await changes.prepareLayered(f.library.id, version, JSON.stringify(f.library), policy.revision)
  const request = vi.fn(async () => { throw new Error('预览恢复不得访问网络') })
  vi.stubGlobal('fetch', request); f.call.mockClear()
  return { ...f, store, changes, pending, batch, version, request }
}

it('读取旧预览同run封新version与digest，旧摘要拒绝，新摘要确认后才能激活', async () => {
  const f = await brokenPreview(), oldBytes = await readFile(await safePath(f.root, `versions/${f.version}.json`))
  await expect(f.changes.commit(f.library.id, f.batch.id, f.batch.digest)).rejects.toThrow('重新读取预览')
  const preview = await f.changes.preview(f.library.id, f.batch.id), version = preview.batch.layered!.version
  expect(preview.batch.id).toBe(f.batch.id); expect(version).not.toBe(f.version); expect(preview.batch.digest).not.toBe(f.batch.digest)
  expect((await readCurrent(f.root))!.version).toBe(f.manifest.version)
  const next = await readVersion(f.root, version), pending = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
  expect(next.topics!.embedding).toEqual(f.manifest.topics!.embedding)
  expect(storageJson(next.topics!.vectors)).toBe(storageJson(f.manifest.topics!.vectors))
  expect(pending.runId).toBe(f.pending.runId); expect(pending.base_version).toBe(f.pending.base_version)
  expect(await readFile(await safePath(f.root, `versions/${f.version}.json`))).toEqual(oldBytes)
  const record = JSON.parse(await readFile(await safePath(f.root, `work/preview-recovery/${f.batch.id}/${f.batch.digest}.json`), 'utf8'))
  expect(record.batch).toEqual(f.batch); expect(record.pending.runId).toBe(f.pending.runId)
  expect((await f.changes.preview(f.library.id, f.batch.id)).batch).toEqual(preview.batch)
  await expect(f.changes.commit(f.library.id, f.batch.id, f.batch.digest)).rejects.toThrow('重新读取预览')
  await f.changes.commit(f.library.id, f.batch.id, preview.batch.digest)
  expect((await readCurrent(f.root))!.version).toBe(version)
  await collectGarbage(f.root, 0)
  expect(await readFile(await safePath(f.root, `versions/${f.version}.json`))).toEqual(oldBytes)
  expect(f.call).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled()
})

it('原始向量身份不一致时拒绝自动修复并保留全部旧字节', async () => {
  const f = await brokenPreview()
  f.pending.manifest.vector_state!.identity!.revision = '不属于原基线'
  await writeJson(f.root, 'work/pending.json', f.pending)
  const before = await inventory(f.root)
  await expect(f.changes.preview(f.library.id, f.batch.id)).rejects.toThrow(/作业|身份|嵌入/)
  expect(await inventory(f.root)).toEqual(before)
  expect(f.call).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled()
})

it('原文在预览后变化时拒绝重封且不修改原批次或检查点', async () => {
  const f = await brokenPreview()
  await writeFile(path.join(f.knowledgeRoot, f.manifest.sources[0]!.current_path), '已变化的原文')
  const before = await inventory(f.root)
  await expect(f.changes.preview(f.library.id, f.batch.id)).rejects.toThrow(/依据|变化/)
  expect(await inventory(f.root)).toEqual(before)
  expect(f.call).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled()
})

it('原检查点引用的接受记录缺失时拒绝重封，不用旧引用冒充接受', async () => {
  const f = await brokenPreview(), id = 't:' + '1'.repeat(64)
  f.pending.acceptedRefs = { audit: { taskId: id, digest: 'sha256:' + '2'.repeat(64), path: `work/accepted/tasks/${id.slice(2)}.json` } }
  await writeJson(f.root, 'work/pending.json', f.pending)
  const before = await inventory(f.root)
  await expect(f.changes.preview(f.library.id, f.batch.id)).rejects.toThrow(/接受/)
  expect(await inventory(f.root)).toEqual(before)
  expect(f.call).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled()
})

it('新预览已封而批次尚未保存时中断，下次沿原归档检查点零模型完成', async () => {
  const f = await brokenPreview(), batchPath = await safePath(f.root, `.llmwiki/changes/${f.batch.id}.json`)
  const filesystem = await import('node:fs/promises'), originalRename = filesystem.rename
  let stopped = false
  const failure = vi.spyOn(filesystem, 'rename').mockImplementation(async (from, to) => {
    if (!stopped && String(to) === batchPath) { stopped = true; throw new Error('批次落盘前中断') }
    return originalRename(from, to)
  })
  await expect(f.changes.preview(f.library.id, f.batch.id)).rejects.toThrow('批次落盘前中断')
  failure.mockRestore()
  expect(stopped).toBe(true)
  const result = await new ChangeStore(f.store).preview(f.library.id, f.batch.id)
  expect(result.batch.layered!.version).not.toBe(f.version)
  expect(result.batch.digest).not.toBe(f.batch.digest)
  expect((await readCurrent(f.root))!.version).toBe(f.manifest.version)
  expect((await hydratedState<PendingBuild>(f.root, 'work/pending.json')).runId).toBe(f.pending.runId)
  expect(f.call).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled()
})

it('已发布继承成果的历史work接受已清理时仍可恢复，不要求重做旧阶段', async () => {
  const f = await brokenPreview(true)
  const result = await f.changes.preview(f.library.id, f.batch.id)
  expect(result.batch.layered!.version).not.toBe(f.version)
  expect((await readVersion(f.root, result.batch.layered!.version)).topics!.embedding).toEqual(f.manifest.topics!.embedding)
  expect((await readCurrent(f.root))!.version).toBe(f.manifest.version)
  expect(f.call).not.toHaveBeenCalled(); expect(f.request).not.toHaveBeenCalled()
})
