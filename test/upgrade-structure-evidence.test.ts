import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { emptyRegistry, layeredSettings, newLibrary } from '../src/domain/config.js'
import { defaultPolicy } from '../src/domain/policy.js'
import { createBuildModelClient } from '../src/host/models.js'
import { hash, writeJson } from '../src/layered/files.js'
import { protocolDigest } from '../src/layered/models.js'
import { pageObjectPath, putPage } from '../src/layered/objects.js'
import { storageJson } from '../src/layered/vectors.js'
import { readUpgradeStatus, upgradeLibrary, upgradeReviewEstimator } from '../src/layered/upgrade.js'
import { reviewTopicContent, topicReviewFingerprint, topicReviewRequests, topicReviewVersion, topicStructureReviewVersion } from '../src/layered/topic-review.js'
import type { TopicStructureEvidence } from '../src/layered/topic-review.js'
import type { AcceptedRecord, BuildLayeredOptions, TaskIdentity } from '../src/layered/schema.js'
import type { ModelClient, ModelRuntime } from '../src/llm/client.js'
import { legacyFixture, prepare } from './b3-fixture.js'

beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('结构证据回归禁止网络') })))
afterEach(() => vi.unstubAllGlobals())

const parentPage = 'topics/T-0001.md', childPage = 'topics/T-0001/T-0001-01.md'
const summary = '旧主题保留；当前来源已无可引用的原要点。'
async function fixture(research = false) {
  const f = await legacyFixture('0.2.1'), manifest = f.manifest
  const childContent = `---\nid: T-0001-01\npage_type: topic\ntitle: T-0001-01\narchived: true\n---\n\n# T-0001-01\n\n范围：${summary}\n`
  const content = `---\nid: T-0001\npage_type: topic\ntitle: 归档主题\nmodels: [历史/模型]\n---\n\n# 归档主题\n\n范围：${summary}\n\n## 适用条件\n\n- T-0001-01 标明旧主题保留，当前来源已无可引用的原要点。 [T-0001-01](T-0001/T-0001-01.md)\n${research ? '\n干预使死亡率降低50%，原资料未提及例外。\n' : ''}\n## 子主题导航\n\n- [T-0001-01 T-0001-01](T-0001/T-0001-01.md) — ${summary}\n`
  manifest.pages![parentPage] = await putPage(f.root, content)
  manifest.pages![childPage] = await putPage(f.root, childContent)
  manifest.deps!.pages[parentPage] = { sources: [], points: [], children: [{ page: childPage, version: 'v000001' }], models: [{ provider: '历史', model: '模型' }] }
  manifest.deps!.pages[childPage] = { sources: [], points: [], children: [], review: { fingerprint: '历史通过', removed: [] } }
  manifest.topics = { format_version: 1, version: manifest.version, next_topic_number: 2, embedding: { url: '', model: '' }, vectors: {}, topics: [
    { id: 'T-0001', path: parentPage, parent_id: null, title: '归档主题', summary, sources: [], point_ids: [], centroid: [], revisions: 0, archived: true },
    { id: 'T-0001-01', path: childPage, parent_id: 'T-0001', title: 'T-0001-01', summary, sources: [], point_ids: [], centroid: [], revisions: 0, archived: true },
  ] }
  await writeJson(f.root, 'versions/v000001.json', { manifest, checksum: hash(storageJson(manifest)) })
  const library = newLibrary('结构证据夹具'), policy = defaultPolicy()
  library.wikiPath = f.root; library.sourceRoots = [f.parent]; library.models.unified = { provider: 'offline', model: 'review' }
  library.models.layeredRoutes = {}; library.models.fallbacks = []; library.layered = { embeddingMode: 'none' }
  library.models.providerProfiles.offline = { concurrency: 1, retryLimit: 0, backoffMs: 0, cacheMode: 'none' }
  policy.batchDelayMs = 0; policy.pageGenerationConcurrency = 1; policy.maxTokensPerCall = 512
  const calls: { input: { review_stage: string; sentences: { id: string; text: string }[]; members: unknown[]; library_structure: TopicStructureEvidence }; system: string }[] = []
  const runtime: ModelRuntime = { resolveModelInfo: vi.fn(async (provider, id) => ({ provider, id, name: id, context: { contextWindow: 131072 } })),
    stream: vi.fn(async function* (request) {
      const message = request.messages[0]!.content[0]!
      if (message.type !== 'text') throw new Error('只接受离线文本')
      const input = JSON.parse(message.text); calls.push({ input, system: request.system })
      yield { type: 'usage' as const, usage: { inputTokens: 11, outputTokens: 5 } }
      const output = input.review_stage === 'topic-correction'
        ? { sentences: input.sentences.map((s: { id: string }) => ({ id: s.id, text: '', point_ids: [], support: '不支撑', missing: '结构不能证明研究结论。' })) }
        : { items: input.sentences.map((s: { id: string; text: string }) => ({ id: s.id, support: s.text.includes('死亡率') ? '不支撑' : '完整支撑', missing: s.text.includes('死亡率') ? '成员没有研究证据。' : null })) }
      yield { type: 'text-delta' as const, index: 0, text: JSON.stringify(output) }
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
    }) }
  const client = createBuildModelClient(runtime, library, policy, { ...emptyRegistry(), upgrade: { maxCalls: 8 } })
  const options: BuildLayeredOptions = { knowledgeRoot: f.parent, wikiPath: f.root, client, topics: library.layered }
  const estimates: { system: string; input: string }[] = []
  client.upgradeOptions!.estimateReview = upgradeReviewEstimator(hooks => {
    const bindings = client.bindRecovery!(hooks)
    return { ...bindings, stageInputBudgets: async (stage, request, limit) => {
      if (request.input) estimates.push(request)
      return bindings.stageInputBudgets(stage, request, limit)
    } }
  }, options)
  return { ...f, content, childContent, calls, estimates, client, options, parentObject: pageObjectPath(manifest.pages![parentPage]!), childObject: pageObjectPath(manifest.pages![childPage]!) }
}

it('真实子对象结构贯通估算和审核，保留旧正文且不伪造研究成员', async () => {
  const f = await fixture(), before = await readFile(path.join(f.root, 'versions/v000001.json'))
  const done = (await upgradeLibrary(f.root, f.client.upgradeOptions))!
  expect(done.status).toBe('complete'); expect(f.calls).toHaveLength(1); expect(done.estimate.calls).toBe(1)
  const request = f.calls[0]!, structure = request.input.library_structure
  expect(request.input.members).toEqual([])
  expect(structure.pages.find(page => page.path === childPage)).toMatchObject({ object_digest: f.manifest.pages![childPage], archived: true, direct_member_count: 0, content: f.childContent })
  expect(structure.roots[0]!.children).toEqual([{ path: childPage, version: 'v000001' }])
  expect(structure.pages.some(page => page.path === parentPage)).toBe(false)
  expect(structure.roots[0]).not.toHaveProperty('content'); expect(structure.roots[0]).not.toHaveProperty('summary'); expect(structure.roots[0]).not.toHaveProperty('title')
  expect(request.system).toContain('不能推出原资料未提及'); expect(request.system).toContain('不能证明所写研究结论为真')
  expect(f.estimates.some(item => item.input === JSON.stringify(request.input))).toBe(true)
  expect(await readFile(path.join(f.root, f.parentObject), 'utf8')).toBe(f.content)
  expect(await readFile(path.join(f.root, 'versions/v000001.json'))).toEqual(before)
  const records = await Promise.all((await readdir(path.join(f.root, 'work/accepted/tasks'))).map(async name => JSON.parse(await readFile(path.join(f.root, 'work/accepted/tasks', name), 'utf8')) as AcceptedRecord))
  expect(records.find(record => record.identity.validatorVersion === 'upgrade-structure-review-unit-v1')!.identity.promptDigest).toBe(topicStructureReviewVersion)
})

it('伪研究和资料未提及断言仍交模型核对，拒绝后不改旧页或生成占位排除', async () => {
  const f = await fixture(true)
  const done = (await upgradeLibrary(f.root, f.client.upgradeOptions))!
  expect(done.status).toBe('complete')
  expect(f.calls[0]!.input.sentences.some(s => s.text.includes('死亡率'))).toBe(true)
  expect(f.calls.some(call => call.input.review_stage === 'topic-correction')).toBe(false)
  expect(Object.values(done.reviewSettled ?? {}).flatMap(group => Object.values(group.objects)).some(object => object.outcome.kind === 'pending')).toBe(true)
  expect(await readFile(path.join(f.root, f.parentObject), 'utf8')).toBe(f.content)
  expect((await readUpgradeStatus(f.root))!.reviewExclusions?.[f.parentObject]).toBeUndefined()
})

it('结构变更使旧审核指纹失效，分块和合并均携带同一结构而不造P引用', async () => {
  const f = await fixture(); await upgradeLibrary(f.root, f.client.upgradeOptions)
  const structure = f.calls[0]!.input.library_structure, content = f.content + '\n' + Array.from({ length: 24 }, (_, i) => `本页保留第${i + 1}条子页状态说明。`).join('\n')
  let limit = 0, requests: ReturnType<typeof topicReviewRequests> = []
  for (let budget = 6000; budget <= 30000; budget += 250) {
    try {
      const plan = topicReviewRequests('T-0001', content, [], f.options, budget, undefined, structure)
      if (plan.length > 1 && plan.every(request => request.acceptance)) { limit = budget; requests = plan; break }
    } catch { /* 继续寻找能容纳完整结构及单句的分块预算。 */ }
  }
  expect(limit).toBeGreaterThan(0)
  const seen: { review_stage: string; library_structure: TopicStructureEvidence }[] = []
  const call = vi.fn(async (_task, _prompt, value: string) => {
    const input = JSON.parse(value); seen.push(input)
    return JSON.stringify({ items: input.sentences.map((s: { id: string }) => ({ id: s.id, support: '完整支撑', missing: null,
      ...(input.review_stage === 'topic-block' ? { findings: '真实库结构状态。', point_ids: [] } : {}) })) })
  })
  const options = { ...f.options, knowledgeRoot: '离线相对目录', client: { call, info: async () => ({ provider: 'offline', id: 'review' }), inputBudget: async () => limit } as unknown as ModelClient }
  const first = await reviewTopicContent('T-0001', content, [], options, undefined, false, undefined, undefined, structure)
  expect(first.failure).toBeUndefined(); expect(first.review!.removed).toEqual([])
  expect(seen.some(input => input.review_stage === 'topic-merge')).toBe(true)
  expect(seen.every(input => JSON.stringify(input.library_structure) === JSON.stringify(structure))).toBe(true)
  expect(requests.map(request => JSON.parse(request.input))).toEqual(seen.filter(input => input.review_stage === 'topic-block'))
  expect(requests.every(request => request.acceptance!.spec.semanticVersion === topicStructureReviewVersion)).toBe(true)
  const changed = structuredClone(structure); changed.pages.find(page => page.path === childPage)!.archived = false
  const before = call.mock.calls.length
  const second = await reviewTopicContent('T-0001', content, [], options, first.review, false, undefined, undefined, changed)
  expect(call.mock.calls.length).toBeGreaterThan(before); expect(second.review!.fingerprint).not.toBe(first.review!.fingerprint)
  expect(topicReviewFingerprint(content, [], true)).not.toBe(first.review!.fingerprint)
  expect(() => topicReviewRequests('T-0001', content, [], f.options, 1, undefined, structure)).toThrow('预算')
  const blockedCalls = call.mock.calls.length
  const blocked = await reviewTopicContent('T-0001', content, [], { ...options, client: { ...options.client, inputBudget: async () => 1 } as ModelClient }, undefined, false, undefined, undefined, structure)
  expect(blocked.failure).toContain('预算'); expect(call.mock.calls.length).toBe(blockedCalls)
})

it('依赖指定版本的子对象损坏时零模型拒绝，不以父页导航自证', async () => {
  const f = await fixture(); await writeFile(path.join(f.root, f.childObject), '伪造子页内容')
  await expect(upgradeLibrary(f.root, f.client.upgradeOptions)).rejects.toThrow('旧页面对象摘要不符')
  expect(f.calls).toEqual([]); expect(await readFile(path.join(f.root, f.parentObject), 'utf8')).toBe(f.content)
})

it('有效旧base accepted按原身份零模型回放，不迁签为结构协议', async () => {
  const f = await fixture()
  await expect(upgradeLibrary(f.root, { ...f.client.upgradeOptions, onStatus: status => { if (status.reason === '升级开始或重入') throw new Error('停在执行前') } })).rejects.toThrow('停在执行前')
  const paused = (await readUpgradeStatus(f.root))!, step = paused.steps[0]!
  const identity: TaskIdentity = { version: 1, scope: { libraryId: f.client.recovery!.libraryId, unitId: step.id + ':object:' + f.parentObject, sourceRefs: [] },
    stage: 'topicReview', operation: 'review', inputDigest: protocolDigest([step.inputDigest, f.parentObject, { topicId: 'T-0001', content: f.content, points: [], sources: [] }]),
    promptDigest: topicReviewVersion, schemaDigest: protocolDigest(['upgrade-review-unit-v1', 'topicReview']), validatorVersion: 'upgrade-review-unit-v1', semanticVersion: 'upgrade-review-unit-v1',
    groupPlanDigest: protocolDigest([f.parentObject]), revocationGeneration: 0, reextractGeneration: 0 }
  const accepted = await prepare(f.root, { identity, run: paused.id, content: JSON.stringify({ id: f.parentObject, result: {
    fingerprint: topicReviewFingerprint(f.content, [], layeredSettings(f.options.topics || {}).contradictionReview), removed: [], models: [] } }) })
  const ref = await accepted.commit(), bytes = await readFile(path.join(f.root, ref.path))
  expect((await f.client.upgradeOptions!.estimateReview!(step, f.root)).calls).toBe(0)
  const done = (await upgradeLibrary(f.root, f.client.upgradeOptions))!
  expect(done.status).toBe('complete'); expect(f.calls).toEqual([])
  expect(await readFile(path.join(f.root, ref.path))).toEqual(bytes)
  const outer = JSON.parse(await readFile(path.join(f.root, Object.values(done.accepted)[0]!.path), 'utf8')) as AcceptedRecord
  expect(outer.dependencies.map(dependency => dependency.taskId)).toEqual([ref.taskId])
})
