import { readFile, readdir } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { legacyFixture } from './b3-fixture.js'
import { newLibrary, emptyRegistry } from '../src/domain/config.js'
import type { Registry } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { createLibraryServices } from '../src/host/library-management.js'
import { createLibraryDiscovery } from '../src/wiki/library-reader.js'
import { safePath } from '../src/storage/paths.js'
import { hash, writeJson } from '../src/layered/files.js'
import { readProvenance, writeProvenance } from '../src/layered/models.js'
import { readVersionCosts, writeVersionCosts } from '../src/layered/costs.js'
import { readUpgradeStatus, verifyUpgradeBackup } from '../src/layered/upgrade.js'
import { storageJson } from '../src/layered/vectors.js'
import { writeVersion } from '../src/layered/objects.js'
import { discoveryFixture } from './b6b-fixture.js'

async function fixture(version: '0.2.0' | '0.2.1' = '0.2.0') {
  const f = await legacyFixture(version, version === '0.2.1')
  await writeJson(f.root, '.llmwiki/library.json', { libraryId: 'legacy', formatVersion: 1, protocolVersion: 1 })
  const library = { ...newLibrary('legacy'), name: '护士库', description: '', wikiPath: f.root, sourceRoots: [f.parent] }
  library.models.unified = { provider: 'offline', model: 'summary' }; library.models.layeredRoutes = {}
  library.models.providerProfiles = { offline: { concurrency: 1, retryLimit: 0, backoffMs: 0, cacheMode: 'none' } }
  let registry: Registry = { ...emptyRegistry(), activeLibraryId: 'legacy', libraries: [library] }
  const store = new LibraryStore(() => registry)
  const control = { calls: 0, fail: false, response: { short: '护理研究', long: '护理资料与临床实践。' } as { short?: string; long?: string }, onCall: undefined as undefined | (() => Promise<void>) }
  const runtime = {
    resolveModelInfo: async (provider: string, id: string) => ({ provider, id, name: id, context: { contextWindow: 32000 }, defaultMaxTokens: 1500 }),
    async *stream() {
      control.calls++
      await control.onCall?.()
      if (control.fail) throw new Error('确定性简介失败')
      yield { type: 'text-delta' as const, index: 0, text: JSON.stringify(control.response) }
      yield { type: 'usage' as const, usage: { inputTokens: 100, outputTokens: 30 } }
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
    },
  }
  const services = createLibraryServices(store, async (next, expected) => {
    if (JSON.stringify(expected) !== JSON.stringify(registry)) throw Object.assign(new Error('冲突'), { httpStatus: 409 })
    registry = structuredClone(next)
  }, () => runtime, new Map())
  return { ...f, store, services, control }
}

it.each(['0.2.0', '0.2.1'] as const)('%s 只读不升级，补两档简介先备份升级且旧成果原字节不变', async version => {
  const f = await fixture(version), discovery = createLibraryDiscovery(f.store), files = await readdir(f.root, { recursive: true })
  expect((await discovery.show('legacy')).summaryStatus).toBe('missing')
  await discovery.find('护士'); expect(await readdir(f.root, { recursive: true })).toEqual(files)
  expect(await readUpgradeStatus(f.root)).toBeUndefined(); expect(f.control.calls).toBe(0)
  await f.services.summaries.refresh('legacy', f.services.management.view().registryRevision)
  expect(f.store.registration('legacy').summary).toMatchObject({ short: { text: '护理研究', sourceVersion: 'v000001' }, long: { text: '护理资料与临床实践。' } })
  expect(f.control.calls).toBe(1)
  const upgrade = (await readUpgradeStatus(f.root))!
  expect(upgrade.status).toBe('complete'); expect((await verifyUpgradeBackup(upgrade.backupPath)).complete).toBe(true)
  expect(await readFile(await safePath(f.root, 'versions/v000001.json'))).toEqual(f.original)
  const provenance = await readProvenance(f.root, 'v000001', hash(storageJson(f.manifest)))
  expect(Object.values(provenance.records).some(record => record.operation === 'librarySummary' && record.requestedModel === 'summary')).toBe(true)
  await f.services.summaries.refresh('legacy', f.services.management.view().registryRevision)
  expect(f.control.calls).toBe(1)
}, 30000)

it('失败保留原文与 pending，同版本重试幂等，新发布只刷新未锁档位', async () => {
  const f = await fixture(), manual = '  手写\n长简介逐字保持。 '
  await f.services.management.update('legacy', { summary: { long: { text: manual } } }, f.services.management.view().registryRevision)
  await f.services.management.saveSummary('legacy', { summary: { ...f.store.registration('legacy').summary, short: { text: '旧短简介', origin: 'generated', locked: false, sourceVersion: 'v000000' } } }, f.services.management.view().registryRevision)
  f.control.fail = true; f.control.response = { short: '护理新版简介' }
  await expect(f.services.summaries.refresh('legacy', f.services.management.view().registryRevision)).rejects.toThrow()
  expect(f.store.registration('legacy')).toMatchObject({ summaryStatus: 'pending', summary: { short: { text: '旧短简介' }, long: { text: manual, locked: true } } })
  f.control.fail = false
  await f.services.summaries.refresh('legacy', f.services.management.view().registryRevision)
  const calls = f.control.calls
  await f.services.summaries.refresh('legacy', f.services.management.view().registryRevision)
  expect(f.control.calls).toBe(calls)
  const next = { ...f.manifest, version: 'v000002' }, checksum = hash(storageJson(next)), oldChecksum = hash(storageJson(f.manifest))
  await writeVersion(f.root, next)
  await writeProvenance(f.root, { ...await readProvenance(f.root, 'v000001', oldChecksum), version: 'v000002', manifestChecksum: checksum })
  await writeVersionCosts(f.root, 'v000002', checksum, [], await readVersionCosts(f.root, 'v000001', oldChecksum))
  await writeJson(f.root, 'state/current.json', { version: 'v000002', revocation_generation: 0, history: ['v000001'] })
  await writeJson(f.root, 'state/summary-refresh.json', { version: 'v000002' })
  f.control.response = { short: '第二版简介' }
  await f.services.summaries.afterPublication('legacy', 'v000002')
  expect(f.store.registration('legacy').summary).toMatchObject({ short: { text: '第二版简介', sourceVersion: 'v000002' }, long: { text: manual, locked: true, origin: 'manual' } })
  expect(f.control.calls).toBe(calls + 1)
  await expect(readFile(await safePath(f.root, 'state/summary-refresh.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await f.services.management.update('legacy', { name: '护士库新版', summary: { short: { unlock: true } } }, f.services.management.view().registryRevision)
  f.control.fail = true
  await expect(f.services.summaries.refresh('legacy', f.services.management.view().registryRevision)).rejects.toThrow()
  expect((await readVersionCosts(f.root, 'v000002', checksum)).total.calls).toBe(f.control.calls)
  expect(f.store.registration('legacy').summary?.short?.text).toBe('第二版简介')
  f.control.fail = false
  await f.services.summaries.refresh('legacy', f.services.management.view().registryRevision)
  expect((await readVersionCosts(f.root, 'v000002', checksum)).total.calls).toBe(f.control.calls)
}, 30000)

it('接受后登记冲突保留草稿，重建服务后同版本从持久结果恢复且零重调', async () => {
  const f = await fixture()
  f.control.onCall = async () => { await f.services.management.update('legacy', { pinned: true }, f.services.management.view().registryRevision) }
  await expect(f.services.summaries.refresh('legacy', f.services.management.view().registryRevision)).rejects.toMatchObject({ code: 'REGISTRY_CONFLICT' })
  expect(f.control.calls).toBe(1); expect(f.store.registration('legacy').pinned).toBe(true)
  f.control.onCall = undefined
  const { LibrarySummaries } = await import('../src/wiki/library-summaries.js')
  const restarted = new LibrarySummaries(f.services.management, f.services.discovery, async () => ({ run: async () => { throw new Error('不应重新调用模型') } }))
  await restarted.refresh('legacy', f.services.management.view().registryRevision)
  expect(f.control.calls).toBe(1); expect(f.store.registration('legacy').summary?.short?.text).toBe('护理研究')
}, 30000)

it('撤权后隐藏简介，显式复核恢复人工档位；解除锁定必须显式操作', async () => {
  const f = discoveryFixture()
  await f.management.update('library-9', { summary: { short: { text: '护理' } } }, f.management.view().registryRevision)
  f.metadata.get('library-9')!.generation = 1
  expect((await f.discovery.find('护理')).cards).toEqual([])
  await expect(f.services.summaries.refresh('library-9', f.management.view().registryRevision)).rejects.toMatchObject({ code: 'SUMMARY_REVIEW_REQUIRED' })
  await f.services.summaries.confirmReview('library-9', f.management.view().registryRevision)
  expect((await f.discovery.find('护理')).cards[0]?.libraryId).toBe('library-9')
  expect(f.store.registration('library-9').summary?.short?.locked).toBe(true)
})
