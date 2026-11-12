import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { layeredSettings } from '../src/domain/config.js'
import { embedInputs } from '../src/layered/embedding.js'
import { hash } from '../src/layered/files.js'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { cleanupLayeredFixtures, layeredFixture, layeredIncrementalFixture } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
// 夹具不读取宿主 MachineGuid；设备登记不是本文件验证对象。
vi.mock('../src/layered/devices.js', async original => ({
  ...await original<typeof import('../src/layered/devices.js')>(),
  localDevice: async () => ({ id: 'pipeline-embedding-device', name: 'pipeline-embedding' }),
  checkWriter: async () => {},
  claimWriter: async () => {},
}))
afterEach(() => { vi.useRealTimers(); cleanupLayeredFixtures() })
const waitForCache = async (file: string): Promise<{ vectors: Record<string, { vector_id: string; input_hash: string }> }> => {
  for (let attempt = 0; attempt < 2000; attempt++) {
    try {
      const value = JSON.parse(await readFile(file, 'utf8')) as { vectors: Record<string, { vector_id: string; input_hash: string }> }
      if (Object.keys(value.vectors).length) return value
    } catch { /* 首次写入前继续等待，不使用测试超时。 */ }
    await setImmediate()
  }
  throw new Error('缓存未写入。')
}

for (const concurrency of [30, 3, 1]) it(`快来源核对完成即预嵌入，慢来源未完成不阻塞且全量向量齐备后才聚类（${concurrency}路）`, async () => {
  const f = await layeredIncrementalFixture()
  f.policy.pageGenerationConcurrency = concurrency
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '快来源的已核实要点。')
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '慢来源的已核实要点。')
  const fastEmbedded = Promise.withResolvers<void>(), slowReviewStarted = Promise.withResolvers<void>(), releaseSlow = Promise.withResolvers<void>()
  const embed = vi.fn(async (texts: string[]) => {
    if (texts.includes('快来源的已核实要点。')) fastEmbedded.resolve()
    return texts.map(text => text.includes('快') ? [1, 0] : [0, 1])
  })
  f.options.embeddingClient = { identity: async () => 'precompute-weights', embed }
  const original = f.call.getMockImplementation()!
  f.call.mockImplementation(async (...args: any[]) => {
    const input = JSON.parse(String(args[2])) as { review_stage?: string; source_id?: string }
    if (input.review_stage === 'extraction' && input.source_id === 'S-0002') {
      slowReviewStarted.resolve()
      await releaseSlow.promise
    }
    return original(...args)
  })
  const building = buildLayeredLibrary(f.options)
  await slowReviewStarted.promise
  await fastEmbedded.promise
  // 快来源的向量已写入，但慢来源核对尚未完成，此时不得开始聚类。
  expect(f.topicRequests).toHaveLength(0)
  releaseSlow.resolve()
  const built = await building
  expect(built.version).toBeTruthy()
  expect(f.topicRequests.length).toBeGreaterThan(0)
  const texts = embed.mock.calls.flatMap(call => call[0])
  expect(texts.filter(text => text === '快来源的已核实要点。')).toHaveLength(1)
  expect(texts.filter(text => text === '慢来源的已核实要点。')).toHaveLength(1)
  const cache = JSON.parse(await readFile(path.join(f.root, 'state/embeddings.json'), 'utf8')) as { vectors: Record<string, unknown> }
  expect(Object.keys(cache.vectors)).toHaveLength(2)
})

for (const concurrency of [30, 3, 1]) it(`并发嵌入同文本零重复、不同文本并发写入不丢（${concurrency}路）`, async () => {
  const f = await layeredFixture()
  await mkdir(f.root, { recursive: true })
  const settings = layeredSettings({ embeddingBatchSize: 1 })
  const calls: string[] = []
  const client = { identity: async () => 'concurrent-weights', embed: async (texts: string[]) => {
    calls.push(...texts)
    await setImmediate()
    return texts.map(() => [1, 0])
  } }
  const shared = '并发共享文本', groupA = [shared, ...Array.from({ length: 14 }, (_, index) => `甲组独立文本${index}`)],
    groupB = [shared, ...Array.from({ length: 14 }, (_, index) => `乙组独立文本${index}`)]
  const all = [...new Set([...groupA, ...groupB])]
  const runs = await Promise.all([
    ...Array.from({ length: 3 }, () => embedInputs(f.root, groupA, settings, client, undefined, concurrency)),
    ...Array.from({ length: 3 }, () => embedInputs(f.root, groupB, settings, client, undefined, concurrency)),
  ])
  // 同一文本只请求一次；两个并发写者的不同文本都必须留在最终索引中。
  expect(calls.sort()).toEqual([...all].sort())
  const vectors = new Map<string, string>()
  runs.forEach((run, index) => run.forEach((reference, offset) => {
    const input = (index < 3 ? groupA : groupB)[offset]!
    expect(vectors.get(input) ?? reference.vector_id).toBe(reference.vector_id)
    vectors.set(input, reference.vector_id)
  }))
  expect(vectors.size).toBe(all.length)
  const cache = JSON.parse(await readFile(path.join(f.root, 'state/embeddings.json'), 'utf8')) as { vectors: Record<string, unknown> }
  expect(Object.keys(cache.vectors)).toHaveLength(all.length)
})

for (const concurrency of [30, 3, 1]) it(`取消后保留已完成向量，续跑只补缺失且不重复（${concurrency}路）`, async () => {
  const f = await layeredFixture()
  await mkdir(f.root, { recursive: true })
  const settings = layeredSettings({ embeddingBatchSize: 1 })
  const inputs = ['取消前已完成。', '取消时在途。', '取消后未开始。']
  const blocked = Promise.withResolvers<void>()
  const first = { identity: async () => 'cancel-weights', embed: async (texts: string[], signal?: AbortSignal) => {
    if (texts.includes('取消时在途。')) {
      blocked.resolve()
      await new Promise<never>((_, reject) => {
        if (signal?.aborted) return reject(signal.reason)
        signal?.addEventListener('abort', () => reject(signal!.reason), { once: true })
      })
    }
    await setImmediate()
    return texts.map(() => [1, 0])
  } }
  const controller = new AbortController(), reason = new Error('用户取消')
  const running = embedInputs(f.root, inputs, settings, first, controller.signal, concurrency)
  await blocked.promise
  await waitForCache(path.join(f.root, 'state/embeddings.json'))
  controller.abort(reason)
  await expect(running).rejects.toBe(reason)
  // 等全部在途写者退出后读取最终检查点；取消前的快照可能漏掉刚完成的另一批。
  const partial = JSON.parse(await readFile(path.join(f.root, 'state/embeddings.json'), 'utf8')) as { vectors: Record<string, unknown> }
  const base = { provider: settings.localEmbeddingUrl, model: settings.localEmbeddingModel, revision: 'cancel-weights', preprocessing: 'utf8-normalized-v1' }
  const key = (input: string) => hash(JSON.stringify([base, hash(input), settings.vectorPrecision]))
  const cached = inputs.filter(input => partial.vectors[key(input)])
  expect(cached.length).toBeGreaterThan(0)
  const secondCalls: string[] = []
  const second = { identity: async () => 'cancel-weights', embed: async (texts: string[]) => {
    secondCalls.push(...texts)
    return texts.map(() => [1, 0])
  } }
  const results = await embedInputs(f.root, inputs, settings, second, undefined, concurrency)
  expect(results).toHaveLength(inputs.length)
  expect(secondCalls.sort()).toEqual(inputs.filter(input => !cached.includes(input)).sort())
  const final = JSON.parse(await readFile(path.join(f.root, 'state/embeddings.json'), 'utf8')) as { vectors: Record<string, unknown> }
  expect(Object.keys(final.vectors)).toHaveLength(inputs.length)
})

for (const concurrency of [30, 3, 1]) it(`不同模型与向量精度隔离缓存和在途去重（${concurrency}路）`, async () => {
  const f = await layeredFixture()
  await mkdir(f.root, { recursive: true })
  const settings = layeredSettings({ embeddingBatchSize: 1 })
  const text = '跨模型同一文本。'
  const callsA: string[] = [], callsB: string[] = []
  const clientA = { identity: async () => 'weights-A', embed: async (texts: string[]) => { callsA.push(...texts); return texts.map(() => [1, 0]) } }
  const clientB = { identity: async () => 'weights-B', embed: async (texts: string[]) => { callsB.push(...texts); return texts.map(() => [0, 1]) } }
  const [a, b] = await Promise.all([
    embedInputs(f.root, [text], settings, clientA, undefined, concurrency),
    embedInputs(f.root, [text], settings, clientB, undefined, concurrency),
  ])
  expect(callsA).toEqual([text])
  expect(callsB).toEqual([text])
  expect(a[0]!.vector_id).not.toBe(b[0]!.vector_id)
  callsA.length = 0
  await embedInputs(f.root, [text], settings, clientA, undefined, concurrency)
  expect(callsA).toEqual([])
  const half = await embedInputs(f.root, [text], { ...settings, vectorPrecision: 'float16' }, clientA, undefined, concurrency)
  expect(callsA).toEqual([text])
  expect(half[0]!.vector_id).not.toBe(a[0]!.vector_id)
  const cache = JSON.parse(await readFile(path.join(f.root, 'state/embeddings.json'), 'utf8')) as { vectors: Record<string, unknown> }
  expect(Object.keys(cache.vectors)).toHaveLength(3)
})
