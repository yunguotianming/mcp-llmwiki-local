import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { createBuildModelClient } from '../src/host/models.js'
import { createExecutionLedger, pruneModelLogs, readVersionCosts } from '../src/layered/costs.js'
import { readProvenance, protocolDigest, writeProtocol } from '../src/layered/models.js'
import { safePath } from '../src/storage/paths.js'
import { readCurrent } from '../src/layered/publication.js'
import { cleanupLayeredFixtures, layeredFixture, layeredTopicFixture, snapshotManifest } from './layered-fixture.js'
import { candidateModel, hostExecution, stagePolicy } from './stage-policy-fixture.js'
import { parseRegistry } from '../src/domain/config.js'
import { identity, legacyFixture } from './b3-fixture.js'
import { readUpgradeStatus, upgradeLibrary } from '../src/layered/upgrade.js'
import { randomUUID } from 'node:crypto'
import { executeAccepted, recoverAccepted, taskIdFor, withRecovery } from '../src/layered/accepted.js'
import { preparePointLabels } from '../src/layered/point-labels.js'
import { pointLabelFixture, pointLabelInputBytes, pointLabelResponse } from './point-labels-fixture.js'
import { StagePolicyError } from '../src/domain/stage-policy.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

async function legacyIntegrated() {
  const f = await layeredFixture()
  f.library.wikiPath = f.root
  const policy = { ...f.policy, libraryFormat: '0.3.0' as const }
  const stream = vi.fn(f.runtime.stream.bind(f.runtime)), runtime = { ...f.runtime, stream }
  const client = createBuildModelClient(runtime, f.library, policy)
  await writeProtocol(f.root, '.llmwiki/policy.json', policy)
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '可核实的资料结论。')
  return { ...f, stream, runtime, client, policy,
    options: { ...f.options, client, recovery: client.recovery!, upgradeOptions: client.upgradeOptions } }
}

it('旧路由建库保留实际参数并记录接受与成本，目录离线续建零重复调用', async () => {
  const f = await legacyIntegrated(), result = await buildLayeredLibrary(f.options)
  const envelope = JSON.parse(await readFile(await safePath(f.root, `versions/${result.version}.json`), 'utf8'))
  const provenance = await readProvenance(f.root, result.version, envelope.checksum)
  const costs = await readVersionCosts(f.root, result.version, envelope.checksum)
  expect(costs.total.calls).toBe(f.stream.mock.calls.length)
  expect(Object.values(provenance.artifacts).filter(item => item.kind === 'extraction').every(item => item.status === 'recorded')).toBe(true)
  expect(Object.values(provenance.records).length).toBeGreaterThan(0)
  for (const record of Object.values(provenance.records)) {
    expect(record).toMatchObject({ provider: 'mock', requestedModel: 'extractor', reportedModel: null,
      parameters: { reasoningEffort: 'runtime-default', temperature: 'runtime-default', maxOutputTokens: 128 } })
  }
  for (const [request] of f.stream.mock.calls) {
    expect(request.maxTokens).toBe(128); expect(request).not.toHaveProperty('temperature'); expect(request).not.toHaveProperty('reasoningEffort')
  }
  f.stream.mockClear(); f.runtime.resolveModelInfo = vi.fn().mockRejectedValue(new Error('目录离线'))
  const client = createBuildModelClient(f.runtime, f.library, f.policy)
  expect(await buildLayeredLibrary({ ...f.options, client, recovery: client.recovery!, replayOnly: true })).toMatchObject({ unchanged: true, modelCalls: 0 })
  expect(f.stream).not.toHaveBeenCalled(); expect(f.runtime.resolveModelInfo).not.toHaveBeenCalled()
})

it('旧路由重试与备用不变，失败计费而最终生产者只关联成功响应', async () => {
  const f = await legacyIntegrated(), original = f.stream.getMockImplementation()!
  f.library.models.fallbacks = [{ provider: 'backup', model: '备用模型' }]
  f.library.models.providerProfiles.mock = { concurrency: 1, retryLimit: 1, backoffMs: 0, cacheMode: 'none' }
  f.runtime.responseMetadata = () => ({ reportedModel: '实际备用模型', requestId: '离线请求' })
  f.stream.mockImplementation(async function* (request) {
    if (request.provider === 'mock') yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: '连接故障', status: 503 } } }
    else yield* original(request)
  })
  const client = createBuildModelClient(f.runtime, f.library, f.policy)
  const result = await buildLayeredLibrary({ ...f.options, client, recovery: client.recovery! })
  expect(f.stream.mock.calls.slice(0, 3).map(([request]) => request.provider)).toEqual(['mock', 'mock', 'backup'])
  const envelope = JSON.parse(await readFile(await safePath(f.root, `versions/${result.version}.json`), 'utf8'))
  const costs = await readVersionCosts(f.root, result.version, envelope.checksum)
  const provenance = await readProvenance(f.root, result.version, envelope.checksum)
  expect(costs.total.calls).toBe(f.stream.mock.calls.length)
  expect(Object.values(provenance.records).every(record => record.provider === 'backup' && record.reportedModel === '实际备用模型')).toBe(true)
})

it.each(['onDispatch', 'afterAttempt'] as const)('旧路由账本 %s 落盘失败阻止接受，保留恢复现场', async hook => {
  const f = await legacyIntegrated()
  vi.spyOn(f.client.recovery!.hooks, hook).mockRejectedValue(Object.assign(new Error('账本落盘故障'), { code: 'ENOSPC' }))
  await expect(buildLayeredLibrary(f.options)).rejects.toMatchObject({ storageFailure: true })
  expect(f.stream).toHaveBeenCalledTimes(hook === 'onDispatch' ? 0 : 1)
  expect(await readCurrent(f.root)).toBeUndefined()
  const pending = JSON.parse(await readFile(await safePath(f.root, 'work/pending.json'), 'utf8'))
  expect(pending.acceptedProtocol).toBe(1)
})

it('旧路由耗尽调用预算保留暂停标记，禁止继续派发', async () => {
  const f = await legacyIntegrated()
  f.library.layered = { maxBuildCalls: 1 }
  const client = createBuildModelClient(f.runtime, f.library, f.policy)
  await expect(buildLayeredLibrary({ ...f.options, client, recovery: client.recovery! })).rejects.toMatchObject({ budgetPause: true })
  expect(f.stream).toHaveBeenCalledTimes(1)
  expect(await readCurrent(f.root)).toBeUndefined()
  const pending = JSON.parse(await readFile(await safePath(f.root, 'work/pending.json'), 'utf8'))
  expect(pending.stagePause.code).toBe('BUDGET_PAUSED')
})

async function integrated(topics = false) {
  const f = topics ? await layeredTopicFixture() : await layeredFixture()
  f.library.wikiPath = f.root
  const policy = { ...f.policy, libraryFormat: '0.3.0' as const, buildModels: stagePolicy() }
  const execution = hostExecution()
  delete execution.quotaGroups.account!.rpm
  delete execution.quotaGroups.account!.tpm
  const registry = parseRegistry({ readMaxChars: 12000, activeLibraryId: f.library.id, libraries: [f.library], modelExecution: execution })
  const resolver = vi.fn(async (_provider: string, model: string) => candidateModel(model))
  const respond = f.call.getMockImplementation()
  const stream = vi.fn(topics ? async function* (request) {
    const message = request.messages[0].content[0]
    yield { type: 'text-delta', index: 0, text: await respond!('ingest', request.system, message.text, request.signal, [], {}) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } : f.runtime.stream.bind(f.runtime))
  const runtime = { ...f.runtime, stream, resolveBuildModel: resolver }
  const client = createBuildModelClient(runtime, f.library, policy, registry)
  await writeProtocol(f.root, '.llmwiki/policy.json', policy)
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '资料说明可核实的研究方法与完整结论。')
  const options = { ...f.options, wikiPath: f.root, client, recovery: client.recovery!, upgradeOptions: client.upgradeOptions }
  return { ...f, policy, registry, runtime, client, options, resolver, stream }
}

it('新策略完整建库经过阶段解析、调度、接受和版本生产账本', async () => {
  const base = await integrated(), root = path.join(base.knowledgeRoot, '.llmwiki-text')
  const client = createBuildModelClient(base.runtime, { ...base.library, wikiPath: root }, base.policy, base.registry)
  const f = { ...base, root, options: { ...base.options, wikiPath: root, client, recovery: client.recovery!, upgradeOptions: client.upgradeOptions } }
  const result = await buildLayeredLibrary(f.options)
  expect(JSON.parse(await readFile(await safePath(f.root, '.llmwiki/policy.json'), 'utf8')).libraryFormat).toBe('0.3.0')
  const envelope = JSON.parse(await readFile(await safePath(f.root, `versions/${result.version}.json`), 'utf8'))
  const provenance = await readProvenance(f.root, result.version, envelope.checksum)
  const costs = await readVersionCosts(f.root, result.version, envelope.checksum)
  expect(f.stream).toHaveBeenCalled()
  expect(costs.total.calls).toBe(f.stream.mock.calls.length)
  expect(costs.groups.reduce((sum, group) => sum + group.totals.calls, 0)).toBe(costs.total.calls)
  const extraction = Object.values(provenance.artifacts).find(item => item.kind === 'extraction')!
  expect(extraction.status).toBe('recorded')
  expect(extraction.productionIds.length).toBeGreaterThan(0)
  for (const id of extraction.productionIds) {
    const record = provenance.records[id]!
    expect(protocolDigest(record)).toBe(id)
    expect(record.provider).toBe('offline')
  }
  expect(await readCurrent(f.root)).toMatchObject({ version: result.version })
})

it('AC-21 换模型续建先恢复接受成果，离线目录下零重复调用', async () => {
  const f = await integrated()
  await buildLayeredLibrary(f.options)
  const before = await snapshotManifest(f.root)
  const bytes = await readFile(await safePath(f.root, before.sources[0]!.extract.path))
  const policy = structuredClone(f.policy)
  policy.buildModels.stages.extract.candidates = [{ line: 'terra', model: 'terra', parameters: { reasoningEffort: 'high' } }]
  f.stream.mockClear(); f.resolver.mockClear(); f.resolver.mockRejectedValue(new Error('模型目录离线'))
  const client = createBuildModelClient(f.runtime, f.library, policy, f.registry)
  const result = await buildLayeredLibrary({ ...f.options, client, recovery: client.recovery!, replayOnly: true })
  expect(result).toMatchObject({ unchanged: true, modelCalls: 0 })
  expect(f.stream).not.toHaveBeenCalled(); expect(f.resolver).not.toHaveBeenCalled()
  expect(await readFile(await safePath(f.root, before.sources[0]!.extract.path))).toEqual(bytes)
})

it('AC-31 升级上限进入预检、实际尝试预占和续跑累计预算', async () => {
  const f = await integrated(), old = await legacyFixture()
  const source = old.manifest.sources[0]!
  const file = await safePath(old.root, source.extract.path)
  const extraction = JSON.parse(await readFile(file, 'utf8'))
  extraction.segments = [{ locator: 'L1-L1', text_hash: source.content_hash, start: 0, end: 20, resource_hashes: [], processing_fingerprint: source.content_hash,
    terms: [], points: [{ point_id: 'S-0001:P1', text_hash: source.content_hash, source_version: source.source_version, locator: 'L1-L1',
      text: 'S-0001 的已发布证据。', section: '主要发现', evidence: [{ source_id: source.source_id, source_version: source.source_version, locator: 'L1-L1', quote: 'S-0001 的已发布证据。' }] }] }]
  await writeFile(file, JSON.stringify(extraction))
  f.library.wikiPath = old.root
  f.library.models.providerProfiles.offline = { concurrency: 3, retryLimit: 2, backoffMs: 0, cacheMode: 'none' }
  const original = f.stream.getMockImplementation()!
  const clientFor = (maxCalls: number, maxTokens?: number) => createBuildModelClient(f.runtime, f.library, f.policy,
    { ...f.registry, upgrade: { maxCalls, ...(maxTokens === undefined ? {} : { maxTokens }) } })
  expect(await upgradeLibrary(old.root, clientFor(0).upgradeOptions)).toMatchObject({ status: 'paused', actual: { calls: 0 } })
  expect(f.stream).not.toHaveBeenCalled()
  f.stream.mockImplementation(async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: '连接超时', status: 503 } } } })
  await expect(upgradeLibrary(old.root, clientFor(1).upgradeOptions)).rejects.toMatchObject({ budgetPause: true })
  expect(f.stream).toHaveBeenCalledTimes(1)
  expect(await readUpgradeStatus(old.root)).toMatchObject({ status: 'paused', actual: { calls: 1 } })
  await upgradeLibrary(old.root, clientFor(1).upgradeOptions)
  expect(f.stream).toHaveBeenCalledTimes(1)
  expect(await upgradeLibrary(old.root, clientFor(3, 0).upgradeOptions)).toMatchObject({ status: 'paused', actual: { calls: 1 } })
  expect(f.stream).toHaveBeenCalledTimes(1)
  f.stream.mockImplementation(original)
  expect(await upgradeLibrary(old.root, clientFor(3).upgradeOptions)).toMatchObject({ status: 'complete', actual: { calls: 2 } })
  expect(await readFile(file, 'utf8')).toBe(JSON.stringify(extraction))
}, 20000)

it('AC-23 跨库候选派发同时遵守宿主、库、线路和共享额度组上限', async () => {
  const f = await integrated()
  const host = hostExecution(); host.globalMaxInFlight = 3
  host.quotaGroups.account = { maxConcurrency: 2 }
  for (const binding of Object.values(host.lineBindings)) binding.maxConcurrency = 1
  const policy = { ...f.policy, pageGenerationConcurrency: 2, concurrencyLimit: 1 }
  let active = 0, peak = 0
  const lines = new Map<string, number>(), peaks = new Map<string, number>()
  const libraries = new Map<number, number>(), libraryPeaks = new Map<number, number>()
  f.stream.mockImplementation(async function* (request) {
    const library = Number(request.messages[0].content[0].text)
    libraries.set(library, (libraries.get(library) ?? 0) + 1); libraryPeaks.set(library, Math.max(libraryPeaks.get(library) ?? 0, libraries.get(library)!))
    active++; peak = Math.max(peak, active)
    lines.set(request.model, (lines.get(request.model) ?? 0) + 1); peaks.set(request.model, Math.max(peaks.get(request.model) ?? 0, lines.get(request.model)!))
    try { await new Promise(resolve => setTimeout(resolve, 20)); yield { type: 'text-delta', index: 0, text: '完成' }; yield { type: 'finish', reason: { kind: 'stop' } } }
    finally { active--; lines.set(request.model, lines.get(request.model)! - 1); libraries.set(library, libraries.get(library)! - 1) }
  })
  const clients = [f.library, { ...f.library, id: '另一库' }].map(library => createBuildModelClient(f.runtime, library, policy, { ...f.registry, modelExecution: host }))
  const runs = clients.map(() => randomUUID())
  await Promise.all(Array.from({ length: 8 }, async (_, index) => {
    const client = clients[index % 2]!, runId = runs[index % 2]!, task = identity('额度-' + index)
    await client.recovery!.startRun!(runId)
    const execution = await client.recovery!.resolveExecution(task, runId, '额度-' + index)
    await client.callDetailed('ingest', '规则', String(index % 2), undefined, [], { execution })
  }))
  expect(f.stream).toHaveBeenCalledTimes(8)
  expect(peak).toBe(2)
  expect([...peaks.values()].every(value => value <= 1)).toBe(true)
  expect([...libraryPeaks.values()]).toEqual([1, 1])
  expect(peak).toBeLessThanOrEqual(host.globalMaxInFlight)
  expect(active).toBe(0)
})

it('重建账本及归档明细后沿用重试次数、逐线次数、截止时间与尝试序号', async () => {
  const f = await integrated(), runId = randomUUID(), task = identity('重试持久化')
  const execution = await f.client.recovery!.resolveExecution(task, runId, '重试域')
  let calls = 0
  f.stream.mockImplementation(async function* () {
    yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } }
    yield { type: 'text-delta', index: 0, text: '完成' }
    yield ++calls === 1
      ? { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: '连接超时', status: 503 } } }
      : { type: 'finish', reason: { kind: 'stop' } }
  })
  f.library.models.providerProfiles.offline = { concurrency: 3, retryLimit: 2, backoffMs: 0, cacheMode: 'none' }
  const result = await f.client.callDetailed('ingest', '规则', '输入', undefined, [], { execution })
  expect(result.attempts).toHaveLength(2)
  const before = await createExecutionLedger(f.root).openScope(runId, '重试域', Date.now(), execution.retry)
  await pruneModelLogs(f.root, Date.now() + 1000)
  const ledger = createExecutionLedger(f.root)
  expect(await ledger.openScope(runId, '重试域', Date.now() + 10000, execution.retry)).toEqual(before)
  const perLine = result.attempts.reduce<Record<string, number>>((counts, attempt) => {
    counts[attempt.candidate.lineId] = (counts[attempt.candidate.lineId] ?? 0) + 1; return counts
  }, {})
  expect(before).toMatchObject({ attempts: 2, attemptsPerLine: perLine, visitedLines: [...new Set(result.attempts.map(attempt => attempt.candidate.lineId))] })
  expect(await ledger.allocateAttempt(runId)).toMatchObject({ sequence: 3 })
})

it('真实准备账本落盘后中断，从准备快照恢复接受且不再派发', async () => {
  const f = await integrated(), task = identity('准备恢复')
  f.stream.mockImplementation(async function* () { yield { type: 'text-delta', index: 0, text: '已核验' }; yield { type: 'finish', reason: { kind: 'stop' } } })
  task.scope.libraryId = f.library.id
  const pending = {} as import('../src/layered/accepted.js').RecoveryPending
  const hooks = f.client.recovery!.hooks, prepare = hooks.prepareAccepted.bind(hooks)
  const failure = Object.assign(new Error('准备后中断'), { storageFailure: true })
  const spy = vi.spyOn(hooks, 'prepareAccepted').mockImplementation(async request => { await prepare(request); throw failure })
  const valid = (value: unknown): value is string => typeof value === 'string' && value.length > 0
  await expect(withRecovery(f.root, pending, f.options, async options => executeAccepted(task,
    () => options.client.call('ingest', '规则', '输入'), valid))).rejects.toBe(failure)
  spy.mockRestore()
  const count = f.stream.mock.calls.length
  const recovered = await withRecovery(f.root, pending, { ...f.options, replayOnly: true }, () => recoverAccepted(task, valid))
  expect(recovered?.acceptedRef?.taskId).toBe(taskIdFor(task))
  expect(await hooks.readAcceptance(taskIdFor(task))).toMatchObject({ status: 'bound' })
  expect(f.stream).toHaveBeenCalledTimes(count)
})

it('补标按批次接受，中断续跑保留成功批次及其实际生产者', async () => {
  const f = await integrated(), labels = await pointLabelFixture(3)
  const budget = pointLabelInputBytes(labels.source.source_id, labels.points.slice(0, 1))
  const pending = labels.pending
  pending.manifest.sources[0]!.extract.path = labels.source.extract.path
  f.library.wikiPath = labels.root
  const client = createBuildModelClient(f.runtime, f.library, { ...f.policy, pageGenerationConcurrency: 1 }, f.registry)
  let responses = 0
  f.stream.mockImplementation(async function* (request) {
    if (++responses === 2) throw new StagePolicyError('CONTEXT_LIMIT', 'extract', 0, 'flash', '合成暂停')
    yield { type: 'text-delta', index: 0, text: pointLabelResponse(JSON.parse(request.messages[0].content[0].text)) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const options = { ...labels.options, client, recovery: client.recovery!, topics: { extractMaxInputBytes: budget }, maxInputBytes: budget }
  await expect(withRecovery(labels.root, pending, options, options => preparePointLabels(labels.root, pending, options))).rejects.toMatchObject({ stagePause: true })
  expect(Object.keys(pending.manifest.point_labels!)).toHaveLength(1)
  const accepted = Object.values(pending.manifest.point_labels!)[0]!.acceptedRef
  f.stream.mockImplementation(async function* (request) {
    yield { type: 'text-delta', index: 0, text: pointLabelResponse(JSON.parse(request.messages[0].content[0].text)) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const calls = f.stream.mock.calls.length
  await withRecovery(labels.root, pending, options, options => preparePointLabels(labels.root, pending, options))
  expect(f.stream.mock.calls.length - calls).toBe(2)
  expect(Object.keys(pending.manifest.point_labels!)).toHaveLength(3)
  expect(Object.values(pending.manifest.point_labels!)[0]!.acceptedRef).toEqual(accepted)
})

it('主题核对和补标归并的生产引用随版本保存，阶段与角色一致', async () => {
  const f = await integrated(true)
  const result = await buildLayeredLibrary({ ...f.options, topics: { ...f.options.topics || {}, pointLabelsOnBuild: true } })
  const envelope = JSON.parse(await readFile(await safePath(f.root, `versions/${result.version}.json`), 'utf8'))
  const provenance = await readProvenance(f.root, result.version, envelope.checksum)
  const records = Object.values(provenance.records)
  expect(records.some(record => record.stage === 'topic' && record.role === 'generate')).toBe(true)
  expect(records.some(record => record.stage === 'topicReview' && record.role === 'review')).toBe(true)
  expect(records.some(record => record.operation === 'pointLabels')).toBe(true)
  expect(records.some(record => record.operation === 'tagMerge')).toBe(true)
  for (const artifact of Object.values(provenance.artifacts).filter(item => item.status === 'recorded')) {
    expect(artifact.productionIds.length).toBeGreaterThan(0)
    expect(artifact.productionIds.every(id => provenance.records[id])).toBe(true)
  }
})
