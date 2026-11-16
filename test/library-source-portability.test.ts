import { cp, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { emptyRegistry } from '../src/domain/config.js'
import type { LibraryRegistration } from '../src/domain/config.js'
import { generateLocalLayered, scanLocalLayered } from '../src/host/local-layered.js'
import { hash } from '../src/layered/files.js'
import { safePath } from '../src/storage/paths.js'
import { ChangeStore } from '../src/storage/changes.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { cleanupLayeredFixtures, layeredFixture, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
const network = vi.fn(async () => { throw new Error('资料搬迁回归禁止联网或访问 Ollama。') })
beforeEach(() => { network.mockClear(); vi.stubGlobal('fetch', network) })
afterEach(() => { const calls = network.mock.calls.length; cleanupLayeredFixtures(); vi.unstubAllGlobals(); expect(calls).toBe(0) })
const signal = () => new AbortController().signal

function register(library: LibraryRegistration, wikiPath: string, sourceRoots: string[] = []) {
  const registry = emptyRegistry()
  registry.libraries = [{ ...structuredClone(library), wikiPath, sourceRoots }]
  registry.activeLibraryId = library.id
  return new LibraryStore(() => registry)
}

async function fixture(directory = '.llmwiki', external = false) {
  const f = await layeredFixture()
  const parent = path.join(f.knowledgeRoot, '原资料根'), root = path.join(parent, directory)
  const sourceRoot = external ? path.join(f.knowledgeRoot, '外部资料根') : parent
  f.library.layered = { embeddingMode: 'none', pointLabelsOnBuild: false }
  const store = register(f.library, root, external ? [sourceRoot] : [])
  if (external) await mkdir(sourceRoot)
  // Wiki 与默认资料根均未建出，覆盖初始化先建目录再校验来源边界的顺序。
  await expect(stat(root)).rejects.toMatchObject({ code: 'ENOENT' })
  const initialized = await store.initialize(f.library.id)
  expect(initialized.initialized).toBe(true)
  await store.savePolicy(f.library.id, f.policy, initialized.revision)
  const calls = vi.spyOn(f.runtime, 'stream')
  return { ...f, root, sourceRoot, store, calls }
}

async function publish(f: Awaited<ReturnType<typeof fixture>>, store = f.store, root = f.root) {
  const generated = await generateLocalLayered(store, f.library.id, f.runtime, signal())
  expect(generated.status).toBe('preview')
  if (!generated.batchId) throw new Error('本批构建应返回真实预览批次。')
  const changes = new ChangeStore(store), { batch } = await changes.preview(f.library.id, generated.batchId)
  await changes.commit(f.library.id, batch.id, batch.digest)
  return snapshotManifest(root)
}

it('空 sourceRoots 的 .llmwiki 默认使用父目录，初始化后可真实扫描并构建', async () => {
  const f = await fixture()
  expect(f.store.registration(f.library.id).sourceRoots).toEqual([f.sourceRoot])
  expect((await stat(f.root)).isDirectory()).toBe(true)
  await writeFile(path.join(f.sourceRoot, '甲.md'), '# 甲资料\n\n甲资料报告了明确的观察结果。', 'utf8')
  const scanned = await scanLocalLayered(f.store, f.library.id, signal())
  expect(scanned.errors).toEqual([])
  expect(scanned.files.map(file => path.basename(file.path))).toEqual(['甲.md'])
  const manifest = await publish(f)
  expect(manifest.sources.map(source => source.current_path)).toEqual(['甲.md'])
  expect(f.requests).toHaveLength(1)
})

it('空 sourceRoots 的 .llmwiki-模型同样从父目录初始化并构建', async () => {
  const f = await fixture('.llmwiki-fixture-model')
  expect(f.store.registration(f.library.id).sourceRoots).toEqual([f.sourceRoot])
  await writeFile(path.join(f.sourceRoot, '乙.md'), '# 乙资料\n\n乙资料记载了独立的研究发现。', 'utf8')
  const scanned = await scanLocalLayered(f.store, f.library.id, signal())
  expect(scanned.errors).toEqual([])
  expect(scanned.files.map(file => path.basename(file.path))).toEqual(['乙.md'])
  const manifest = await publish(f)
  expect(manifest.sources.map(source => source.current_path)).toEqual(['乙.md'])
  expect(f.requests).toHaveLength(1)
})

it('显式外部 sourceRoot 优先于 Wiki 父目录，扫描和构建只读取外部资料', async () => {
  const f = await fixture('.llmwiki', true)
  await writeFile(path.join(path.dirname(f.root), '不应扫描.md'), 'Wiki 父目录的无关资料。', 'utf8')
  await writeFile(path.join(f.sourceRoot, '外部.md'), '# 外部资料\n\n外部资料说明了真实的观察条件。', 'utf8')
  expect(f.store.registration(f.library.id).sourceRoots).toEqual([f.sourceRoot])
  const scanned = await scanLocalLayered(f.store, f.library.id, signal())
  expect(scanned.errors).toEqual([])
  expect(scanned.files.map(file => path.basename(file.path))).toEqual(['外部.md'])
  const manifest = await publish(f)
  expect(manifest.sources.map(source => source.current_path)).toEqual(['外部.md'])
  expect(f.requests).toHaveLength(1)
})

it('复制整个资料根与 .llmwiki 后重新登记，未变增量零模型且旧身份和提取摘要保持', async () => {
  const f = await fixture()
  await writeFile(path.join(f.sourceRoot, '甲.md'), '# 甲资料\n\n甲资料报告了明确的观察结果。', 'utf8')
  const before = await publish(f), old = before.sources[0]!
  const bytes = await readFile(await safePath(f.root, old.extract.path))
  const copiedSource = path.join(f.knowledgeRoot, '迁移后资料根')
  await cp(f.sourceRoot, copiedSource, { recursive: true })
  const copiedRoot = path.join(copiedSource, '.llmwiki'), store = register(f.library, copiedRoot)
  expect(store.registration(f.library.id).sourceRoots).toEqual([copiedSource])
  expect((await store.policy(f.library.id)).initialized).toBe(true)
  f.calls.mockClear(); f.requests.length = 0
  const scanned = await scanLocalLayered(store, f.library.id, signal())
  expect(scanned.files).toHaveLength(1)
  expect(scanned.files[0]).toMatchObject({ sourceId: old.source_id, generation: 'current' })
  const generated = await generateLocalLayered(store, f.library.id, f.runtime, signal())
  expect(generated).toMatchObject({ status: 'unchanged', version: before.version, modelCalls: 0 })
  expect(f.calls).not.toHaveBeenCalled()
  expect(f.requests).toEqual([])
  const after = await snapshotManifest(copiedRoot)
  expect(after.sources.map(source => source.source_id)).toEqual([old.source_id])
  expect(after.sources[0]!.extract.path).toBe(old.extract.path)
  expect(hash(await readFile(await safePath(copiedRoot, old.extract.path)))).toBe(hash(bytes))
})

it('复制后新增一篇资料仅提取新来源，保留旧来源 ID 与提取原字节', async () => {
  const f = await fixture()
  await writeFile(path.join(f.sourceRoot, '甲.md'), '# 甲资料\n\n甲资料报告了明确的观察结果。', 'utf8')
  const before = await publish(f), old = before.sources[0]!
  const bytes = await readFile(await safePath(f.root, old.extract.path))
  const copiedSource = path.join(f.knowledgeRoot, '迁移后资料根')
  await cp(f.sourceRoot, copiedSource, { recursive: true })
  const copiedRoot = path.join(copiedSource, '.llmwiki'), store = register(f.library, copiedRoot)
  await writeFile(path.join(copiedSource, '新增.md'), '# 新增资料\n\n新增资料提供了另一项独立发现。', 'utf8')
  f.calls.mockClear(); f.requests.length = 0
  const scanned = await scanLocalLayered(store, f.library.id, signal())
  expect(scanned.files.find(file => path.basename(file.path) === '甲.md')).toMatchObject({ sourceId: old.source_id, generation: 'current' })
  expect(scanned.files.find(file => path.basename(file.path) === '新增.md')).toMatchObject({ change: 'new' })
  const after = await publish(f, store, copiedRoot)
  expect(after.sources).toHaveLength(2)
  const existing = after.sources.find(source => source.current_path === '甲.md')!
  const added = after.sources.find(source => source.current_path === '新增.md')!
  expect(existing.source_id).toBe(old.source_id)
  expect(existing.extract.path).toBe(old.extract.path)
  expect(await readFile(await safePath(copiedRoot, existing.extract.path))).toEqual(bytes)
  expect(added.source_id).not.toBe(old.source_id)
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0]!.input.source_id).toBe(added.source_id)
})
