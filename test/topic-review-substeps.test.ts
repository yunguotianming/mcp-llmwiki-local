import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createBuildModelClient } from '../src/host/models.js'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { defaultPolicy } from '../src/domain/policy.js'
import { hash, writeJson } from '../src/layered/files.js'
import { putPage } from '../src/layered/objects.js'
import { storageJson } from '../src/layered/vectors.js'
import { createExecutionLedger, readRunCosts, usageTokens } from '../src/layered/costs.js'
import { readUpgradeStatus, upgradeLibrary } from '../src/layered/upgrade.js'
import { reviewTopicContent, topicReviewRequests } from '../src/layered/topic-review.js'
import { withRecovery } from '../src/layered/accepted.js'
import type { RecoveryPending } from '../src/layered/accepted.js'
import type { AcceptedRecord, BuildLayeredOptions, Extraction, Point } from '../src/layered/schema.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { legacyFixture } from './b3-fixture.js'

beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('子步骤恢复测试禁止网络') })))
afterEach(() => vi.unstubAllGlobals())

async function snapshot(root: string, files?: string[]) {
  const names = files ?? (await readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
    .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)))
  return Object.fromEntries(await Promise.all(names.sort().map(async file => [file, hash(await readFile(path.join(root, file)))])))
}

async function fixture() {
  const f = await legacyFixture('0.2.1'), source = f.manifest.sources[0]!
  const text = await readFile(path.join(f.root, source.files.source), 'utf8')
  const segment = { locator: 'L1-L1', start: 0, end: text.length, text_hash: hash(text) }
  source.segments = [segment]
  const point: Point = { point_id: source.source_id + ':P1', text: '护理证据' + '成员条件'.repeat(500), text_hash: segment.text_hash, section: '主要发现',
    locator: 'L1-L1', source_version: source.source_version,
    evidence: [{ source_id: source.source_id, source_version: source.source_version, locator: 'L1-L1', quote: text }],
    verification: { status: 'verified', missing: '', fingerprint: '历史已核对' } }
  const extraction: Extraction = { format_version: 1, source_id: source.source_id, source_hash: source.content_hash, processing: source.extract.processing,
    metadata: source.metadata, calls: [], segments: [{ ...segment, resource_hashes: [], processing_fingerprint: hash(text), points: [point], terms: [] }] }
  await writeJson(f.root, source.extract.path, extraction)
  const content = Array.from({ length: 12 }, (_, i) => `观察${i + 1}在` + '明确限定条件'.repeat(30) + '下成立。').join('\n\n')
  const contexts = new Map([[source.source_id, { title: source.metadata.title, source_version: source.source_version, text, segments: [segment] }]])
  const library = newLibrary('主题子步骤夹具'), policy = defaultPolicy(), registry = emptyRegistry()
  library.wikiPath = f.root; library.sourceRoots = [f.parent]; library.models.unified = { provider: 'offline', model: 'review' }
  library.models.layeredRoutes = {}; library.models.fallbacks = []
  library.models.providerProfiles.offline = { concurrency: 1, retryLimit: 0, backoffMs: 0, cacheMode: 'none' }
  policy.batchDelayMs = 0; policy.pageGenerationConcurrency = 1; policy.maxTokensPerCall = 512
  const calls: { key: string; stage: string; ids: string[] }[] = []
  let fault: 'missing' | 'merge-missing' | 'transport' | undefined
  const runtime: ModelRuntime = {
    resolveModelInfo: vi.fn(async (provider, id) => ({ provider, id, name: id, context: { contextWindow: 131072 } })),
    stream: vi.fn(async function* (request) {
      const part = request.messages[0]!.content[0]!
      if (part.type !== 'text') throw new Error('只允许离线文本')
      const data = JSON.parse(part.text), ids = data.sentences.map((item: { id: string }) => item.id)
      calls.push({ key: hash(part.text), stage: data.review_stage, ids })
      yield { type: 'usage' as const, usage: { inputTokens: 11, outputTokens: 5 } }
      const currentFault = fault === 'merge-missing' && data.review_stage !== 'topic-merge' ? undefined : fault
      if (currentFault) fault = undefined
      if (currentFault === 'transport') {
        yield { type: 'finish' as const, reason: { kind: 'error' as const, failure: { code: 'EIO', message: '离线读取响应失败' } } }; return
      }
      const items = data.sentences.map((item: { id: string }) => ({ id: item.id, support: '完整支撑', missing: null,
        ...(data.review_stage === 'topic-block' ? { findings: '该句有原文支持。', point_ids: data.members.map((member: { point_id: string }) => member.point_id) } : {}) }))
      if (currentFault === 'missing' || currentFault === 'merge-missing') items.pop()
      yield { type: 'text-delta' as const, index: 0, text: JSON.stringify({ items }) }
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
    }),
  }
  const previewClient = createBuildModelClient(runtime, library, policy, registry)
  let limit = 0
  for (let candidate = 6500; candidate <= 40000; candidate += 100) {
    try {
      const requests = topicReviewRequests('T-1', content, [point], { knowledgeRoot: f.parent, client: previewClient, topics: { topicReview: true } }, candidate, contexts)
      if (requests.length === 3 && requests.every(request => JSON.parse(request.input).members.length === 1)) { limit = candidate; break }
    } catch { /* 单个完整请求尚不能进入该候选窗口，继续寻找三块边界。 */ }
  }
  expect(limit).toBeGreaterThan(0)
  library.layered = { embeddingMode: 'none', topicReview: true, topicReviewInputBudget: limit }
  f.manifest.pages!['topics/T-1.md'] = await putPage(f.root, content)
  f.manifest.deps!.pages['topics/T-1.md'] = { sources: [source.source_id], points: [{ point_id: point.point_id, text_hash: point.text_hash }] }
  await writeJson(f.root, 'versions/v000001.json', { manifest: f.manifest, checksum: hash(storageJson(f.manifest)) })
  const client = (maxCalls?: number) => createBuildModelClient(runtime, library, policy, { ...registry, upgrade: maxCalls === undefined ? {} : { maxCalls } })
  const options = (): BuildLayeredOptions => ({ knowledgeRoot: f.parent, wikiPath: f.root, client: client(), topics: library.layered })
  const old = await snapshot(f.root)
  return { ...f, calls, runtime, client, content, point, contexts, options, old, setFault(value: typeof fault) { fault = value } }
}

it('单主题三块三合并第六次预算拒绝后，预检只读扣除已接受块且续跑只补最后请求', async () => {
  const f = await fixture()
  await expect(upgradeLibrary(f.root, f.client(5).upgradeOptions)).rejects.toMatchObject({ budgetPause: true })
  const paused = (await readUpgradeStatus(f.root))!, before = await readRunCosts(f.root, paused.id)
  expect(paused).toMatchObject({ status: 'paused', actual: { calls: 5 } })
  expect(f.calls.filter(call => call.stage === 'topic-block')).toHaveLength(3)
  expect(f.calls.filter(call => call.stage === 'topic-merge')).toHaveLength(2)
  expect(usageTokens(before.total.usage)).toBe(80)
  const accepted = await snapshot(path.join(f.root, 'work/accepted/tasks')), backup = await snapshot(paused.backupPath)
  expect(Object.keys(accepted)).toHaveLength(5)
  await expect(readFile(path.join(f.root, 'work/pending.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  const preflightBefore = await snapshot(f.root)
  expect((await f.client(6).upgradeOptions!.estimateReview!(paused.steps[0]!, f.root)).calls).toBe(0)
  expect(await snapshot(f.root)).toEqual(preflightBefore)
  expect(f.calls).toHaveLength(5)
  const done = (await upgradeLibrary(f.root, f.client(6).upgradeOptions))!, costs = await readRunCosts(f.root, done.id)
  expect(done).toMatchObject({ id: paused.id, backupPath: paused.backupPath, status: 'complete', actual: { calls: 6 } })
  expect(f.calls).toHaveLength(6); expect(new Set(f.calls.map(call => call.key)).size).toBe(6)
  expect(costs.total.calls).toBe(6); expect(usageTokens(costs.total.usage)).toBe(96)
  expect(await snapshot(path.join(f.root, 'work/accepted/tasks'), Object.keys(accepted))).toEqual(accepted)
  expect(await snapshot(paused.backupPath)).toEqual(backup)
  expect(await snapshot(f.root, Object.keys(f.old).filter(file => file.replaceAll('\\', '/') !== '.llmwiki/policy.json')))
    .toEqual(Object.fromEntries(Object.entries(f.old).filter(([file]) => file.replaceAll('\\', '/') !== '.llmwiki/policy.json')))
  const outer = JSON.parse(await readFile(path.join(f.root, Object.values(done.accepted)[0]!.path), 'utf8')) as AcceptedRecord
  expect(Object.keys(outer.productions)).toHaveLength(6)
  const records = await Promise.all(Object.keys(await snapshot(path.join(f.root, 'work/accepted/tasks')))
    .map(async file => JSON.parse(await readFile(path.join(f.root, 'work/accepted/tasks', file), 'utf8')) as AcceptedRecord))
  const merges = records.filter(record => record.identity.groupPlanDigest && record.identity.scope.unitId.includes(':review-call:') && record.dependencies.length)
  expect(merges).toHaveLength(3)
  for (const merge of merges) expect(merge.dependencies).toHaveLength(1)
  expect((await createExecutionLedger(f.root).readAcceptance(outer.taskId)).status).toBe('bound')
}, 60000)

it.each(['missing', 'merge-missing', 'transport'] as const)('%s 子步骤不冒充完成，续跑只复用有效接受结果且失败成本保留', async fault => {
  const f = await fixture(); f.setFault(fault)
  await expect(upgradeLibrary(f.root, f.client().upgradeOptions)).rejects.toThrow()
  const paused = (await readUpgradeStatus(f.root))!, prior = f.calls.length, badKey = f.calls[fault === 'merge-missing' ? 1 : 0]!.key
  const accepted = await snapshot(path.join(f.root, 'work/accepted/tasks')).catch(() => ({}))
  const done = (await upgradeLibrary(f.root, f.client().upgradeOptions))!, costs = await readRunCosts(f.root, done.id)
  expect(done.status).toBe('complete'); expect(f.calls.filter(call => call.key === badKey)).toHaveLength(2)
  expect(f.calls.length - prior).toBe(fault === 'missing' ? 2 : fault === 'merge-missing' ? 1 : 6)
  expect(costs.total.calls).toBe(f.calls.length); expect(usageTokens(costs.total.usage)).toBe(f.calls.length * 16)
  expect(await snapshot(path.join(f.root, 'work/accepted/tasks'), Object.keys(accepted))).toEqual(accepted)
}, 60000)

it('同输入子步骤零重调，正文、来源版本或邻文上下文变化均不误复用', async () => {
  const f = await fixture(), pending = {} as RecoveryPending
  const run = async (content = f.content, point = f.point, contexts = f.contexts) => {
    const options = f.options(), client = options.client as ReturnType<typeof f.client>
    return withRecovery(f.root, pending, { ...options, recovery: client.recovery, automaticRecovery: true },
      active => reviewTopicContent('T-1', content, [point], active, undefined, false, contexts), false)
  }
  expect((await run()).failure).toBeUndefined(); expect(f.calls).toHaveLength(6)
  await expect(readFile(path.join(f.root, 'work/pending.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  const options = f.options(), client = options.client as ReturnType<typeof f.client>
  const persisted = { manifest: f.manifest } as RecoveryPending
  expect((await withRecovery(f.root, persisted, { ...options, recovery: client.recovery },
    active => reviewTopicContent('T-1', f.content, [f.point], active, undefined, false, f.contexts))).failure).toBeUndefined()
  const saved = JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8')) as RecoveryPending
  expect(saved).toMatchObject({ acceptedProtocol: 1, manifest: f.manifest, runId: persisted.runId })
  expect(Object.keys(saved.acceptedRefs ?? {})).toHaveLength(6); expect(f.calls).toHaveLength(6)
  expect((await run()).calls).toBe(0); expect(f.calls).toHaveLength(6)
  expect((await run(f.content.replace('观察1', '重新观察1'))).failure).toBeUndefined(); expect(f.calls).toHaveLength(12)
  const changed = structuredClone(f.point); changed.source_version = hash('新版'); changed.evidence[0]!.source_version = changed.source_version
  const versions = structuredClone(f.contexts); versions.get('S-0001')!.source_version = changed.source_version
  expect((await run(f.content, changed, versions)).failure).toBeUndefined(); expect(f.calls).toHaveLength(18)
  const contexts = structuredClone(f.contexts), context = contexts.get('S-0001')!
  context.text += '同一原段补充了邻文限定条件。'; context.segments[0]!.end = context.text.length
  expect((await run(f.content, f.point, contexts)).failure).toBeUndefined(); expect(f.calls).toHaveLength(24)
}, 60000)
