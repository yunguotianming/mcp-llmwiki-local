import { readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { layeredSettings } from '../src/domain/config.js'
import { embedPoints, OllamaEmbeddingClient } from '../src/layered/embedding.js'
import { buildLayeredLibrary, readLayeredPage } from '../src/layered/index.js'
import type { Point } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, layeredIncrementalFixture, layeredFixture } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => { vi.useRealTimers(); cleanupLayeredFixtures() })
const response: typeof fetch = async (_url, init) => new Response(JSON.stringify({
  embeddings: (JSON.parse(String(init!.body)).input as string[]).map(() => [1, 0]),
}))

it('熔断超时才暂停且指针不变，成功批次持久化，续跑提取零调用并只补失败批次', async () => {
  const f = await layeredIncrementalFixture()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组旧证据。')
  await buildLayeredLibrary(f.options)
  const currentPath = path.join(f.root, 'state/current.json'), current = await readFile(currentPath, 'utf8')
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '甲组新增一。\n\n甲组新增二。\n\n甲组新增三。')
  const failed = Promise.withResolvers<void>()
  const request = vi.fn<typeof fetch>().mockImplementationOnce(response).mockImplementation(async () => {
    failed.resolve(); throw new TypeError('fetch failed')
  })
  const settings = layeredSettings({ embeddingBatchSize: 1 })
  f.options.topics = settings; f.options.embeddingClient = new OllamaEmbeddingClient(settings, request)
  vi.spyOn(f.options.embeddingClient, 'identity').mockResolvedValue('fixture-weights-v1')
  f.topicRequests.length = 0
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  let settled = false
  const running = buildLayeredLibrary(f.options).then(() => undefined, error => error).finally(() => { settled = true })
  await failed.promise
  await vi.advanceTimersByTimeAsync(1999); expect(request).toHaveBeenCalledTimes(2); expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(1); expect(request).toHaveBeenCalledTimes(3); expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(3999); expect(request).toHaveBeenCalledTimes(3); expect(settled).toBe(false)
  expect(await readFile(currentPath, 'utf8')).toBe(current)
  await vi.advanceTimersByTimeAsync(1)
  expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(8000)
  expect(request).toHaveBeenCalledTimes(5); expect(settled).toBe(false)
  await vi.advanceTimersByTimeAsync(600000)
  expect(await running).toMatchObject({ message: '本地向量模型不可用，主题聚类已暂停。' })
  expect(request.mock.calls.length).toBeGreaterThan(5); expect(f.topicRequests).toHaveLength(0)
  expect(await readFile(currentPath, 'utf8')).toBe(current)
  const cache = JSON.parse(await readFile(path.join(f.root, 'state/embeddings.json'), 'utf8'))
  expect(Object.keys(cache.vectors)).toHaveLength(2)
  expect(vi.getTimerCount()).toBe(0); vi.useRealTimers()
  f.requests.length = 0; f.call.mockClear(); request.mockReset().mockImplementation(response)
  const resumed = await buildLayeredLibrary(f.options)
  expect(f.requests).toHaveLength(0); expect(f.topicRequests).toHaveLength(1)
  expect(request.mock.calls.flatMap(call => JSON.parse(String(call[1]!.body)).input)).toEqual(['甲组新增二。', '甲组新增三。'])
  expect(resumed.version).not.toBe(JSON.parse(current).version)
})

it('缓存命中零请求，新增仅嵌入新要点；派生状态与缓存丢失可重建且正文不变', async () => {
  const f = await layeredIncrementalFixture()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组缓存证据。')
  await buildLayeredLibrary(f.options)
  const page = await readLayeredPage(f.knowledgeRoot, 'topics/T-0001.md')
  await unlink(path.join(f.root, 'state/topics.json'))
  f.embed.mockClear(); f.call.mockClear()
  await buildLayeredLibrary(f.options)
  expect(f.embed).not.toHaveBeenCalled(); expect(f.call).not.toHaveBeenCalled()
  expect(await readLayeredPage(f.knowledgeRoot, 'topics/T-0001.md')).toBe(page)
  // 未变化快路径无需重建派生文件，已发布清单仍持有完整向量引用。
  await unlink(path.join(f.root, 'state/embeddings.json'))
  await buildLayeredLibrary(f.options)
  expect(f.embed).not.toHaveBeenCalled()
  expect(f.call).not.toHaveBeenCalled(); expect(await readLayeredPage(f.knowledgeRoot, 'topics/T-0001.md')).toBe(page)
  f.embed.mockClear(); f.requests.length = 0
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '甲组仅新增。')
  await buildLayeredLibrary(f.options)
  // 缓存已主动删除，首次发生增量时重建旧点与新点；来源提取仍只处理新增。
  expect(f.embed.mock.calls.flatMap(call => call[0]).sort()).toEqual(['甲组仅新增。', '甲组缓存证据。'].sort())
  expect(f.requests).toHaveLength(1)
})

it('缓存键跨要点 ID 去重，区分文本、模型和提供方，缓存损坏后重新计算', async () => {
  const f = await layeredFixture(), settings = layeredSettings()
  // 嵌入只消费 ID 和文本，其余证据字段由提取层验证。
  const point = (point_id: string, text: string) => ({ point_id, text }) as Point
  const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]))
  const run = (points: Point[], model = settings.localEmbeddingModel) => embedPoints(f.root, points,
    { ...settings, localEmbeddingModel: model }, { embed, identity: async () => 'fixture-weights-v1' }, {})
  await run([point('甲', '相同文本')]); embed.mockClear()
  await run([point('甲', '相同文本')]); expect(embed).not.toHaveBeenCalled()
  await run([point('乙', '相同文本')]); expect(embed).not.toHaveBeenCalled(); embed.mockClear()
  await run([point('甲', '修改文本')]); expect(embed).toHaveBeenCalledTimes(1); embed.mockClear()
  await run([point('甲', '相同文本')], '另一个模型'); expect(embed).toHaveBeenCalledTimes(1); embed.mockClear()
  await embedPoints(f.root, [point('甲', '相同文本')], { ...settings, localEmbeddingUrl: 'http://mock.invalid' }, { embed, identity: async () => 'fixture-weights-v1' }, {})
  expect(embed).toHaveBeenCalledTimes(1); embed.mockClear()
  await writeFile(path.join(f.root, 'state/embeddings.json'), '{损坏')
  await run([point('甲', '相同文本')]); expect(embed).toHaveBeenCalledTimes(1)
})
