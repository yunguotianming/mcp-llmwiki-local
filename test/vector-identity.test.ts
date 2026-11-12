import { copyWithEmbedding } from '../src/layered/query-vectors.js'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { layeredSettings } from '../src/domain/config.js'
import { detectOllama, libraryVectorState, sameIdentity } from '../src/layered/vector-identity.js'
import { readCurrent } from '../src/layered/objects.js'
import { cleanupLayeredFixtures, layeredTopicFixture, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

describe('库级向量身份与断点', () => {
  it('自动只接收嵌入模型并优先轻量模型，聊天模型不能入选', async () => {
    const request = vi.fn(async (url: string | URL | Request) => new Response(JSON.stringify(String(url).endsWith('/api/tags')
      ? { models: [{ name: 'chat:latest', digest: 'chat' }, { name: 'qwen3-embedding:0.6b', digest: 'small' }] }
      : { capabilities: ['embedding'] })))
    expect(await detectOllama(layeredSettings(), true, undefined, request)).toEqual({ model: 'qwen3-embedding:0.6b', revision: 'small' })
    request.mockImplementation(async () => new Response(JSON.stringify({ models: [{ name: 'chat:latest', digest: 'chat' }] })))
    await expect(detectOllama(layeredSettings(), true, undefined, request)).rejects.toThrow('不使用向量')
  })

  it('锁定后离线暂停保留提取断点，恢复只补缺项', async () => {
    const f = await layeredTopicFixture()
    await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 甲\n\n甲组的研究结果。')
    await buildLayeredLibrary(f.options)
    const before = await snapshotManifest(f.root)
    f.options.previewContext = { registrationKey: JSON.stringify({ id: 'library', layered: f.options.topics }), policyRevision: 'fixed-policy' }
    expect(before.vector_state?.identity?.model).toBe('qwen3-embedding:0.6b')
    const embedded = f.embed.getMockImplementation()!
    f.embed.mockRejectedValue(new Error('服务离线'))
    await writeFile(path.join(f.knowledgeRoot, 'b.md'), '# 乙\n\n甲组的新增研究结果。')
    await expect(buildLayeredLibrary(f.options)).rejects.toThrow('暂停')
    expect((await readCurrent(f.root))?.version).toBe(before.version)
    const pending = JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8'))
    expect(pending.manifest.sources).toHaveLength(2)
    expect(pending.paused.reason).toBe('embedding')
    expect(pending.manifest.vector_state.identity).toEqual(before.vector_state!.identity)
    const extractionCalls = f.requests.length
    f.embed.mockImplementation(embedded)
    f.options.topics = { ...f.options.topics || {}, localEmbeddingUrl: 'http://recovered-device:11434', embeddingUnavailable: 'continue' }
    f.options.previewContext = { ...f.options.previewContext, registrationKey: JSON.stringify({ id: 'library', layered: f.options.topics }) }
    await buildLayeredLibrary(f.options)
    expect(f.requests).toHaveLength(extractionCalls)
    expect((await snapshotManifest(f.root)).vector_state?.coverage.missing).toEqual([])
  })

  it('离线继续保留旧主题并发布待归属要点，恢复完成归属', async () => {
    const f = await layeredTopicFixture()
    await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 甲\n\n甲组的研究结果。')
    await buildLayeredLibrary(f.options)
    const before = await snapshotManifest(f.root), embedded = f.embed.getMockImplementation()!
    f.options.topics = { ...f.options.topics || {}, embeddingUnavailable: 'continue' }
    f.embed.mockRejectedValue(new Error('服务离线'))
    await writeFile(path.join(f.knowledgeRoot, 'b.md'), '# 乙\n\n甲组的新增研究结果。')
    await buildLayeredLibrary(f.options)
    const deferred = await snapshotManifest(f.root)
    expect(deferred.topics?.topics.map(topic => topic.point_ids)).toEqual(before.topics?.topics.map(topic => topic.point_ids))
    expect(deferred.vector_state?.pending_points.length).toBeGreaterThan(0)
    expect(deferred.sources.find(source => source.current_path === 'b.md')?.pending_topic_points?.length).toBeGreaterThan(0)
    f.embed.mockImplementation(embedded)
    await buildLayeredLibrary(f.options)
    const recovered = await snapshotManifest(f.root)
    expect(recovered.vector_state?.pending_points).toEqual([])
    expect(recovered.vector_state?.identity).toEqual(before.vector_state?.identity)
  })

  it('复制换维度重嵌入并发布副本，源代次和来源提取保持', async () => {
    const f = await layeredTopicFixture()
    await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 甲\n\n甲组的研究结果。')
    await buildLayeredLibrary(f.options)
    const before = await snapshotManifest(f.root), extractions = f.requests.length
    f.options.topics = { ...f.options.topics || {}, localEmbeddingModel: 'qwen3-embedding:8b', embeddingChangeToken: randomUUID() }
    f.options.embeddingClient = { identity: async () => 'large-weights', embed: async inputs => inputs.map(() => [1, 0, 0, 0]) }
    const result = await copyWithEmbedding(f.root, { embeddingMode: 'ollama', localEmbeddingModel: 'qwen3-embedding:8b' }, true, { embeddingClient: f.options.embeddingClient, settings: f.options.topics || {} })
    expect((await readCurrent(f.root))?.version).toBe(before.version)
    expect(result.version).not.toBe(before.version)
    expect(f.requests).toHaveLength(extractions)
    const pending = { manifest: await snapshotManifest(result.path) }
    expect(pending.manifest.vector_state!.identity!.dimensions).toBe(4)
    expect(pending.manifest.vector_state.generation).toBe(before.vector_state!.generation + 1)
    expect(pending.manifest.vector_state.coverage.missing).toEqual([])
    expect(pending.manifest.vector_state.page_vectors['sources/S-0001.md']).toBeDefined()
  })

  it('旧库从向量头和原主题配置恢复，缺证据不自动选新默认', async () => {
    const f = await layeredTopicFixture()
    f.options.topics = { ...f.options.topics || {}, localEmbeddingModel: 'qwen3-embedding:8b' }
    await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 甲\n\n甲组的研究结果。')
    await buildLayeredLibrary(f.options)
    const manifest = await snapshotManifest(f.root), identity = manifest.vector_state!.identity
    delete manifest.vector_state
    const recovered = await libraryVectorState(f.root, manifest)
    expect(sameIdentity(identity, recovered?.identity)).toBe(true)
    expect(recovered?.identity?.model).toBe('qwen3-embedding:8b')
    manifest.topics!.vectors = {}
    expect((await libraryVectorState(f.root, manifest))?.mode).toBe('unresolved')
  })
})

it('纯向量切换时带提取缺口和补标缺口的来源零提取、零补标调用，缺口原样保留', async () => {
  const f = await layeredTopicFixture(), original = f.call.getMockImplementation()!
  f.options.topics = { ...f.options.topics || {}, pointLabelsOnBuild: true }
  let failLabels = true
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (failLabels && input.label_stage) throw new Error('补标临时失败')
    return original(...args)
  })
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 甲\n\n甲组的研究结果。')
  await buildLayeredLibrary(f.options)
  const pending = () => readFile(path.join(f.root, 'work/pending.json'), 'utf8').then(JSON.parse)
  // 发布后 pending.json 已清理，切换前状态从已发布清单读取。
  const before = { manifest: await snapshotManifest(f.root) }
  expect(before.manifest.point_label_gaps!.length).toBeGreaterThan(0)
  failLabels = false
  f.call.mockClear()
  f.options.topics = { ...f.options.topics || {}, localEmbeddingModel: 'qwen3-embedding:8b', embeddingChangeToken: randomUUID() }
  f.options.embeddingClient = { identity: async () => 'large-weights', embed: async inputs => inputs.map(() => [1, 0, 0, 0]) }
  const copied = await copyWithEmbedding(f.root, { embeddingMode: 'ollama', localEmbeddingModel: 'qwen3-embedding:8b' }, true, { embeddingClient: f.options.embeddingClient, settings: f.options.topics || {} })
  const inputs = f.call.mock.calls.map(call => JSON.parse(call[2]))
  expect(inputs.filter(input => input.paragraphs)).toHaveLength(0)
  expect(inputs.filter(input => input.label_stage)).toHaveLength(0)
  const after = { manifest: await snapshotManifest(copied.path) }
  expect(after.manifest.point_label_gaps).toEqual(before.manifest.point_label_gaps)
  expect(after.manifest.sources.map((source: any) => source.extract.path)).toEqual(before.manifest.sources.map((source: any) => source.extract.path))
  expect(after.manifest.vector_state.identity.dimensions).toBe(4)
})
