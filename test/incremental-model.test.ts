import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { ModelCallError } from '../src/llm/client.js'
import { buildPolicyKey, buildRegistrationKey } from '../src/domain/build-identity.js'
import { validatePublication } from '../src/layered/publication.js'
import { cleanupLayeredFixtures, layeredFixture, layeredIncrementalFixture, modelOutput, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('模型供应商推理并发超时变化均零提取，登记与内容策略身份稳定', async () => {
  const f = await layeredIncrementalFixture()
  f.runtime.resolveModelInfo = async (provider, id) => ({ provider, id, name: id, context: { contextWindow: 32768 },
    reasoning: { efforts: [{ id: 'high', name: '高' }] } })
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组固定结论。'); await buildLayeredLibrary(f.options)
  const old = (await snapshotManifest(f.root)).sources[0]!, registration = buildRegistrationKey(f.library), policy = buildPolicyKey(f.policy)
  f.call.mockClear()
  const changes = [() => { f.library.models.unified.model = '新模型' }, () => { f.library.models.unified.provider = '新供应商' },
    () => { f.policy.advancedSettingsMode = 'custom'; f.policy.reasoningEffort = 'high' },
    () => { f.policy.pageGenerationConcurrency = 30; f.policy.ingestRequestTimeoutSeconds = 45 }]
  for (const change of changes) {
    change()
    expect(await buildLayeredLibrary(f.options)).toMatchObject({ modelCalls: 0, unchanged: true })
    expect((await snapshotManifest(f.root)).sources[0]!.extract.path).toBe(old.extract.path)
    expect(buildRegistrationKey(f.library)).toBe(registration); expect(buildPolicyKey(f.policy)).toBe(policy)
  }
  expect(f.call).not.toHaveBeenCalled()
})

it('更大和仍能容纳旧包的较小窗口沿用分组，重新发布零模型调用', async () => {
  const f = await layeredFixture()
  f.options.maxInputBytes = 18000
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), Array.from({ length: 25 }, (_, n) => `第${n}段：${'研究内容与证据。'.repeat(50)}`).join('\n\n'))
  const built = await buildLayeredLibrary(f.options), old = (await snapshotManifest(f.root)).sources[0]!
  const result = JSON.parse(await readFile(path.join(f.root, old.extract.path), 'utf8'))
  expect(result.chunk_plan.length).toBeGreaterThan(1)
  f.call.mockClear()
  for (const window of [128000, 25000]) {
    f.library.models.unified.model = '窗口' + window
    f.runtime.resolveModelInfo = async (provider, id) => ({ provider, id, name: id, context: { contextWindow: window } })
    expect(await buildLayeredLibrary(f.options)).toMatchObject({ unchanged: true, modelCalls: 0 })
    const next = (await snapshotManifest(f.root)).sources[0]!
    expect(next.extract.path).toBe(old.extract.path)
    expect(JSON.parse(await readFile(path.join(f.root, next.extract.path), 'utf8')).chunk_plan).toEqual(result.chunk_plan)
  }
  await validatePublication(f.root, built.version)
  expect(f.call).not.toHaveBeenCalled()
})

it('显式指定与全部重提生效，颗粒度改变重提且旧产物保持不可变', async () => {
  const f = await layeredFixture()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '第一篇。'); await writeFile(path.join(f.knowledgeRoot, 'b.md'), '第二篇。')
  await buildLayeredLibrary(f.options)
  const old = (await snapshotManifest(f.root)).sources, bytes = await readFile(path.join(f.root, old[0]!.extract.path), 'utf8')
  f.requests.length = 0; f.library.models.unified = { provider: '新供应商', model: '新模型' }
  await buildLayeredLibrary({ ...f.options, reextract: [old[0]!.source_id] })
  expect(f.requests.map(request => request.input.source_id)).toEqual([old[0]!.source_id])
  expect((await snapshotManifest(f.root)).sources[1]!.extract.path).toBe(old[1]!.extract.path)
  expect(await readFile(path.join(f.root, old[0]!.extract.path), 'utf8')).toBe(bytes)
  f.requests.length = 0; await buildLayeredLibrary({ ...f.options, reextract: 'all' })
  expect(f.requests).toHaveLength(2)
  f.requests.length = 0; await buildLayeredLibrary({ ...f.options, tier: 75 })
  expect(f.requests).toHaveLength(2)
})

it('fallback产出模型保存到来源要点与核对结果，主路由失败不冒记为产出', async () => {
  const f = await layeredFixture()
  f.library.models.fallbacks = [{ provider: '备用供应商', model: '备用模型' }]
  f.library.models.providerProfiles.mock = { concurrency: 50, retryLimit: 0, backoffMs: 1, cacheMode: 'automatic-prefix' }
  f.runtime.stream = async function* (options) {
    if (options.provider === 'mock') throw new ModelCallError('主路由不可用', 'mock-reject', 503)
    yield { type: 'text-delta', index: 0, text: modelOutput(JSON.parse((options.messages[0]!.content[0] as { text: string }).text)) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '备用模型核实的原文。')
  await buildLayeredLibrary(f.options)
  const source = (await snapshotManifest(f.root)).sources[0]!, result = JSON.parse(await readFile(path.join(f.root, source.extract.path), 'utf8'))
  const actual = [{ provider: '备用供应商', model: '备用模型' }]
  expect(source.models).toEqual(actual); expect(result.actual_model).toBe('备用供应商/备用模型')
  for (const point of result.segments.flatMap((segment: any) => segment.points)) {
    expect(point.models).toEqual(actual)
    if (point.verification) expect(point.verification.models).toEqual(actual)
  }
})

it('预算暂停后换模型续做，完成来源保持原模型并只提剩余来源', async () => {
  const f = await layeredFixture()
  f.options.topics = { maxBuildCalls: 1, extractionReview: 'off', topicMergeMinSources: 100 }
  f.options.embeddingClient = { identity: async () => '固定嵌入', embed: async texts => texts.map(() => [1, 0]) }
  f.options.previewContext = { registrationKey: buildRegistrationKey(f.library), policyRevision: buildPolicyKey(f.policy) }
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '第一篇完整来源。'); await writeFile(path.join(f.knowledgeRoot, 'b.md'), '第二篇完整来源。')
  await expect(buildLayeredLibrary(f.options)).rejects.toThrow()
  const pending = JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8'))
  expect(pending.manifest.sources).toHaveLength(1)
  const firstId = pending.manifest.sources[0].source_id, firstPath = pending.manifest.sources[0].extract.path
  f.requests.length = 0; f.library.models.unified = { provider: '接续供应商', model: '接续模型' }
  await buildLayeredLibrary({ ...f.options, topics: { ...f.options.topics, maxBuildCalls: 100 } })
  expect(f.requests).toHaveLength(1); expect(f.requests[0]!.input.source_id).not.toBe(firstId)
  expect((await snapshotManifest(f.root)).sources.find(source => source.source_id === firstId)!.extract.path).toBe(firstPath)
})
