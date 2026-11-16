import * as fs from 'node:fs/promises'
import { Socket } from 'node:net'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createBuildModelClient } from '../src/host/models.js'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { defaultPolicy } from '../src/domain/policy.js'
import { hash, writeJson } from '../src/layered/files.js'
import { readRunCosts, usageTokens } from '../src/layered/costs.js'
import { readVersion, versionPage } from '../src/layered/objects.js'
import { extractionReviewRequests } from '../src/layered/review.js'
import { storageJson } from '../src/layered/vectors.js'
import { readUpgradeStatus, restoreUpgradeBackup, upgradeLibrary, verifyUpgradeBackup } from '../src/layered/upgrade.js'
import type { AttemptEntry, Extraction } from '../src/layered/schema.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { legacyFixture } from './b3-fixture.js'

// 沿用现有文件系统注入方式，所有实际文件仍落在系统临时目录。
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

const productCommit = 'b5dbe637753170c70c30e114a478935a8efd33c5'
const evidence = path.join(tmpdir(), 'llmwiki-upgrade-interrupt-budget-20261116', randomUUID())
const network: string[] = []
beforeEach(() => {
  network.length = 0
  vi.stubGlobal('fetch', vi.fn(() => { network.push('fetch'); throw new Error('离线升级测试禁止网络') }))
  vi.spyOn(Socket.prototype, 'connect').mockImplementation(() => { network.push('socket'); throw new Error('离线升级测试禁止 TCP') })
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function snapshot(root: string, files?: string[]) {
  const names = files ?? (await fs.readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
    .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)))
  return Object.fromEntries(await Promise.all(names.sort().map(async file => [file, hash(await fs.readFile(path.join(root, file)))])))
}

async function attempts(root: string, run: string) {
  const directory = path.join(root, 'logs/model-runs', run, 'attempts')
  const names = await fs.readdir(directory).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))
  return Promise.all(names.sort().map(async name => JSON.parse(await fs.readFile(path.join(directory, name), 'utf8')) as AttemptEntry))
}

async function readable(f: Awaited<ReturnType<typeof legacyFixture>>) {
  const manifest = await readVersion(f.root, 'v000001')
  expect(manifest).toEqual(f.manifest)
  return hash(await versionPage(f.root, manifest, 'index.md'))
}

// 每次执行使用新证据目录；失败也先封存真实现场，再由已有夹具清理临时根。
async function capture(name: string, f: Awaited<ReturnType<typeof legacyFixture>>, run: (record: Record<string, unknown>) => Promise<void>) {
  const record: Record<string, unknown> = { baseCommit: productCommit,
    productSourceSha256: hash(await fs.readFile(new URL('../src/layered/upgrade.ts', import.meta.url))),
    testSourceSha256: hash(await fs.readFile(new URL('./upgrade-interrupt-budget.test.ts', import.meta.url))),
    fixture: '手工旧结构，非历史 SDK 产出或真实语义证据', root: f.root }
  try { await run(record); expect(network).toEqual([]); record.passed = true }
  catch (error) { record.passed = false; record.error = error instanceof Error ? { message: error.message, stack: error.stack } : String(error); throw error }
  finally {
    const target = path.join(evidence, name)
    await fs.mkdir(target, { recursive: true })
    await fs.cp(f.parent, path.join(target, 'fixture'), { recursive: true })
    await fs.writeFile(path.join(target, 'result.json'), JSON.stringify({ ...record, network: [...network] }, null, 2) + '\n')
    console.info('升级边界证据：' + target)
  }
}

async function reviewFixture(count = 2, points = 1, claimCopies = 0) {
  const f = await legacyFixture('0.2.1')
  const units = []
  for (const entry of f.manifest.sources.slice(0, count)) {
    const bytes = await fs.readFile(path.join(f.root, entry.files.source)), text = bytes.toString('utf8')
    const segment = { locator: 'L1-L1', start: 0, end: text.length, text_hash: entry.content_hash }
    entry.segments = [segment]
    const extraction: Extraction = { format_version: 1, source_id: entry.source_id, source_hash: entry.content_hash,
      processing: entry.extract.processing, metadata: entry.metadata, calls: [], segments: [{ ...segment, resource_hashes: [],
        processing_fingerprint: hash(text), terms: [], points: Array.from({ length: points }, (_, index) => {
          const claim = text + '研究条件'.repeat(claimCopies) + index
          return { point_id: `${entry.source_id}:P${index + 1}`, text: claim, text_hash: hash(claim), section: '主要发现' as const,
            locator: 'L1-L1', source_version: entry.source_version,
            evidence: [{ source_id: entry.source_id, source_version: entry.source_version, locator: 'L1-L1', quote: text }] }
        }) }] }
    await writeJson(f.root, entry.extract.path, extraction)
    units.push({ extraction, source: { path: entry.current_path, bytes, text, contentHash: entry.content_hash,
      sourceId: entry.source_id, sourceVersion: entry.source_version, segments: entry.segments, metadata: entry.metadata } })
  }
  await writeJson(f.root, 'versions/v000001.json', { manifest: f.manifest, checksum: hash(storageJson(f.manifest)) })
  const library = newLibrary('离线边界夹具'), policy = defaultPolicy(), registry = emptyRegistry()
  library.wikiPath = f.root; library.sourceRoots = [f.parent]
  library.models.unified = { provider: 'offline', model: 'review' }; library.models.layeredRoutes = {}; library.models.fallbacks = []
  library.models.providerProfiles.offline = { concurrency: 2, retryLimit: 1, backoffMs: 0, cacheMode: 'none' }
  policy.batchDelayMs = 0; policy.pageGenerationConcurrency = 1; policy.maxTokensPerCall = 512
  const control = { context: 131072, fullUsage: false }
  const calls: { source: string; ids: string[]; inputTokens: number; outputTokens: number }[] = []
  const receive = (request: Parameters<ModelRuntime['stream']>[0]) => {
    expect(request.provider).toBe('offline'); expect(request.maxTokens).toBe(512)
    const message = request.messages[0]!.content[0]!
    if (message.type !== 'text') throw new Error('只允许离线文本')
    const data = JSON.parse(message.text) as { source_id: string; points: { id: string }[] }
    const usage = { inputTokens: control.fullUsage ? Math.ceil(Buffer.byteLength((request.system ?? '') + message.text) / 4) : 11,
      outputTokens: control.fullUsage ? request.maxTokens! : 5 }
    calls.push({ source: data.source_id, ids: data.points.map(item => item.id), ...usage })
    return { data, usage, text: JSON.stringify({ items: data.points.map(item => ({ id: item.id, support: '完整支撑', missing: null })) }) }
  }
  const stream = vi.fn(async function* (request: Parameters<ModelRuntime['stream']>[0]) {
    const output = receive(request)
    yield { type: 'usage' as const, usage: output.usage }
    yield { type: 'text-delta' as const, index: 0, text: output.text }
    yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
  })
  const runtime: ModelRuntime = { stream, resolveModelInfo: vi.fn(async (provider, id) =>
    ({ provider, id, name: id, context: { contextWindow: control.context }, defaultMaxTokens: 512 })) }
  const client = (upgrade: { maxCalls?: number; maxTokens?: number } = {}) => createBuildModelClient(runtime, library, policy, { ...registry, upgrade })
  const originals = await snapshot(f.root)
  const old = Object.fromEntries(Object.entries(originals).filter(([file]) => file.replaceAll('\\', '/') !== '.llmwiki/policy.json'))
  return { ...f, units, library, policy, control, calls, receive, stream, client, originals, old }
}

it('正数 token 预算在失败重试时耗尽，重入累计且已接受对象不重调', async () => {
  const f = await reviewFixture()
  await capture('token-budget', f, async record => {
    f.control.fullUsage = true
    const baseStream = f.stream.getMockImplementation()!
    f.stream.mockImplementation(async function* (request) {
      const output = f.receive(request)
      yield { type: 'usage' as const, usage: output.usage }
      if (output.data.source_id === 'S-0002' && f.calls.filter(call => call.source === 'S-0002').length === 1) {
        yield { type: 'finish' as const, reason: { kind: 'error' as const, failure: { code: 'SERVER', message: '离线传输失败', status: 503 } } }
        return
      }
      yield { type: 'text-delta' as const, index: 0, text: output.text }
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
    })
    const initial = (await upgradeLibrary(f.root, f.client({ maxCalls: 0 }).upgradeOptions))!
    const maxTokens = initial.estimate.inputTokens + initial.estimate.outputTokens
    const backup = await snapshot(initial.backupPath), page = await readable(f)
    record.initial = initial; record.limit = maxTokens
    await expect(upgradeLibrary(f.root, f.client({ maxTokens }).upgradeOptions)).rejects.toMatchObject({ budgetPause: true })
    const paused = (await readUpgradeStatus(f.root))!, spent = await readRunCosts(f.root, initial.id)
    const accepted = await snapshot(path.join(f.root, 'work/accepted/tasks'))
    record.paused = paused; record.attemptsAtPause = await attempts(f.root, initial.id); record.costsAtPause = spent
    expect(paused).toMatchObject({ id: initial.id, backupPath: initial.backupPath, status: 'paused', actual: { calls: 2, tokens: maxTokens } })
    expect(paused.reason).toContain('Token'); expect(Object.keys(accepted).length).toBeGreaterThan(0)
    expect(usageTokens(spent.total.usage)).toBe(maxTokens); expect(spent.total.reservedTokens).toBe(0)
    expect(f.calls).toHaveLength(2); expect(await readable(f)).toBe(page)
    const sameLimit = (await upgradeLibrary(f.root, f.client({ maxTokens }).upgradeOptions))!
    expect(sameLimit.status).toBe('paused'); expect(f.calls).toHaveLength(2)
    f.stream.mockImplementation(baseStream)
    const totalLimit = maxTokens + sameLimit.estimate.inputTokens + sameLimit.estimate.outputTokens
    const done = (await upgradeLibrary(f.root, f.client({ maxTokens: totalLimit }).upgradeOptions))!
    record.done = done; record.finalCosts = await readRunCosts(f.root, initial.id); record.calls = f.calls
    expect(done).toMatchObject({ id: initial.id, backupPath: initial.backupPath, status: 'complete', actual: { calls: 3, tokens: totalLimit } })
    expect(f.calls.filter(call => call.source === 'S-0001')).toHaveLength(1)
    expect(f.calls.filter(call => call.source === 'S-0002')).toHaveLength(2)
    expect(await snapshot(path.join(f.root, 'work/accepted/tasks'), Object.keys(accepted))).toEqual(accepted)
    expect(await snapshot(initial.backupPath)).toEqual(backup)
    expect(await snapshot(f.root, Object.keys(f.old))).toEqual(f.old); expect(await readable(f)).toBe(page)
    await upgradeLibrary(f.root, f.client({ maxTokens: totalLimit }).upgradeOptions)
    expect(f.calls).toHaveLength(3)
  })
}, 60000)

it('同一升级对象的两个真实核对分块并发，重试受全部在途预占约束', async () => {
  const f = await reviewFixture(1, 2, 400)
  await capture('inflight-reservation', f, async record => {
    f.control.fullUsage = true; f.policy.pageGenerationConcurrency = 2
    const unit = f.units[0]!, single = structuredClone(unit.extraction)
    single.segments[0]!.points = single.segments[0]!.points.slice(0, 1)
    const options = { knowledgeRoot: f.parent, client: f.client(), topics: { extractionReview: 'all' as const } }
    const one = extractionReviewRequests(single, unit.source, options, 100000)[0]!
    const inputLimit = Math.ceil((Buffer.byteLength(one.system + one.input) + 128) / 0.9)
    f.control.context = inputLimit + 512
    const planned = extractionReviewRequests(unit.extraction, unit.source, options, inputLimit)
    expect(planned).toHaveLength(2)
    const initial = (await upgradeLibrary(f.root, f.client({ maxCalls: 0 }).upgradeOptions))!
    expect(initial.estimate.calls).toBe(2)
    const maxTokens = initial.estimate.inputTokens + initial.estimate.outputTokens, backup = await snapshot(initial.backupPath)
    let started = 0, active = 0, peak = 0, release!: () => void
    const both = new Promise<void>(resolve => { release = resolve })
    const baseStream = f.stream.getMockImplementation()!
    f.stream.mockImplementation(async function* (request) {
      const output = f.receive(request), index = started++
      active++; peak = Math.max(peak, active)
      if (started === 2) release()
      try {
        yield { type: 'usage' as const, usage: output.usage }
        if (index === 0) {
          let timer: ReturnType<typeof setTimeout> | undefined
          try { await Promise.race([both, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('真实执行未出现两个并发分块')), 5000) })]) }
          finally { clearTimeout(timer) }
          record.inflight = await attempts(f.root, initial.id)
          record.inflightCosts = await readRunCosts(f.root, initial.id)
          yield { type: 'finish' as const, reason: { kind: 'error' as const, failure: { code: 'SERVER', message: '并发中的离线传输失败', status: 503 } } }
          return
        }
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => { request.signal?.removeEventListener('abort', abort); reject(new Error('预算拒绝后未取消在途分块')) }, 5000)
          const abort = () => { clearTimeout(timer); resolve() }
          if (request.signal?.aborted) abort(); else request.signal?.addEventListener('abort', abort, { once: true })
        })
        request.signal?.throwIfAborted()
      } finally { active-- }
    })
    record.initial = initial; record.limit = maxTokens
    await expect(upgradeLibrary(f.root, f.client({ maxCalls: 4, maxTokens }).upgradeOptions)).rejects.toMatchObject({ budgetPause: true })
    const paused = (await readUpgradeStatus(f.root))!, spent = await readRunCosts(f.root, initial.id)
    record.paused = paused; record.costsAtPause = spent; record.peak = peak; record.callsBeforeResume = [...f.calls]
    expect(peak).toBe(2); expect(f.calls).toHaveLength(2); expect(paused.reason).toContain('Token')
    const inflight = record.inflight as AttemptEntry[]
    expect(inflight).toHaveLength(2); expect(inflight.every(entry => entry.state === 'dispatched')).toBe(true)
    expect(inflight.reduce((sum, entry) => sum + entry.request.estimatedInputTokens + entry.request.maxOutputTokens, 0)).toBe(maxTokens)
    expect(spent.total.calls).toBe(2); expect(usageTokens(spent.total.usage) + spent.total.reservedTokens).toBeLessThanOrEqual(maxTokens)
    expect((await upgradeLibrary(f.root, f.client({ maxCalls: 4, maxTokens }).upgradeOptions))!.status).toBe('paused')
    expect(f.calls).toHaveLength(2)
    f.stream.mockImplementation(baseStream)
    const totalLimit = usageTokens(spent.total.usage) + spent.total.reservedTokens + maxTokens
    const done = (await upgradeLibrary(f.root, f.client({ maxCalls: 4, maxTokens: totalLimit }).upgradeOptions))!
    record.done = done; record.finalAttempts = await attempts(f.root, initial.id); record.calls = f.calls
    expect(done).toMatchObject({ id: initial.id, backupPath: initial.backupPath, status: 'complete', actual: { calls: 4 } })
    expect(done.actual.tokens).toBeLessThanOrEqual(totalLimit)
    expect(await snapshot(initial.backupPath)).toEqual(backup)
    expect(await snapshot(f.root, Object.keys(f.old))).toEqual(f.old); await readable(f)
    await upgradeLibrary(f.root, f.client({ maxCalls: 4, maxTokens: totalLimit }).upgradeOptions)
    expect(f.calls).toHaveLength(4)
    record.boundary = '步骤和对象顺序执行；本例只证明同一对象初轮分块的实际并发。未接受对象续跑可重做分块，完整接受后不重调。'
  })
}, 60000)

it('备份复制与 complete 标记前连续中断，半备份拒绝恢复且重跑不覆盖', async () => {
  const f = await legacyFixture('0.2.0')
  await capture('backup-interruption', f, async record => {
    const old = await snapshot(f.root), page = await readable(f), copy = fs.copyFile, rename = fs.rename
    let copies = 0, stopCopy = true, stopComplete = false
    vi.spyOn(fs, 'copyFile').mockImplementation(async (...args) => {
      if (stopCopy && String(args[1]).includes('.backup-before-0.3.0-') && ++copies === 2) {
        stopCopy = false; throw Object.assign(new Error('复制第二文件前中断'), { code: 'EIO' })
      }
      return copy(...args)
    })
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      if (stopComplete && String(args[1]).endsWith('.llmwiki-upgrade-backup.json')) {
        const data = JSON.parse(await fs.readFile(String(args[0]), 'utf8'))
        if (data.complete) { stopComplete = false; throw Object.assign(new Error('备份 complete 原子提交前中断'), { code: 'EIO' }) }
      }
      return rename(...args)
    })
    const backups = async () => (await fs.readdir(f.parent)).filter(name => name.includes('.backup-before-0.3.0-')).sort().map(name => path.join(f.parent, name))
    await expect(upgradeLibrary(f.root)).rejects.toThrow('复制第二文件前中断')
    const partial = (await backups())[0]!, partialHash = await snapshot(partial)
    expect(Object.keys(partialHash)).toHaveLength(2)
    await expect(verifyUpgradeBackup(partial)).rejects.toMatchObject({ code: 'UPGRADE_BACKUP_CORRUPT' })
    await expect(restoreUpgradeBackup(f.root, partial)).rejects.toMatchObject({ code: 'UPGRADE_BACKUP_CORRUPT' })
    expect(await readUpgradeStatus(f.root)).toBeUndefined(); expect(await snapshot(f.root, Object.keys(old))).toEqual(old)
    expect(await readable(f)).toBe(page)
    stopComplete = true
    await expect(upgradeLibrary(f.root)).rejects.toThrow('备份 complete 原子提交前中断')
    const beforeMarker = (await backups()).find(backup => backup !== partial)!, beforeMarkerHash = await snapshot(beforeMarker)
    const meta = JSON.parse(await fs.readFile(path.join(beforeMarker, '.llmwiki-upgrade-backup.json'), 'utf8'))
    expect(meta.complete).toBe(false)
    for (const [file, digest] of Object.entries(meta.files)) expect(hash(await fs.readFile(path.join(beforeMarker, file)))).toBe(digest)
    await expect(verifyUpgradeBackup(beforeMarker)).rejects.toMatchObject({ code: 'UPGRADE_BACKUP_CORRUPT' })
    expect(await snapshot(partial)).toEqual(partialHash); expect(await snapshot(f.root, Object.keys(old))).toEqual(old)
    expect(await readable(f)).toBe(page)
    const done = (await upgradeLibrary(f.root))!, completeHash = await snapshot(done.backupPath)
    expect(done.status).toBe('complete'); expect(done.actual.calls).toBe(0)
    expect(await backups()).toHaveLength(3); expect((await verifyUpgradeBackup(done.backupPath)).complete).toBe(true)
    expect(await snapshot(partial)).toEqual(partialHash); expect(await snapshot(beforeMarker)).toEqual(beforeMarkerHash)
    const oldData = Object.fromEntries(Object.entries(old).filter(([file]) => file.replaceAll('\\', '/') !== '.llmwiki/policy.json'))
    expect(await snapshot(f.root, Object.keys(oldData))).toEqual(oldData); expect(await readable(f)).toBe(page)
    await upgradeLibrary(f.root)
    expect(await snapshot(done.backupPath)).toEqual(completeHash); expect(await backups()).toHaveLength(3)
    record.partial = { path: partial, files: partialHash }; record.beforeMarker = { path: beforeMarker, files: beforeMarkerHash }
    record.done = done; record.completedBackup = completeHash; record.old = old; record.modelCalls = 0
  })
}, 60000)

it('接受后连续中断格式原子提交与收尾，重入不派发且状态和日志一致', async () => {
  const f = await reviewFixture()
  await capture('format-finalization', f, async record => {
    const rename = fs.rename, page = await readable(f)
    let fault: 'before-policy' | 'after-policy' | 'before-complete' | 'before-log' | null = 'before-policy'
    const hits: string[] = []
    vi.spyOn(fs, 'rename').mockImplementation(async (...args) => {
      const file = String(args[1]).replaceAll('\\', '/'), text = await fs.readFile(String(args[0]), 'utf8')
      if (fault === 'before-policy' && file.endsWith('/.llmwiki/policy.json') && JSON.parse(text).libraryFormat === '0.3.0') {
        hits.push(fault); fault = null; throw Object.assign(new Error('格式原子替换前中断'), { code: 'EIO' })
      }
      if (fault === 'after-policy' && file.endsWith('/.llmwiki/policy.json') && JSON.parse(text).libraryFormat === '0.3.0') {
        await rename(...args); hits.push(fault); fault = null; throw Object.assign(new Error('格式原子替换后中断'), { code: 'EIO' })
      }
      if (fault === 'before-complete' && file.endsWith('/work/upgrade-0.3.0.json') && JSON.parse(text).status === 'complete') {
        record.logAtCheckpointFailure = await fs.readFile(path.join(f.root, 'logs/build.md'), 'utf8')
        hits.push(fault); fault = null; throw Object.assign(new Error('complete 检查点提交前中断'), { code: 'EIO' })
      }
      if (fault === 'before-log' && file.endsWith('/logs/build.md') && text.includes('- 升级 complete；')) {
        hits.push(fault); fault = null; throw Object.assign(new Error('收尾日志提交前中断'), { code: 'EIO' })
      }
      return rename(...args)
    })
    await expect(upgradeLibrary(f.root, f.client({ maxCalls: 2 }).upgradeOptions)).rejects.toThrow('格式原子替换前中断')
    const first = (await readUpgradeStatus(f.root))!, backup = await snapshot(first.backupPath)
    const accepted = await snapshot(path.join(f.root, 'work/accepted/tasks'))
    expect(first.actual.calls).toBe(2); expect(f.calls).toHaveLength(2)
    expect(await fs.readFile(path.join(f.root, '.llmwiki/policy.json'))).toEqual(await fs.readFile(path.join(first.backupPath, '.llmwiki/policy.json')))
    expect(await readable(f)).toBe(page)
    fault = 'after-policy'
    await expect(upgradeLibrary(f.root, f.client({ maxCalls: 2 }).upgradeOptions)).rejects.toThrow('格式原子替换后中断')
    expect(JSON.parse(await fs.readFile(path.join(f.root, '.llmwiki/policy.json'), 'utf8')).libraryFormat).toBe('0.3.0')
    expect((await readUpgradeStatus(f.root))!.status).toBe('paused'); expect(await readable(f)).toBe(page)
    fault = 'before-log'
    await expect(upgradeLibrary(f.root, f.client({ maxCalls: 2 }).upgradeOptions)).rejects.toThrow('收尾日志提交前中断')
    const afterLogFailure = (await readUpgradeStatus(f.root))!, logBeforeResume = await fs.readFile(path.join(f.root, 'logs/build.md'), 'utf8')
    expect(afterLogFailure.status).toBe('paused')
    expect(logBeforeResume).not.toContain('- 升级 complete；')
    fault = 'before-complete'
    await expect(upgradeLibrary(f.root, f.client({ maxCalls: 2 }).upgradeOptions)).rejects.toThrow('complete 检查点提交前中断')
    expect((await readUpgradeStatus(f.root))!.status).toBe('paused')
    const done = (await upgradeLibrary(f.root, f.client({ maxCalls: 2 }).upgradeOptions))!
    const logAfterResume = await fs.readFile(path.join(f.root, 'logs/build.md'), 'utf8')
    record.hits = hits; record.first = first; record.afterLogFailure = afterLogFailure; record.done = done
    record.logBeforeResume = logBeforeResume; record.logAfterResume = logAfterResume
    record.calls = f.calls; record.finalCosts = await readRunCosts(f.root, first.id)
    record.oldUnchanged = JSON.stringify(await snapshot(f.root, Object.keys(f.old))) === JSON.stringify(f.old)
    record.backupUnchanged = JSON.stringify(await snapshot(first.backupPath)) === JSON.stringify(backup)
    record.acceptedUnchanged = JSON.stringify(await snapshot(path.join(f.root, 'work/accepted/tasks'), Object.keys(accepted))) === JSON.stringify(accepted)
    expect(hits).toEqual(['before-policy', 'after-policy', 'before-log', 'before-complete'])
    expect(done).toMatchObject({ id: first.id, backupPath: first.backupPath, status: 'complete', actual: { calls: 2 } })
    expect(f.calls).toHaveLength(2); expect(record.oldUnchanged).toBe(true); expect(record.backupUnchanged).toBe(true)
    expect(record.acceptedUnchanged).toBe(true); expect(await readable(f)).toBe(page)
    const completionLines = logAfterResume.split('\n').filter(line => line.startsWith('- 升级 complete；') && line.endsWith('；备份：' + first.backupPath))
    expect(completionLines).toHaveLength(1)
    expect(record.logAtCheckpointFailure).toBe(logAfterResume)
    await upgradeLibrary(f.root, f.client({ maxCalls: 2 }).upgradeOptions)
    await upgradeLibrary(f.root, f.client({ maxCalls: 2 }).upgradeOptions)
    expect(await fs.readFile(path.join(f.root, 'logs/build.md'), 'utf8')).toBe(logAfterResume)
    expect(f.calls).toHaveLength(2)
  })
}, 60000)
