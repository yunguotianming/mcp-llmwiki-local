import { readFile, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { defaultPolicy } from '../src/domain/policy.js'
import { createBuildModelClient } from '../src/host/models.js'
import { createExecutionLedger, readRunCosts } from '../src/layered/costs.js'
import { hash, writeJson } from '../src/layered/files.js'
import { readProvenance, writeProtocol } from '../src/layered/models.js'
import { pageObjectPath, putPage } from '../src/layered/objects.js'
import { pinVersion, readerLeaseMs, readRetentionRoots } from '../src/layered/retention.js'
import { readUpgradeStatus, upgradeLibrary, verifyUpgradeBackup } from '../src/layered/upgrade.js'
import { storageJson } from '../src/layered/vectors.js'
import type { AcceptedRecord, Extraction, SnapshotManifest } from '../src/layered/schema.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { legacyFixture } from './b3-fixture.js'

beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('升级可达性测试禁止网络') })))
afterEach(() => vi.unstubAllGlobals())

async function snapshot(root: string, names?: string[]) {
  const files = names ?? (await readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
    .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/'))
  // 沿用库存协议的事务锁不属于资料成果；租约与退役记录仍逐字节比较。
  return Object.fromEntries(await Promise.all(files.filter(file => !/inventory-lock\.sqlite(?:-wal|-shm)?$/.test(file)).sort().map(async file => [file, hash(await readFile(path.join(root, file)))])))
}

async function fixture() {
  const f = await legacyFixture('0.2.1')
  for (const source of f.manifest.sources) {
    const text = await readFile(path.join(f.root, source.files.source), 'utf8')
    const segment = { locator: 'L1-L1', start: 0, end: text.length, text_hash: hash(text) }
    source.segments = [segment]
    const extraction: Extraction = { format_version: 1, source_id: source.source_id, source_hash: hash(text), processing: source.extract.processing,
      metadata: source.metadata, calls: [], segments: [{ ...segment, resource_hashes: [], processing_fingerprint: hash(text), terms: [], points: [{
        point_id: source.source_id + ':P1', text, section: '主要发现', text_hash: hash(text), locator: 'L1-L1', source_version: source.source_version,
        evidence: [{ source_id: source.source_id, source_version: source.source_version, locator: 'L1-L1', quote: text }],
        verification: { status: 'verified', missing: '', fingerprint: '人工旧结果' },
      }] }] }
    await writeJson(f.root, source.extract.path, extraction)
  }
  const version = async (number: number, topics: number[], reviewed = false) => {
    const manifest = structuredClone(f.manifest)
    manifest.version = `v${String(number).padStart(6, '0')}`
    for (const id of topics) {
      const source = manifest.sources[(id - 1) % 2]!, page = `topics/T-${id}.md`
      const text = await readFile(path.join(f.root, source.files.source), 'utf8')
      manifest.pages![page] = await putPage(f.root, `# 主题${id}\n\n${text}\n`)
      manifest.deps!.pages[page] = { sources: [source.source_id], points: [{ point_id: source.source_id + ':P1', text_hash: hash(text) }],
        ...(reviewed ? { review: { fingerprint: '人工已核对', removed: [] } } : {}) }
    }
    await writeJson(f.root, `versions/${manifest.version}.json`, { manifest, checksum: hash(storageJson(manifest)) })
    return manifest
  }
  const current = (manifest: SnapshotManifest, history: string[] = []) => writeJson(f.root, 'state/current.json', { version: manifest.version, revocation_generation: 0, history })
  const estimateReview = vi.fn(async (step: { unitIds: string[] }) => ({ calls: step.unitIds.length, inputTokens: 10, outputTokens: 10, maxInputTokens: 10, maxOutputTokens: 10 }))
  const options = { upgrade: { maxCalls: 0 }, estimateReview }
  return { ...f, version, current, options }
}

function models(f: Awaited<ReturnType<typeof fixture>>, failure: 'transport' | 'semantic' = 'transport') {
  const library = newLibrary('可达性夹具'), policy = defaultPolicy(), registry = emptyRegistry(), calls: string[] = []
  library.wikiPath = f.root; library.sourceRoots = [f.parent]; library.models.unified = { provider: 'offline', model: 'review' }
  library.models.layeredRoutes = {}; library.models.fallbacks = []; library.layered = { embeddingMode: 'none' }
  library.models.providerProfiles.offline = { concurrency: 1, retryLimit: 0, backoffMs: 0, cacheMode: 'none' }
  policy.batchDelayMs = 0; policy.pageGenerationConcurrency = 1; policy.maxTokensPerCall = 512
  const runtime: ModelRuntime = { resolveModelInfo: vi.fn(async (provider, id) => ({ provider, id, name: id, context: { contextWindow: 131072 } })),
    stream: vi.fn(async function* (request) {
      const message = request.messages[0]!.content[0]!
      if (message.type !== 'text') throw new Error('只接受离线文本')
      const data = JSON.parse(message.text), key = data.topic_id
      calls.push(key)
      yield { type: 'usage' as const, usage: { inputTokens: 11, outputTokens: 5 } }
      if (failure === 'transport' && key === 'T-2') {
        yield { type: 'finish' as const, reason: { kind: 'error' as const, failure: { code: 'EIO', message: '离线模拟旧对象失败' } } }; return
      }
      const items = data.sentences.map((item: { id: string }) => ({ id: item.id,
        support: failure === 'semantic' ? '不支撑' : '完整支撑', missing: failure === 'semantic' ? '成员没有支撑此主张。' : null }))
      const output = data.review_stage === 'topic-correction' ? { sentences: items.map((item: object) => ({ ...item, text: '', point_ids: [] })) } : { items }
      yield { type: 'text-delta' as const, index: 0, text: JSON.stringify(output) }
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
    }) }
  return { calls, client: (maxCalls: number) => createBuildModelClient(runtime, library, policy, { ...registry, upgrade: { maxCalls } }) }
}

it('孤立旧版零新增核对，完整物理备份、复用与未知来源记录保持', async () => {
  const f = await fixture(), old = await f.version(1, [2]), current = await f.version(2, [1], true)
  await f.current(current)
  const before = await snapshot(f.root), done = (await upgradeLibrary(f.root, f.options))!
  expect(done.status).toBe('complete'); expect(done.steps).toEqual([]); expect(done.actual.calls).toBe(0)
  expect(f.options.estimateReview).not.toHaveBeenCalled()
  const backup = await verifyUpgradeBackup(done.backupPath)
  expect(backup.files).toEqual(before); expect(await snapshot(done.backupPath, Object.keys(before))).toEqual(before)
  expect(done.reuse.some(item => item.path === pageObjectPath(old.pages!['topics/T-2.md']!))).toBe(true)
  expect(await readFile(path.join(f.root, 'versions/v000001.json'))).toEqual(await readFile(path.join(done.backupPath, 'versions/v000001.json')))
  const provenance = await readProvenance(f.root, 'v000001', hash(storageJson(old)))
  expect(Object.values(provenance.artifacts).find(item => item.pagePath === 'topics/T-2.md')).toMatchObject({ status: 'unknown' })
  expect(old.deps!.pages['topics/T-2.md']!.review).toBeUndefined()
  await expect(readFile(path.join(f.root, 'state/retired-versions.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('全部历史、内存pin、有效租约及已有宽限入队，过期孤立版不入队且不改保留记录', async () => {
  const f = await fixture(), versions = []
  for (let number = 1; number <= 7; number++) versions.push(await f.version(number, [number]))
  await f.current(versions[0]!)
  const pin = await pinVersion(f.root, undefined, false)
  try {
    await f.current(versions[4]!, ['v000002', 'v000003'])
    await writeJson(f.root, 'state/readers/active.json', { pid: process.pid, device: '人工设备', version: 'v000004', expires_at: Date.now() + readerLeaseMs })
    await writeJson(f.root, 'state/readers/expired.json', { pid: process.pid, device: '人工设备', version: 'v000007', expires_at: Date.now() - 1 })
    await writeJson(f.root, 'state/retired-versions.json', { v000006: Date.now(), v000007: Date.now() - readerLeaseMs - 1 })
    const before = await snapshot(f.root), roots = await readRetentionRoots(f.root)
    expect([...roots.versions].sort()).toEqual(['v000001', 'v000002', 'v000003', 'v000004', 'v000005', 'v000006'])
    expect(await snapshot(f.root)).toEqual(before)
    const paused = (await upgradeLibrary(f.root, f.options))!
    expect(paused.status).toBe('paused')
    expect(paused.steps.flatMap(step => step.unitIds).sort()).toEqual(versions.slice(0, 6).map((manifest, index) => pageObjectPath(manifest.pages![`topics/T-${index + 1}.md`]!)).sort())
    expect(await readFile(path.join(f.root, 'state/readers/expired.json'), 'utf8')).toContain('v000007')
    await writeJson(f.root, 'state/readers/expired.json', { pid: process.pid, device: '人工设备', version: 'v000007', expires_at: Date.now() + readerLeaseMs })
    await expect(upgradeLibrary(f.root, f.options)).rejects.toMatchObject({ code: 'UPGRADE_ROOT_CHANGED' })
    expect((await readUpgradeStatus(f.root))!.status).toBe('paused')
  } finally { await pin.release() }
})

it('待发布与冲突按对象取完整上下文，孤立同级页不扩入，缺根及坏根明确拒绝', async () => {
  const f = await fixture(), old = await f.version(1, [2, 3]), current = await f.version(2, [1], true)
  const preview = await f.version(3, [5]), reading = await f.version(4, [6]), pending = await f.version(5, [4])
  await unlink(path.join(f.root, 'versions/v000005.json'))
  await f.current(current)
  await writeJson(f.root, 'work/pending.json', { version: null, base_version: 'v000002', manifest: pending })
  await writeJson(f.root, 'work/preview.json', { version: preview.version, base_version: 'v000002' })
  await writeJson(f.root, 'state/reading-copy.json', { version: 'v000002', target: reading.version, materialized: {}, desired: { 'topics/T-6.md': reading.pages!['topics/T-6.md']! }, failures: {} })
  await writeJson(f.root, 'conflicts/one.json', { page: 'topics/T-2.md', version: 'v000001', previous_object: null, new_object: old.pages!['topics/T-2.md']! })
  const paused = (await upgradeLibrary(f.root, f.options))!
  expect(paused.steps.flatMap(step => step.unitIds).sort()).toEqual([old.pages!['topics/T-2.md']!, pending.pages!['topics/T-4.md']!, preview.pages!['topics/T-5.md']!, reading.pages!['topics/T-6.md']!].map(pageObjectPath).sort())
  expect(paused.steps.flatMap(step => step.unitIds)).not.toContain(pageObjectPath(old.pages!['topics/T-3.md']!))
  const broken = await fixture()
  await unlink(path.join(broken.root, 'state/current.json'))
  await writeJson(broken.root, 'state/reading-copy.json', { version: 'v000001', target: null, materialized: {}, failures: {} })
  await expect(upgradeLibrary(broken.root, broken.options)).rejects.toMatchObject({ code: 'UPGRADE_ROOT_INCOMPLETE' })
  await writeJson(broken.root, 'state/current.json', { version: null, revocation_generation: 0 })
  await expect(upgradeLibrary(broken.root, broken.options)).rejects.toMatchObject({ code: 'UPGRADE_ROOT_INCOMPLETE' })
  await writeJson(broken.root, 'state/current.json', { version: 'v000001', revocation_generation: 0 })
  await writeJson(broken.root, 'work/pending.json', {})
  await expect(upgradeLibrary(broken.root, broken.options)).rejects.toMatchObject({ code: 'UPGRADE_ROOT_INCOMPLETE' })
  await unlink(path.join(broken.root, 'work/pending.json'))
  await writeJson(broken.root, 'state/readers/broken.json', { pid: process.pid, device: '人工设备', expires_at: Date.now() + readerLeaseMs })
  await expect(upgradeLibrary(broken.root, broken.options)).rejects.toMatchObject({ code: 'UPGRADE_ROOT_INCOMPLETE' })
  const first = await fixture(), manifest = JSON.parse(await readFile(path.join(first.root, 'versions/v000001.json'), 'utf8')).manifest
  await unlink(path.join(first.root, 'state/current.json'))
  await writeJson(first.root, 'work/pending.json', { version: 'v000001', base_version: null, manifest })
  await writeJson(first.root, 'work/preview.json', { version: 'v000001', base_version: null })
  expect((await upgradeLibrary(first.root, first.options))!.status).toBe('complete')
  const ambiguous = await fixture(), previous = await ambiguous.version(1, [1]), next = structuredClone(previous)
  next.version = 'v000002'; next.sources[0]!.source_version = hash('同正文的不同来源版本')
  await writeJson(ambiguous.root, 'versions/v000002.json', { manifest: next, checksum: hash(storageJson(next)) })
  await ambiguous.current(next, ['v000001'])
  const m = models(ambiguous)
  await expect(upgradeLibrary(ambiguous.root, m.client(0).upgradeOptions)).rejects.toMatchObject({ code: 'UPGRADE_ROOT_INCOMPLETE' })
  expect(m.calls).toEqual([])
})

it('已付费混合旧计划从备份找回后收缩，同身份费用保留且健康对象严格复用零重调', async () => {
  const f = await fixture(); await f.version(1, [1, 2]); const current = await f.version(2, [1])
  await f.current(current)
  await writeJson(f.root, 'state/readers/old.json', { pid: process.pid, device: '人工设备', version: 'v000001', expires_at: Date.now() + readerLeaseMs })
  const m = models(f), initial = (await upgradeLibrary(f.root, m.client(0).upgradeOptions))!
  expect(initial.steps).toHaveLength(1); expect(initial.steps[0]!.unitIds).toHaveLength(2)
  const backupBefore = await snapshot(initial.backupPath)
  await expect(upgradeLibrary(f.root, m.client(2).upgradeOptions)).rejects.toThrow('离线模拟旧对象失败')
  const paused = (await readUpgradeStatus(f.root))!, costs = await readRunCosts(f.root, initial.id)
  expect(m.calls).toEqual(['T-1', 'T-2']); expect(costs.total.calls).toBe(2)
  const acceptedFiles = (await readdir(path.join(f.root, 'work/accepted/tasks'))).map(file => 'work/accepted/tasks/' + file)
  const acceptedBefore = await snapshot(f.root, acceptedFiles)
  expect(acceptedFiles.length).toBeGreaterThan(0)
  await writeJson(f.root, 'state/readers/old.json', { pid: process.pid, device: '人工设备', version: 'v000001', expires_at: Date.now() - 1 })
  // 模拟旧检查点丢失：只能从原完整备份找回同一次升级，账本不能重置。
  await unlink(path.join(f.root, 'work/upgrade-0.3.0.json'))
  const restored = (await upgradeLibrary(f.root, m.client(1).upgradeOptions))!
  expect(restored).toMatchObject({ id: initial.id, backupPath: initial.backupPath, status: 'paused', actual: { calls: 2 } })
  const previous = JSON.parse(await readFile(path.join(f.root, acceptedFiles[0]!), 'utf8')) as AcceptedRecord
  restored.accepted['已退出的原步骤'] = { taskId: previous.taskId, path: acceptedFiles[0]!, digest: previous.acceptedDigest }
  await writeProtocol(f.root, 'work/upgrade-0.3.0.json', restored)
  const done = (await upgradeLibrary(f.root, m.client(2).upgradeOptions))!
  expect(done).toMatchObject({ id: initial.id, backupPath: initial.backupPath, inputDigest: initial.inputDigest, files: initial.files, reuse: initial.reuse, status: 'complete' })
  expect(done.steps).toHaveLength(1); expect(done.steps[0]!.unitIds).toHaveLength(1)
  expect(done.steps[0]!.reviewOrigin).toMatchObject({ id: paused.steps[0]!.id, inputDigest: paused.steps[0]!.inputDigest })
  expect(m.calls).toEqual(['T-1', 'T-2']); expect(await readRunCosts(f.root, initial.id)).toEqual(costs)
  expect(await snapshot(initial.backupPath)).toEqual(backupBefore); expect(await snapshot(f.root, acceptedFiles)).toEqual(acceptedBefore)
  const outer = (await createExecutionLedger(f.root).readAcceptance(done.accepted[done.steps[0]!.id]!.taskId)).record as AcceptedRecord
  expect(outer.dependencies.length).toBeGreaterThan(0)
  expect(done.accepted['已退出的原步骤']).toEqual(restored.accepted['已退出的原步骤'])
}, 60000)

it('有效根内真实不支撑仍暂停，旧正文和缺核对标记保持', async () => {
  const f = await fixture(), current = await f.version(1, [1]); await f.current(current)
  const before = await readFile(path.join(f.root, 'versions/v000001.json')), m = models(f, 'semantic')
  await expect(upgradeLibrary(f.root, m.client(8).upgradeOptions)).rejects.toMatchObject({ code: 'UPGRADE_REVIEW_PAUSED' })
  expect((await readUpgradeStatus(f.root))!.status).toBe('paused'); expect(m.calls.length).toBeGreaterThan(0)
  expect(await readFile(path.join(f.root, 'versions/v000001.json'))).toEqual(before)
  expect(current.deps!.pages['topics/T-1.md']!.review).toBeUndefined()
  expect(JSON.parse(await readFile(path.join(f.root, '.llmwiki/policy.json'), 'utf8')).libraryFormat).not.toBe('0.3.0')
}, 60000)
