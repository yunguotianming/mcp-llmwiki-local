import { readFile } from 'node:fs/promises'
import { beforeEach, afterEach, expect, it, vi } from 'vitest'
import { createBuildModelClient } from '../src/host/models.js'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { defaultPolicy } from '../src/domain/policy.js'
import { atomicWrite, hash, writeJson } from '../src/layered/files.js'
import { storageJson } from '../src/layered/vectors.js'
import { putPage } from '../src/layered/objects.js'
import { readUpgradeStatus, upgradeLibrary } from '../src/layered/upgrade.js'
import { topicReviewRequests } from '../src/layered/topic-review.js'
import type { Extraction, SourceEntry } from '../src/layered/schema.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { legacyFixture } from './b3-fixture.js'
import { candidateModel, hostExecution, stagePolicy } from './stage-policy-fixture.js'

beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('离线升级回归禁止网络') })))
afterEach(() => vi.unstubAllGlobals())

async function fixture(count: number, points = 1, claimSize = 0) {
  const f = await legacyFixture(), template = f.manifest.sources[0]!, units: { extraction: Extraction; entry: SourceEntry }[] = []
  for (let index = 0; index < count; index++) {
    const id = `S-${String(index + 1).padStart(4, '0')}`, text = `${id} 的研究结果改善。`, digest = hash(text)
    const segment = { locator: 'L1-L1', start: 0, end: text.length, text_hash: digest }
    const entry: SourceEntry = { ...structuredClone(template), source_id: id, content_hash: digest, source_version: digest, segments: [segment],
      files: { source: `objects/estimate/${id}.md`, assets: [] }, extract: { ...template.extract, path: `objects/estimate/${id}.json` } }
    const extraction: Extraction = { format_version: 1, source_id: id, source_hash: digest, processing: entry.extract.processing, metadata: entry.metadata, calls: [],
      segments: [{ ...segment, resource_hashes: [], processing_fingerprint: digest, terms: [], points: Array.from({ length: points }, (_, number) => ({
        point_id: `${id}:P${number + 1}`, text: `结果改善${number + 1}。` + '研究条件'.repeat(claimSize), section: '主要发现' as const, text_hash: digest,
        locator: 'L1-L1', source_version: digest, evidence: [{ source_id: id, source_version: digest, locator: 'L1-L1', quote: text }],
      })) }] }
    await atomicWrite(f.root, entry.files.source, text); await writeJson(f.root, entry.extract.path, extraction)
    units.push({ extraction, entry })
  }
  f.manifest.sources = units.map(unit => unit.entry)
  f.manifest.pages = { 'index.md': f.manifest.pages!['index.md']! }
  f.manifest.deps = { pages: { 'index.md': { sources: [], points: [] } }, reverse: {}, reverse_sources: {} }
  const save = () => writeJson(f.root, 'versions/v000001.json', { manifest: f.manifest, checksum: hash(storageJson(f.manifest)) })
  await save()
  return { ...f, units, save }
}

function models(f: Awaited<ReturnType<typeof fixture>>, mode: 'new' | 'legacy', output: number, context = 131072) {
  const library = newLibrary('夹具库'), policy = defaultPolicy(), registry = emptyRegistry()
  library.wikiPath = f.root; library.sourceRoots = [f.parent]; library.models.unified = { provider: 'offline', model: 'terra' }
  library.models.layeredRoutes = {}; library.layered = {}
  library.models.fallbacks = []; library.models.providerProfiles.offline = { concurrency: 1, retryLimit: 1, backoffMs: 0, cacheMode: 'none' }
  policy.batchDelayMs = 0; policy.pageGenerationConcurrency = 1; policy.maxTokensPerCall = output
  if (mode === 'new') {
    policy.buildModels = stagePolicy(); registry.modelExecution = hostExecution()
    // 夹具允许同一接受任务包含多包，避免用重试上限截断正常初轮。
    policy.buildModels.retry.maxAttempts = 64; policy.buildModels.retry.maxAttemptsPerLine = 64
  }
  const received: { system: string; input: string }[] = []
  const stream = vi.fn(async function* (request: Parameters<ModelRuntime['stream']>[0]) {
    const message = request.messages[0]!.content[0]!
    if (message.type !== 'text') throw new Error('只允许离线文本夹具')
    received.push({ system: request.system ?? '', input: message.text })
    const data = JSON.parse(message.text)
    const items = (data.points ?? data.sentences).map((item: { id: string }) => ({ id: item.id, support: '完整支撑', missing: null,
      ...(data.review_stage === 'topic-block' ? { findings: '成员证据支持原句。', point_ids: data.members.map((member: { point_id: string }) => member.point_id) } : {}) }))
    yield { type: 'text-delta' as const, index: 0, text: JSON.stringify({ items }) }
    yield { type: 'usage' as const, usage: { inputTokens: 11, outputTokens: 5 } }
    yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
  })
  const resolveBuildModel = vi.fn(async () => { const model = candidateModel(); model.defaults.maxOutputTokens = output; model.capabilities.contextWindowTokens = context; return model })
  const runtime: ModelRuntime = { resolveBuildModel, resolveModelInfo: vi.fn(async (provider, id) => ({ provider, id, name: id, context: { contextWindow: context }, defaultMaxTokens: 999 })), stream }
  const clientFor = (limits: { maxCalls?: number; maxTokens?: number }) => createBuildModelClient(runtime, library, policy, { ...registry, upgrade: limits })
  return { library, policy, runtime, stream, received, clientFor, resolveBuildModel }
}

it('68 个待核对象保持 4 个接受步骤，按 68 个真实初轮包及新阶段输出额度估算', async () => {
  const f = await fixture(68), m = models(f, 'new', 7001), client = m.clientFor({ maxCalls: 67 })
  const before = await readFile(`${f.root}/objects/estimate/S-0001.json`)
  const status = (await upgradeLibrary(f.root, client.upgradeOptions))!
  expect(status.status).toBe('paused'); expect(status.steps.map(step => step.unitIds.length)).toEqual([20, 20, 20, 8])
  expect(status.estimate).toMatchObject({ calls: 68, outputTokens: 68 * 7001 })
  expect(status.estimate.inputTokens).toBeGreaterThan(68 * 1000)
  expect(status.actual.calls).toBe(0); expect(m.stream).not.toHaveBeenCalled(); expect(m.resolveBuildModel).toHaveBeenCalledTimes(1)
  expect(await readFile(`${f.root}/objects/estimate/S-0001.json`)).toEqual(before)
  expect(await readFile(`${f.root}/logs/build.md`, 'utf8')).toContain('不含依赖输出的合并、纠正和重试')
}, 60000)

it('legacy 使用真实请求的四字节估算和策略输出额度，失败与续跑仍累计实际尝试', async () => {
  const f = await fixture(1), m = models(f, 'legacy', 1769)
  const paused = (await upgradeLibrary(f.root, m.clientFor({ maxCalls: 0 }).upgradeOptions))!
  expect(paused.estimate).toMatchObject({ calls: 1, outputTokens: 1769 }); expect(m.stream).not.toHaveBeenCalled()
  const original = m.stream.getMockImplementation()!
  m.stream.mockImplementationOnce(async function* () { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'SERVER', message: '离线模拟失败', status: 503 } } } })
  await expect(upgradeLibrary(f.root, m.clientFor({ maxCalls: 1 }).upgradeOptions)).rejects.toMatchObject({ budgetPause: true })
  expect((await readUpgradeStatus(f.root))!.actual.calls).toBe(1)
  expect((await upgradeLibrary(f.root, m.clientFor({ maxCalls: 1 }).upgradeOptions))!.status).toBe('paused')
  expect(m.stream).toHaveBeenCalledTimes(1)
  m.stream.mockImplementation(original)
  const done = (await upgradeLibrary(f.root, m.clientFor({ maxCalls: 2 }).upgradeOptions))!
  expect(done).toMatchObject({ id: paused.id, backupPath: paused.backupPath, status: 'complete', actual: { calls: 2 } })
  expect(paused.estimate.inputTokens).toBe(Math.ceil(Buffer.byteLength(m.received[0]!.system + m.received[0]!.input) / 4))
  await upgradeLibrary(f.root, m.clientFor({ maxCalls: 2 }).upgradeOptions)
  expect(m.stream).toHaveBeenCalledTimes(2)
}, 60000)

it('提取初轮确定分块按实际包计数，输入与输出估算逐包匹配真实派发', async () => {
  const f = await fixture(1, 14, 70), m = models(f, 'new', 512, 9000)
  const paused = (await upgradeLibrary(f.root, m.clientFor({ maxCalls: 0 }).upgradeOptions))!
  expect(paused.steps).toHaveLength(1); expect(paused.estimate.calls).toBeGreaterThan(1)
  const done = (await upgradeLibrary(f.root, m.clientFor({ maxCalls: paused.estimate.calls }).upgradeOptions))!
  expect(done.status).toBe('complete'); expect(done.actual.calls).toBe(paused.estimate.calls)
  expect(paused.estimate.inputTokens).toBe(m.received.reduce((sum, request) => sum + Buffer.byteLength(request.system + request.input), 0))
  expect(paused.estimate.outputTokens).toBe(m.received.length * 512)
}, 60000)

it('主题初轮二维分块使用同一制包，依赖报告的合并只进入实际账本', async () => {
  const f = await fixture(1, 18, 65), m = models(f, 'new', 512)
  const unit = f.units[0]!, points = unit.extraction.segments[0]!.points
  for (const point of points) point.verification = { status: 'verified', missing: '', fingerprint: '历史核对' }
  await writeJson(f.root, unit.entry.extract.path, unit.extraction)
  const content = '# 研究结果\n\n研究结果改善。\n', contexts = new Map([[unit.entry.source_id, { title: unit.entry.metadata.title, source_version: unit.entry.source_version,
    text: await readFile(`${f.root}/${unit.entry.files.source}`, 'utf8'), segments: unit.entry.segments }]])
  const previewClient = m.clientFor({}), options = { knowledgeRoot: f.parent, client: previewClient, topics: { topicReview: true } }
  const full = topicReviewRequests('T-1', content, points, options, 100000, contexts)[0]!
  const limit = Buffer.byteLength(full.system + full.input) - 3000
  m.library.layered.topicReviewInputBudget = limit
  const page = 'topics/T-1.md'; f.manifest.pages![page] = await putPage(f.root, content)
  f.manifest.deps!.pages[page] = { sources: [unit.entry.source_id], points: points.map(point => ({ point_id: point.point_id, text_hash: point.text_hash })) }
  await f.save()
  const paused = (await upgradeLibrary(f.root, m.clientFor({ maxCalls: 0 }).upgradeOptions))!
  const requests = topicReviewRequests('T-1', content, points, options, limit, contexts)
  expect(requests.length).toBeGreaterThan(1); expect(paused.estimate.calls).toBe(requests.length)
  expect(m.stream).not.toHaveBeenCalled()
  const done = (await upgradeLibrary(f.root, m.clientFor({}).upgradeOptions))!
  const blocks = m.received.filter(request => JSON.parse(request.input).review_stage === 'topic-block')
  expect(blocks).toEqual(requests.map(({ system, input }) => ({ system, input }))); expect(paused.estimate.inputTokens).toBe(blocks.reduce((sum, request) => sum + Buffer.byteLength(request.system + request.input), 0))
  expect(done.status).toBe('complete'); expect(done.actual.calls).toBeGreaterThan(paused.estimate.calls)
}, 60000)

it('无待核内容为零请求，手工非 review 步骤按声明额度保留一次或零次语义', async () => {
  const empty = await legacyFixture(), m = models({ ...empty, units: [], save: async () => {} }, 'new', 7001)
  const done = (await upgradeLibrary(empty.root, m.clientFor({}).upgradeOptions))!
  expect(done.estimate).toEqual({ calls: 0, inputTokens: 0, outputTokens: 0 }); expect(m.resolveBuildModel).not.toHaveBeenCalled()
  const f = await legacyFixture(), runStep = vi.fn()
  const paused = (await upgradeLibrary(f.root, { upgrade: { maxCalls: 0 }, runStep, steps: [
    { id: '手工摘要', kind: 'summary', stage: 'extract', unitIds: ['一', '二', '三'], inputDigest: hash('摘要'), estimatedInputTokens: 100, maxOutputTokens: 20 },
    { id: '本地元数据', kind: 'metadata', stage: 'extract', unitIds: ['一', '二'], inputDigest: hash('本地'), estimatedInputTokens: 0, maxOutputTokens: 0 },
  ] }))!
  expect(paused.estimate).toEqual({ calls: 1, inputTokens: 100, outputTokens: 20 }); expect(runStep).not.toHaveBeenCalled()
}, 60000)
