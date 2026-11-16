import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { defaultPolicy } from '../src/domain/policy.js'
import { createBuildModelClient } from '../src/host/models.js'
import { createExecutionLedger, readRunCosts } from '../src/layered/costs.js'
import { hash, writeJson } from '../src/layered/files.js'
import { readProvenance } from '../src/layered/models.js'
import { pageObjectPath, putPage } from '../src/layered/objects.js'
import { readUpgradeStatus, upgradeLibrary } from '../src/layered/upgrade.js'
import { storageJson } from '../src/layered/vectors.js'
import { topicClaimText } from '../src/layered/topic-metadata.js'
import type { AcceptedRecord } from '../src/layered/schema.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { finish, legacyFixture, request } from './b3-fixture.js'

beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('归档占位回归禁止网络') })))
afterEach(() => vi.unstubAllGlobals())

const archivedId = 'T-0012-02-01-13161'
const archivedPage = `topics/T-0012/T-0012-02/T-0012-02-01/${archivedId}.md`
function placeholder(id = archivedId) {
  return `---\n${stringify({ id, page_type: 'topic', aliases: [], title: id, source_type: '综合', credibility: 'mixed',
    source_date: 'unknown', sources: [], models: [], archived: true, updated: 'unknown', generation_hash: hash('程序生成'),
    input_fingerprint: hash(id), generation_input_fingerprint: hash('原生成输入'), type: 'topic', created: '2026-11-14T04:33:40.550Z', tags: [] }).trimEnd()}\n---\n\n# ${id}\n\n范围：旧主题保留；当前来源已无可引用的原要点。\n\n## 共识\n\n未提取\n\n## 分歧\n\n未提取\n\n## 适用条件\n\n未提取\n\n## 来源导航\n\n\n`
}

async function fixture(extra = false, content = placeholder(), sources: string[] = []) {
  const f = await legacyFixture('0.2.1'), manifest = f.manifest
  manifest.pages![archivedPage] = await putPage(f.root, content)
  manifest.deps!.pages[archivedPage] = { sources, points: [], children: [], revisions: 0, models: [] }
  if (extra) {
    manifest.pages!['topics/T-2.md'] = await putPage(f.root, '# 实质主题\n\nS-0001 的已发布证据。\n')
    manifest.deps!.pages['topics/T-2.md'] = { sources: ['S-0001'], points: [] }
  }
  await writeJson(f.root, 'versions/v000001.json', { manifest, checksum: hash(storageJson(manifest)) })
  return { ...f, object: pageObjectPath(manifest.pages![archivedPage]!), versionBytes: await readFile(path.join(f.root, 'versions/v000001.json')) }
}

function models(f: Awaited<ReturnType<typeof fixture>>, supported = false) {
  const library = newLibrary('归档占位夹具'), policy = defaultPolicy(), calls: string[] = []
  library.wikiPath = f.root; library.sourceRoots = [f.parent]; library.models.unified = { provider: 'offline', model: 'review' }
  library.models.layeredRoutes = {}; library.models.fallbacks = []; library.layered = { embeddingMode: 'none' }
  library.models.providerProfiles.offline = { concurrency: 1, retryLimit: 0, backoffMs: 0, cacheMode: 'none' }
  policy.batchDelayMs = 0; policy.pageGenerationConcurrency = 1; policy.maxTokensPerCall = 512
  const runtime: ModelRuntime = { resolveModelInfo: vi.fn(async (provider, id) => ({ provider, id, name: id, context: { contextWindow: 131072 } })),
    stream: vi.fn(async function* (request) {
      const message = request.messages[0]!.content[0]!
      if (message.type !== 'text') throw new Error('只接受离线文本')
      const input = JSON.parse(message.text); calls.push(input.topic_id)
      yield { type: 'usage' as const, usage: { inputTokens: 11, outputTokens: 5 } }
      if (!supported) { yield { type: 'finish' as const, reason: { kind: 'error' as const, failure: { code: 'EIO', message: '实质主题必须进入真实核对路径' } } }; return }
      yield { type: 'text-delta' as const, index: 0, text: JSON.stringify({ items: input.sentences.map((item: { id: string }) => ({ id: item.id, support: '完整支撑', missing: null })) }) }
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
    }) }
  return { calls, client: (maxCalls: number) => createBuildModelClient(runtime, library, policy, { ...emptyRegistry(), upgrade: { maxCalls } }) }
}

async function sourcedFixture(clean = true, sourceIds = ['S-0001']) {
  const f = await fixture(), title = '旧研究题目 [P1] <标题>', summary = '旧主题保留；当前来源已无可引用的原要点。'
  const prose = (text: string) => (clean ? topicClaimText(text) : text).replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('[', '\\[').replaceAll(']', '\\]')
  const sources = f.manifest.sources.filter(source => sourceIds.includes(source.source_id))
  for (const source of sources) { source.metadata.title = source.source_id + ' 来源 [P2] <标题>'; source.tags = ['alpha', 'beta'] }
  const created = '2026-11-14T04:33:40.550Z'
  f.manifest.page_created = { [archivedPage]: created }
  f.manifest.topics = { format_version: 1, version: f.manifest.version, next_topic_number: 13, embedding: { url: '', model: '' }, vectors: {},
    topics: [{ id: archivedId, path: archivedPage, parent_id: null, title: prose(title), summary, sources: sourceIds, point_ids: [],
      centroid: [], revisions: 0, aliases: [], models: [], archived: true, page_status: 'ready' }] }
  f.manifest.deps!.pages[archivedPage] = { sources: sourceIds, points: [], children: [], revisions: 0, models: [] }
  const header = { id: archivedId, page_type: 'topic', aliases: [], title, source_type: '综合', credibility: 'unknown',
    source_date: '2026-11-13/2026-11-13', sources: sourceIds, models: [], archived: true, updated: '2026-11-13',
    generation_hash: hash('程序生成'), input_fingerprint: hash(archivedId), generation_input_fingerprint: hash('原生成输入'), type: 'topic', created, tags: ['alpha', 'beta'] }
  const navigation = sources.map(source => `- [${source.source_id} ${prose(source.metadata.title)}](../../../../sources/${source.source_id}.md) — `).join('\n')
  const content = `---\n${stringify(header).trimEnd()}\n---\n\n# ${prose(title)}\n\n范围：${summary}\n\n## 共识\n\n${sources.length === 1 ? '单来源，未形成共识。' : '未提取'}\n\n## 分歧\n\n未提取\n\n## 适用条件\n\n未提取\n\n## 来源导航\n\n${navigation}\n`
  return saveSourcedFixture(f, content)
}
async function saveSourcedFixture(f: Awaited<ReturnType<typeof fixture>>, content: string) {
  f.manifest.pages![archivedPage] = await putPage(f.root, content)
  await writeJson(f.root, 'versions/v000001.json', { manifest: f.manifest, checksum: hash(storageJson(f.manifest)) })
  return { ...f, content, object: pageObjectPath(f.manifest.pages![archivedPage]!), versionBytes: await readFile(path.join(f.root, 'versions/v000001.json')) }
}

it('标准无来源归档占位零模型升级，独立本地排除不伪造接受或改写旧页', async () => {
  const f = await fixture(), m = models(f), done = (await upgradeLibrary(f.root, m.client(0).upgradeOptions))!
  expect(done).toMatchObject({ status: 'complete', actual: { calls: 0 }, estimate: { calls: 0 }, accepted: {} })
  expect(done.steps[0]!.unitIds).toEqual([f.object]); expect(m.calls).toEqual([])
  expect(done.reviewExclusions![f.object]).toMatchObject({ rule: 'archived-topic-placeholder-v1', objectDigest: f.manifest.pages![archivedPage] })
  expect(await readFile(path.join(f.root, 'versions/v000001.json'))).toEqual(f.versionBytes)
  expect(await readFile(path.join(f.root, f.object), 'utf8')).toBe(placeholder())
  expect(await readdir(path.join(f.root, 'work/accepted/tasks')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))).toEqual([])
  const provenance = await readProvenance(f.root, 'v000001', hash(storageJson(f.manifest)))
  expect(Object.values(provenance.artifacts).find(item => item.pagePath === archivedPage)).toMatchObject({ status: 'unknown', productionIds: [] })
  expect(Object.values(provenance.artifacts).find(item => item.metadata?.fields.includes('review-exclusion'))).toMatchObject({ status: 'local-derived', productionIds: [] })
})

it('旧无排除字段的全占位计划恢复保留步骤和原三次费用，零新增接受及请求', async () => {
  const f = await fixture(), m = models(f)
  await expect(upgradeLibrary(f.root, { estimateReview: async () => ({ calls: 1, inputTokens: 10, outputTokens: 20, maxInputTokens: 10, maxOutputTokens: 20 }),
    onStatus: status => { if (status.reason === '升级开始或重入') throw new Error('保留旧计划现场') } })).rejects.toThrow('保留旧计划现场')
  const before = (await readUpgradeStatus(f.root))!, steps = structuredClone(before.steps), ledger = createExecutionLedger(f.root)
  expect(before.reviewExclusions).toBeUndefined()
  for (let sequence = 1; sequence <= 3; sequence++) await finish(ledger, request('t:' + hash('历史失败核对').slice(7), sequence, '原模型', before.id, 'topicReview'))
  const costs = await readRunCosts(f.root, before.id), done = (await upgradeLibrary(f.root, m.client(3).upgradeOptions))!
  expect(done).toMatchObject({ id: before.id, backupPath: before.backupPath, inputDigest: before.inputDigest, status: 'complete', actual: { calls: 3, tokens: 51 }, accepted: {} })
  expect(done.steps.map(({ estimate, estimatedInputTokens, maxOutputTokens, ...identity }) => identity)).toEqual(steps.map(({ estimate, estimatedInputTokens, maxOutputTokens, ...identity }) => identity))
  expect(done.files).toEqual(before.files); expect(await readRunCosts(f.root, before.id)).toEqual(costs); expect(m.calls).toEqual([])
  expect(await readFile(path.join(f.root, 'versions/v000001.json'))).toEqual(f.versionBytes)
})

it('混合原步骤只接受实质主题，排除对象留在原计划且完成后零重调', async () => {
  const f = await fixture(true), m = models(f, true), done = (await upgradeLibrary(f.root, m.client(4).upgradeOptions))!
  expect(done.status).toBe('complete'); expect(done.steps[0]!.unitIds).toHaveLength(2); expect(m.calls).toEqual(['T-2'])
  const ref = done.accepted[done.steps[0]!.id]!, accepted = JSON.parse(await readFile(path.join(f.root, ref.path), 'utf8')) as AcceptedRecord
  const output = JSON.parse(await readFile(path.join(f.root, accepted.output.path), 'utf8'))
  expect(output.units.map((unit: { id: string }) => unit.id)).toEqual([pageObjectPath(f.manifest.pages!['topics/T-2.md']!)])
  expect(accepted.dependencies).toHaveLength(1)
  const provenance = await readProvenance(f.root, 'v000001', hash(storageJson(f.manifest)))
  expect(Object.values(provenance.artifacts).find(item => item.metadata?.fields.includes('review'))!.metadata!.target).toBe(pageObjectPath(f.manifest.pages!['topics/T-2.md']!))
  await upgradeLibrary(f.root, m.client(4).upgradeOptions); expect(m.calls).toEqual(['T-2'])
  expect(await readFile(path.join(f.root, 'versions/v000001.json'))).toEqual(f.versionBytes)
})

it('archived正文多出研究事实不能按占位排除，失败保持旧正文与格式', async () => {
  const content = placeholder().replace('## 分歧', '- 干预能显著提升护理效果。\n\n## 分歧'), f = await fixture(false, content), m = models(f)
  await expect(upgradeLibrary(f.root, m.client(4).upgradeOptions)).rejects.toThrow('实质主题必须进入真实核对路径')
  expect(m.calls).toEqual([archivedId]); expect((await readUpgradeStatus(f.root))!.reviewExclusions).toBeUndefined()
  expect(await readFile(path.join(f.root, f.object), 'utf8')).toBe(content)
  expect(JSON.parse(await readFile(path.join(f.root, '.llmwiki/policy.json'), 'utf8')).libraryFormat).not.toBe('0.3.0')
})

it('正文虽同模板但仍有来源依赖的归档页继续核对，不依赖空members绕过', async () => {
  const f = await fixture(false, placeholder(), ['S-0001']), m = models(f)
  await expect(upgradeLibrary(f.root, m.client(4).upgradeOptions)).rejects.toThrow('实质主题必须进入真实核对路径')
  expect(m.calls).toEqual([archivedId]); expect((await readUpgradeStatus(f.root))!.reviewExclusions).toBeUndefined()
  expect(await readFile(path.join(f.root, 'versions/v000001.json'))).toEqual(f.versionBytes)
})

it('有来源v2完整占位恢复保留原五次费用与升级身份，不新增请求或接受', async () => {
  const f = await sourcedFixture(), m = models(f)
  await expect(upgradeLibrary(f.root, { estimateReview: async () => ({ calls: 1, inputTokens: 10, outputTokens: 20, maxInputTokens: 10, maxOutputTokens: 20 }),
    onStatus: status => { if (status.reason === '升级开始或重入') throw new Error('保留五次失败现场') } })).rejects.toThrow('保留五次失败现场')
  const before = (await readUpgradeStatus(f.root))!, ledger = createExecutionLedger(f.root)
  for (let sequence = 1; sequence <= 5; sequence++) await finish(ledger, request('t:' + hash('历史失败核对').slice(7), sequence, '原模型', before.id, 'topicReview'), false)
  const costs = await readRunCosts(f.root, before.id), done = (await upgradeLibrary(f.root, m.client(5).upgradeOptions))!
  expect(done).toMatchObject({ id: before.id, backupPath: before.backupPath, inputDigest: before.inputDigest, status: 'complete', actual: { calls: 5, tokens: 85 }, accepted: {} })
  expect(done.reviewExclusions![f.object]).toMatchObject({ rule: 'archived-topic-placeholder-v2', objectDigest: f.manifest.pages![archivedPage], pagePaths: [archivedPage] })
  expect(done.reviewExclusions![f.object]!.dependencyDigests).toHaveLength(1)
  expect(await readRunCosts(f.root, before.id)).toEqual(costs); expect(m.calls).toEqual([])
  expect(await readFile(path.join(f.root, 'versions/v000001.json'))).toEqual(f.versionBytes)
  expect(await readFile(path.join(f.root, f.object), 'utf8')).toBe(f.content)
  expect(await readdir(path.join(f.root, 'work/accepted/tasks')).catch(error => error.code === 'ENOENT' ? [] : Promise.reject(error))).toEqual([])
})

it('有来源v2兼容旧版原样转义标题和来源导航，精确保留嵌套相对路径', async () => {
  const f = await sourcedFixture(false), m = models(f), done = (await upgradeLibrary(f.root, m.client(0).upgradeOptions))!
  expect(done).toMatchObject({ status: 'complete', actual: { calls: 0 }, accepted: {} })
  expect(done.reviewExclusions![f.object]!.rule).toBe('archived-topic-placeholder-v2'); expect(m.calls).toEqual([])
  expect(await readFile(path.join(f.root, f.object), 'utf8')).toBe(f.content)
})

it('有来源v2多来源完整占位使用未提取共识并逐项核对导航', async () => {
  const f = await sourcedFixture(true, ['S-0001', 'S-0002']), m = models(f), done = (await upgradeLibrary(f.root, m.client(0).upgradeOptions))!
  expect(done).toMatchObject({ status: 'complete', actual: { calls: 0 }, accepted: {} })
  expect(done.reviewExclusions![f.object]!.rule).toBe('archived-topic-placeholder-v2'); expect(m.calls).toEqual([])
  expect(f.content).toContain('## 共识\n\n未提取')
})

it('有来源v2占位导航路径不符必须继续真实核对', async () => {
  const initial = await sourcedFixture(), f = await saveSourcedFixture(initial, initial.content.replace('../../../../sources/S-0001.md', '../sources/S-0001.md')), m = models(f)
  await expect(upgradeLibrary(f.root, m.client(4).upgradeOptions)).rejects.toThrow('实质主题必须进入真实核对路径')
  expect(m.calls).toEqual([archivedId]); expect((await readUpgradeStatus(f.root))!.reviewExclusions).toBeUndefined()
  expect(await readFile(path.join(f.root, 'versions/v000001.json'))).toEqual(f.versionBytes)
})

it('有来源v2空成员但权威主题保留模型时必须继续真实核对', async () => {
  const initial = await sourcedFixture(); initial.manifest.topics!.topics[0]!.models = [{ provider: '历史', model: '真实综合' }]
  const f = await saveSourcedFixture(initial, initial.content), m = models(f)
  await expect(upgradeLibrary(f.root, m.client(4).upgradeOptions)).rejects.toThrow('实质主题必须进入真实核对路径')
  expect(m.calls).toEqual([archivedId]); expect((await readUpgradeStatus(f.root))!.reviewExclusions).toBeUndefined()
  expect(await readFile(path.join(f.root, f.object), 'utf8')).toBe(f.content)
})
