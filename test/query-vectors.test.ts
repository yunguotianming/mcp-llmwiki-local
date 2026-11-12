import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { copyWithEmbedding } from '../src/layered/query-vectors.js'
import { cleanupLayeredFixtures, layeredTopicFixture, modelOutput, snapshotManifest } from './layered-fixture.js'
import { hash, writeJson } from '../src/layered/files.js'
import { safePath } from '../src/storage/paths.js'
import { LayeredQuery } from '../src/wiki/layered-query.js'
import { registeredEmbedding } from '../src/storage/embedding-registration.js'
import { updateTopicCandidates } from '../src/layered/clustering.js'
import { hydrateVectors } from '../src/layered/vectors.js'
import { layeredSettings } from '../src/domain/config.js'
import { writeVersion } from '../src/layered/objects.js'
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
const target = { embeddingMode: 'ollama', localEmbeddingModel: 'qwen3-embedding:0.6b' } as const
const clientB = () => ({ identity: vi.fn(async () => 'weights-B'), embed: vi.fn(async (inputs: string[]) => inputs.map(() => [1, 0, 0])) })
async function fixture(partition = true) {
  const f = await layeredTopicFixture(), original = f.call.getMockImplementation()!
  f.call.mockImplementation(async (...args) => { const input = JSON.parse(args[2]), output = await original(...args); return input.paragraphs ? JSON.stringify({ ...JSON.parse(output), terms: JSON.parse(modelOutput(input)).terms }) : output })
  const root = partition ? path.join(f.knowledgeRoot, '.llmwiki-qwen3-8b') : f.root
  f.options.wikiPath = root; f.options.topics = { ...f.options.topics || {}, localEmbeddingModel: 'qwen3-embedding:8b', termThreshold50: 1 }
  await fs.writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 甲组\n\n甲组的研究结果。')
  await buildLayeredLibrary(f.options); f.call.mockClear()
  return { ...f, root, manifest: await snapshotManifest(root) }
}
async function hashes(root: string, relative: string) {
  const folder = await safePath(root, relative), entries = await fs.readdir(folder, { recursive: true, withFileTypes: true })
  return Object.fromEntries(await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => { const file = path.join(entry.parentPath, entry.name); return [path.relative(folder, file), hash(await fs.readFile(file))] })))
}
it('复制保留页面、对象、主题成员、候选、排除和术语分节；目标无变化更新零调用', async () => {
  const f = await fixture(), b = clientB(), pages = await hashes(f.root, 'wiki'), objects = await hashes(f.root, 'objects/pages')
  // 明确保留非空候选和排除记录，避免空集合比较掩盖复制时的丢失。
  const topic = f.manifest.topics!.topics[0]!, candidate = topic.point_ids.shift()!
  expect(topic.point_ids.length).toBeGreaterThan(0)
  f.manifest.topics!.candidates = [[candidate]]
  f.manifest.topics!.excluded_members = { [topic.id]: { [candidate]: { content_hash: f.manifest.sources[0]!.content_hash, reason: '范围不同' } } }
  f.manifest.version = 'v000002'; f.manifest.topics!.version = f.manifest.version
  for (const page of Object.values(f.manifest.deps!.pages)) for (const child of page.children ?? []) child.version = f.manifest.version
  await writeVersion(f.root, f.manifest); await writeJson(f.root, 'state/topics.json', f.manifest.topics)
  await writeJson(f.root, 'state/current.json', { version: f.manifest.version, revocation_generation: f.manifest.revocation_generation, history: ['v000001'] })
  await writeJson(f.root, 'work/ongoing.json', { source: '进行中的作业' })
  await fs.writeFile(await safePath(f.root, 'logs/ongoing.lock'), '源库锁')
  const result = await copyWithEmbedding(f.root, target, true, { embeddingClient: b, settings: f.options.topics || {} })
  expect(await hashes(result.path, 'wiki')).toEqual(pages); expect(await hashes(result.path, 'objects/pages')).toEqual(objects)
  await expect(fs.stat(await safePath(result.path, 'work/ongoing.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(fs.stat(await safePath(result.path, 'logs/ongoing.lock'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await fs.readFile(await safePath(f.root, 'logs/ongoing.lock'), 'utf8')).toBe('源库锁')
  const next = await snapshotManifest(result.path)
  const preserved = (manifest: typeof next) => hash(JSON.stringify({ topics: manifest.topics!.topics, candidates: manifest.topics!.candidates,
    excluded: manifest.topics!.excluded_members, sections: Object.values(manifest.deps!.pages).flatMap(p => p.terms ?? []).map(t => t.sections) }))
  expect(preserved(next)).toBe(preserved(f.manifest))
  expect(next.topics!.topics).toEqual(f.manifest.topics!.topics)
  expect(next.topics!.candidates).toEqual(f.manifest.topics!.candidates); expect(next.topics!.excluded_members).toEqual(f.manifest.topics!.excluded_members)
  expect(Object.values(next.deps!.pages).flatMap(p => p.terms ?? []).map(t => t.sections)).toEqual(Object.values(f.manifest.deps!.pages).flatMap(p => p.terms ?? []).map(t => t.sections))
  expect(next.vector_state!.identity!.model).toBe(target.localEmbeddingModel)
  const state = await hydrateVectors(result.path, structuredClone(next.topics)), previous = structuredClone(state!)
  updateTopicCandidates(state!, previous, layeredSettings({ ...f.options.topics || {}, ...target }), new Set())
  expect(state!.clustering_fingerprint).toBe(next.topics!.clustering_fingerprint)
  b.embed.mockClear()
  const updated = await buildLayeredLibrary({ ...f.options, wikiPath: result.path, name: result.name, topics: { ...f.options.topics || {}, ...target }, embeddingClient: b })
  expect(updated.unchanged).toBe(true); expect(b.embed).not.toHaveBeenCalled(); expect(f.call).not.toHaveBeenCalled()
  expect(await hashes(result.path, 'wiki')).toEqual(pages); expect(await snapshotManifest(f.root)).toEqual(f.manifest)
})
it('旧布局也可独立复制，目标已存在和未确认均拒绝', async () => {
  const f = await fixture(false), result = await copyWithEmbedding(f.root, target, true, { embeddingClient: clientB(), settings: f.options.topics || {} })
  expect(await hashes(result.path, 'wiki')).toEqual(await hashes(f.root, 'wiki'))
  await expect(copyWithEmbedding(f.root, target, true)).rejects.toThrow('已存在')
  await expect(copyWithEmbedding(f.root, target, false)).rejects.toThrow('显式确认')
})
it('嵌入或登记中途失败，源库不变且目标清理', async () => {
  const f = await fixture(), b = clientB()
  b.embed.mockRejectedValue(new Error('嵌入中断'))
  await expect(copyWithEmbedding(f.root, target, true, { embeddingClient: b })).rejects.toThrow('嵌入中断')
  await expect(fs.stat(path.join(f.knowledgeRoot, '.llmwiki-qwen3-06b'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(copyWithEmbedding(f.root, target, true, { embeddingClient: clientB(), register: async () => { throw new Error('登记冲突') } })).rejects.toThrow('登记冲突')
  expect(await snapshotManifest(f.root)).toEqual(f.manifest)
  await expect(fs.stat(path.join(f.knowledgeRoot, '.llmwiki-qwen3-06b'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('登记识别身份并提示目录不一致，缺模型更新暂停、查询全文降级', async () => {
  const f = await fixture(), locked = await registeredEmbedding(f.root)
  expect(locked.embeddingSettings?.localEmbeddingModel).toBe('qwen3-embedding:8b')
  const renamed = path.join(f.knowledgeRoot, '.llmwiki-wrong'); await fs.rename(f.root, renamed)
  expect((await registeredEmbedding(renamed)).embeddingNotice).toContain('不一致')
  const unavailable = { identity: async () => { throw new Error('未安装') }, embed: vi.fn() }
  await expect(buildLayeredLibrary({ ...f.options, wikiPath: renamed, embeddingClient: unavailable, topics: target })).rejects.toThrow('ollama pull qwen3-embedding:8b')
  expect(f.call).not.toHaveBeenCalled()
  const query = await new LayeredQuery(unavailable).search({ ...f.library, name: '测试库', layered: target }, { root: renamed, card: f.manifest.card! }, '研究结果')
  expect(query.degradation).toBeDefined(); expect(query.value.every(hit => hit.retrieval === 'fts')).toBe(true)
})
it('副本增量只提取新来源，原主题成员保留并复用旧向量', async () => {
  const f = await fixture(), b = clientB(), result = await copyWithEmbedding(f.root, target, true, { embeddingClient: b, settings: f.options.topics || {} })
  f.call.mockClear(); b.embed.mockClear()
  await fs.writeFile(path.join(f.knowledgeRoot, 'b.md'), '# 乙组\n\n乙组的新增研究结果。')
  await buildLayeredLibrary({ ...f.options, wikiPath: result.path, name: result.name, topics: { ...f.options.topics || {}, ...target }, embeddingClient: b })
  const next = await snapshotManifest(result.path)
  expect(f.call.mock.calls.filter(args => JSON.parse(args[2]).paragraphs).every(args => !args[2].includes('甲组的研究结果'))).toBe(true)
  expect(b.embed.mock.calls.flatMap(args => args[0]).every(text => !text.includes('甲组的研究结果'))).toBe(true)
  for (const topic of f.manifest.topics!.topics) expect(next.topics!.topics.find(t => t.id === topic.id)?.point_ids).toEqual(expect.arrayContaining(topic.point_ids))
})
