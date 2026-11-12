import { afterEach, expect, it, vi } from 'vitest'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import * as vectors from '../src/layered/vectors.js'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { updateVectorCoverage } from '../src/layered/vector-build.js'
import { readExtraction } from '../src/layered/publication.js'
import { LayeredQuery } from '../src/wiki/layered-query.js'
import { embeddingReadiness } from '../src/layered/embedding-readiness.js'
import { layeredSettings } from '../src/domain/config.js'
import { cleanupLayeredFixtures, layeredTopicFixture, snapshotManifest } from './layered-fixture.js'
import type { PendingBuild } from '../src/layered/schema.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => { embeddingReadiness.cancel(); vi.useRealTimers(); cleanupLayeredFixtures() })

it('少量未核实要点缺向量时保留混合检索，冷暖查询均只嵌入查询词', async () => {
  const f = await layeredTopicFixture(), original = f.call.getMockImplementation()!
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组的研究结果。')
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (input.review_stage === 'extraction') return JSON.stringify({ items: input.points.map((point: { id: string }, index: number) => ({ id: point.id,
      support: index ? '完整支撑' : '不支撑', missing: index ? '' : '缺少限定条件' })) })
    if (input.review_stage === 'extraction-correction') return JSON.stringify({ items: input.items.map((item: { id: string; validationFeedback: { item: { evidence: unknown[] } } }) => ({
      id: item.id, evidence: item.validationFeedback.item.evidence, support: '不支撑', missing: '缺少限定条件',
    })) })
    return original(...args)
  })
  await buildLayeredLibrary(f.options)
  const manifest = await snapshotManifest(f.root), extract = await readExtraction(f.root, manifest.sources[0]!.extract.path)
  expect(extract.segments.flatMap(segment => segment.points).filter(point => point.verification?.status === 'unverified')).toHaveLength(1)
  expect(manifest.vector_state!.coverage).toMatchObject({ embedded: expect.any(Array), missing: expect.any(Array) })
  expect(manifest.vector_state!.coverage.embedded).toHaveLength(3); expect(manifest.vector_state!.coverage.missing).toHaveLength(1)
  const embed = vi.fn(async (inputs: string[]) => inputs.map(() => [1, 0])), query = new LayeredQuery({ identity: f.options.embeddingClient!.identity!, embed })
  for (let round = 0; round < 2; round++) {
    const result = await query.search(f.library, { root: f.root, card: manifest.card! }, '研究结果')
    expect(result.degradation).toBeUndefined()
    expect(result.value.find(hit => hit.type === 'source')?.retrieval).toBe('hybrid')
    expect(result.notices).toContainEqual(expect.objectContaining({ reason: 'partial-coverage', message: expect.stringContaining('3/4') }))
  }
  expect(embed.mock.calls.map(call => call[0])).toEqual(Array(2).fill(['Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: 研究结果']))
})

it('本地向量读盘超过两秒不消耗服务期限，缺件覆盖按实际可用数量标注', async () => {
  const f = await layeredTopicFixture()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组的研究结果。')
  await buildLayeredLibrary(f.options)
  const manifest = await snapshotManifest(f.root), first = Object.values(manifest.topics!.vectors)[0]!
  await unlink(path.join(f.root, vectors.vectorPath(first.vector_id!)))
  const read = vectors.readVectorRecord
  let delayed = false
  embeddingReadiness.ready(layeredSettings(f.library.layered))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  vi.spyOn(vectors, 'readVectorRecord').mockImplementation(async (...args) => {
    if (!delayed) { delayed = true; await vi.advanceTimersByTimeAsync(2100) }
    return read(...args)
  })
  const embed = vi.fn(async (inputs: string[]) => inputs.map(() => [1, 0]))
  const result = await new LayeredQuery({ identity: f.options.embeddingClient!.identity!, embed }).search(f.library, { root: f.root, card: manifest.card! }, '研究结果')
  expect(delayed).toBe(true); expect(result.degradation).toBeUndefined()
  expect(result.value.find(hit => hit.type === 'source')?.retrieval).toBe('hybrid')
  expect(result.notices).toContainEqual(expect.objectContaining({ reason: 'partial-coverage', message: expect.stringContaining('3/4') }))
  expect(embed).toHaveBeenCalledTimes(1)
  expect(embed.mock.calls[0]![0]).toEqual(['Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: 研究结果'])
})

it('覆盖统计复用本轮暖缓存校验，下一轮仍识别物理缺件且不触发嵌入', async () => {
  const f = await layeredTopicFixture()
  // 独立标题保留两个来源，正文相同使八条要点继续共享四个向量对象。
  for (const name of ['a', 'b']) await writeFile(path.join(f.knowledgeRoot, name + '.md'), '# 资料' + name + '\n\n甲组同一研究结果。')
  await buildLayeredLibrary({ ...f.options, publish: false })
  const pending = JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8')) as PendingBuild
  const ids = [...new Set(Object.values(pending.topics!.state.vectors).map(ref => ref.vector_id!))]
  const read = vi.spyOn(vectors, 'readVectorRecord'); f.embed.mockClear()
  await updateVectorCoverage(f.root, pending)
  expect(read.mock.calls.map(call => call[1]).sort()).toEqual(ids.toSorted())
  expect(pending.manifest.vector_state!.coverage.embedded).toHaveLength(8)
  await unlink(path.join(f.root, vectors.vectorPath(ids[0]!))); read.mockClear()
  await updateVectorCoverage(f.root, pending)
  // 缺件同时核对暖缓存及清单旧引用，其余共享对象只读一次。
  expect(read.mock.calls.map(call => call[1]).sort()).toEqual([...ids, ids[0]!].sort())
  expect(pending.manifest.vector_state!.coverage.missing).toHaveLength(2)
  expect(pending.manifest.vector_state!.coverage.embedded).toHaveLength(6)
  expect(f.embed).not.toHaveBeenCalled()
})

it('身份检测与查询嵌入共享两秒服务预算，不因分段计时延长期限', async () => {
  const f = await layeredTopicFixture()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组的研究结果。')
  await buildLayeredLibrary(f.options)
  const manifest = await snapshotManifest(f.root)
  embeddingReadiness.ready(layeredSettings(f.library.layered))
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] })
  const identity = vi.fn(async () => { await new Promise(resolve => setTimeout(resolve, 1200)); return 'fixture-weights-v1' })
  const embed = vi.fn(async () => new Promise<number[][]>(() => {}))
  let completed = false
  const pending = new LayeredQuery({ identity, embed }).search(f.library, { root: f.root, card: manifest.card! }, '研究结果').then(value => { completed = true; return value })
  while (!identity.mock.calls.length) await setImmediate()
  await vi.advanceTimersByTimeAsync(1200)
  while (!embed.mock.calls.length) await setImmediate()
  await vi.advanceTimersByTimeAsync(799); expect(completed).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  const result = await pending
  expect(result.degradation?.reason).toContain('超时')
  expect(result.value.every(hit => hit.retrieval === 'fts')).toBe(true)
  expect(identity).toHaveBeenCalledTimes(1); expect(embed).toHaveBeenCalledTimes(1)
})
