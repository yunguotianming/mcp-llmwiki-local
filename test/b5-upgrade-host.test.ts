import { readFile, readdir } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { emptyModels, emptyRegistry, newLibrary } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { safePath } from '../src/storage/paths.js'
import { WikiOperations } from '../src/host/wiki-operations.js'
import { createLocalHost } from '../src/local/host.js'
import { modelRuntime } from '../src/host/models.js'
import { verifyUpgradeBackup } from '../src/layered/upgrade.js'
import { writeProtocol } from '../src/layered/models.js'
import { legacyFixture } from './b3-fixture.js'

it.each([['dsh', '0.2.0'], ['dsh', '0.2.1'], ['local', '0.2.0'], ['local', '0.2.1']] as const)('%s 读取 %s 不升级，首次策略写入自动备份，原成果字节与未知作者保持', async (hostName, version) => {
  const f = await legacyFixture(version, version === '0.2.1'), registry = emptyRegistry(), library = newLibrary('legacy')
  library.wikiPath = f.root; library.sourceRoots = [f.parent]; library.models = emptyModels(); library.models.unified = { provider: 'compatible:test', model: 'any' }
  registry.libraries = [library]; registry.compatibleProviders = { 'compatible:test': { baseUrl: 'https://offline.invalid/v1', model: 'any', api: 'openai-responses', apiKey: 'upgrade-secret' } }
  await writeProtocol(f.root, '.llmwiki/library.json', { libraryId: library.id, formatVersion: 1, protocolVersion: 1 })
  const request = vi.fn(() => { throw new Error('升级夹具不需模型，禁止网络') })
  const local = hostName === 'local' ? createLocalHost(registry, { request }) : undefined
  const store = local?.store ?? new LibraryStore(() => registry)
  const operations = local?.operations ?? new WikiOperations(store, () => modelRuntime(undefined, registry, { request }), new Map())
  const files = await readdir(f.root, { recursive: true }), original = await readFile(await safePath(f.root, 'versions/v000001.json'))
  const read = await operations.productionStatus(library.id)
  expect(read.format).toBe('0.2.x'); expect(read.upgrade).toBeNull()
  expect(read.artifacts.filter(item => item.kind === 'extraction').every(item => item.model === '未知' && item.reason === 'legacy-library')).toBe(true)
  expect(await readdir(f.root, { recursive: true })).toEqual(files)
  const policy = await store.policy(library.id)
  const saved = await operations.savePolicy(library.id, { ...policy.policy, batchDelayMs: 0 }, policy.revision, JSON.stringify(library))
  expect(saved.policy.libraryFormat).toBe('0.3.0'); expect(saved.upgrade?.status).toBe('complete')
  expect((await verifyUpgradeBackup(saved.upgrade!.backupPath)).complete).toBe(true)
  expect(await readFile(await safePath(f.root, 'versions/v000001.json'))).toEqual(original)
  expect(await readFile(await safePath(f.root, 'logs/build.md'), 'utf8')).toContain(saved.upgrade!.backupPath)
  expect((await operations.productionStatus(library.id)).artifacts.filter(item => item.kind === 'extraction').every(item => item.reason === 'legacy-library')).toBe(true)
  expect(request).not.toHaveBeenCalled()
})

it('过期策略修订与已取消的写入不启动升级，并释放运行槽', async () => {
  const f = await legacyFixture('0.2.1', true), registry = emptyRegistry(), library = newLibrary('cancelled-upgrade')
  library.wikiPath = f.root; library.sourceRoots = [f.parent]; registry.libraries = [library]
  await writeProtocol(f.root, '.llmwiki/library.json', { libraryId: library.id, formatVersion: 1, protocolVersion: 1 })
  const store = new LibraryStore(() => registry), running = new Map<string, AbortController>(), runtime = vi.fn(() => { throw new Error('不应初始化模型') })
  const operations = new WikiOperations(store, runtime, running), view = await store.policy(library.id), files = await readdir(f.root, { recursive: true })
  await expect(operations.savePolicy(library.id, view.policy, 'stale', JSON.stringify(library))).rejects.toMatchObject({ httpStatus: 409 })
  const abort = new AbortController(); abort.abort(new Error('写入已取消'))
  await expect(operations.upgradeForRunningTask(library.id, abort.signal)).rejects.toThrow('库运行槽')
  await expect(operations.beforeWrite(library.id, abort.signal)).rejects.toThrow('写入已取消')
  expect(running.size).toBe(0); expect(runtime).not.toHaveBeenCalled()
  expect(await readdir(f.root, { recursive: true })).toEqual(files)
})
