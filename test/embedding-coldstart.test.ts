import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { LayeredQuery } from '../src/wiki/layered-query.js'
import { EmbeddingReadiness, embeddingReadyIdleMs } from '../src/layered/embedding-readiness.js'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { buildConfiguration } from '../src/layered/build-configuration.js'
import { buildRegistrationKey } from '../src/domain/build-identity.js'
import { emptyRegistry, layeredSettings, newLibrary, parseRegistry } from '../src/domain/config.js'
import { parseLocalConfig } from '../src/local/config.js'
import { exportConfig, importConfig } from '../src/domain/config-io.js'
import { cleanupLayeredFixtures, layeredTopicFixture, snapshotManifest } from './layered-fixture.js'
import type { EmbeddingClient } from '../src/layered/schema.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
const readiness = new EmbeddingReadiness()
beforeEach(() => { vi.spyOn(console, 'warn').mockImplementation(() => {}); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('测试禁止真实网络') })) })
afterEach(() => { readiness.cancel(); vi.useRealTimers(); cleanupLayeredFixtures(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const clock = () => vi.useFakeTimers({ toFake: ['Date', 'performance', 'setTimeout', 'clearTimeout'] })
const delay = (ms: number) => new Promise<number[][]>(resolve => setTimeout(() => resolve([[1, 0]]), ms))
async function fixture() {
  const f = await layeredTopicFixture()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组的研究结果。')
  await buildLayeredLibrary(f.options)
  const manifest = await snapshotManifest(f.root), settings = layeredSettings(f.library.layered)
  const embed = vi.fn<EmbeddingClient['embed']>(async input => input.map(() => [1, 0]))
  const client = { identity: vi.fn(async () => 'fixture-weights-v1'), embed }, query = new LayeredQuery(client, readiness)
  const search = (signal?: AbortSignal) => query.search(f.library, { root: f.root, card: manifest.card! }, '研究结果', undefined, signal)
  return { ...f, settings, embed, client, search }
}
async function called(mock: { mock: { calls: unknown[] } }, count: number) { while (mock.mock.calls.length < count) await setImmediate() }

it('冷态首查四秒使用向量，就绪后两秒超时保持原降级文案', async () => {
  const f = await fixture(); clock(); f.embed.mockImplementation(() => delay(4000))
  const first = f.search(); await called(f.embed, 1); await vi.advanceTimersByTimeAsync(4000)
  const result = await first
  expect(result.degradation).toBeUndefined(); expect(result.value.some(hit => hit.retrieval === 'hybrid')).toBe(true)
  expect(readiness.state(f.settings).status).toBe('ready')
  f.embed.mockImplementation(() => new Promise(() => {}))
  const next = f.search(); await called(f.embed, 2); await vi.advanceTimersByTimeAsync(2000)
  expect((await next).degradation).toMatchObject({ stage: 'embedding', retrieval: 'fts', reason: '向量请求超时（查询最多等待 2 秒）', message: '已降级为关键词检索：向量请求超时（查询最多等待 2 秒）' })
})

it('冷态十秒超时不缓存一分钟，下次等待共享预热后恢复向量', async () => {
  const f = await fixture(); clock()
  f.embed.mockImplementationOnce(() => new Promise(() => {})).mockImplementationOnce(() => delay(4000))
  const first = f.search(); await called(f.embed, 1); await vi.advanceTimersByTimeAsync(10000)
  expect((await first).degradation?.reason).toBe('向量请求超时（查询最多等待 10 秒）')
  await vi.advanceTimersByTimeAsync(1); await called(f.embed, 2)
  expect(f.embed.mock.calls[1]![0]).toEqual(['a'])
  const next = f.search(); await setImmediate(); expect(f.embed).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(4000)
  const result = await next
  expect(result.degradation).toBeUndefined(); expect(result.value.some(hit => hit.retrieval === 'hybrid')).toBe(true)
  expect(f.embed).toHaveBeenCalledTimes(3)
})

it('连接拒绝仍缓存六十秒，过期后恢复且不启动预热', async () => {
  const f = await fixture(); clock(); f.embed.mockRejectedValue(new TypeError('ECONNREFUSED'))
  expect((await f.search()).degradation?.reason).toBe('向量服务连接失败')
  await vi.advanceTimersByTimeAsync(59999)
  expect((await f.search()).degradation?.reason).toBe('向量服务连接失败'); expect(f.embed).toHaveBeenCalledTimes(1)
  f.embed.mockImplementation(async inputs => inputs.map(() => [1, 0])); await vi.advanceTimersByTimeAsync(1)
  expect((await f.search()).degradation).toBeUndefined(); expect(f.embed).toHaveBeenCalledTimes(2)
})

it('首查复用进行中的预热，用户取消不取消其他查询共享的预热', async () => {
  const f = await fixture(); clock(); f.settings.embeddingMode = 'ollama'
  f.embed.mockImplementationOnce(() => delay(4000))
  const warmed = readiness.warm(f.settings, f.client); await vi.advanceTimersByTimeAsync(0)
  const abort = new AbortController(), cancelled = f.search(abort.signal), rejected = expect(cancelled).rejects.toThrow('用户取消')
  await setImmediate(); abort.abort(new Error('用户取消')); await rejected
  expect(readiness.state(f.settings).status).toBe('warming')
  const next = f.search(); await setImmediate(); expect(f.embed).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(4000); await warmed
  expect((await next).degradation).toBeUndefined(); expect(f.embed).toHaveBeenCalledTimes(2)
})

it('五分钟未成功嵌入恢复冷态，端点和模型之间不共享就绪状态', async () => {
  const f = await fixture(); clock(); readiness.ready(f.settings)
  expect(readiness.state({ ...f.settings, localEmbeddingUrl: 'http://other.invalid' }).status).toBe('unknown')
  expect(readiness.state({ ...f.settings, localEmbeddingModel: 'other' }).status).toBe('unknown')
  await vi.advanceTimersByTimeAsync(embeddingReadyIdleMs)
  expect(readiness.state(f.settings).status).toBe('unknown')
  f.embed.mockImplementation(() => delay(4000))
  const next = f.search(); await called(f.embed, 1); await vi.advanceTimersByTimeAsync(4000)
  expect((await next).degradation).toBeUndefined()
})

it('本地配置校验查询时限并保持导入导出及内容身份', () => {
  const library = newLibrary('cold-settings'); library.wikiPath = 'C:/cold-settings/wiki'; library.layered = {}
  library.mode = 'readonly'
  const registry = { ...emptyRegistry(), activeLibraryId: library.id, libraries: [library] }
  const loaded = layeredSettings(parseLocalConfig({ registry }).registry.libraries[0]!.layered)
  expect(loaded).toMatchObject({ queryEmbeddingTimeoutMs: 2000, queryEmbeddingColdTimeoutMs: 10000 })
  for (const field of ['queryEmbeddingTimeoutMs', 'queryEmbeddingColdTimeoutMs'] as const) {
    for (const invalid of [0, -1, 1.5, NaN, 2147483648]) {
      const bad = { ...registry, libraries: [{ ...library, layered: { [field]: invalid } }] }
      expect(() => parseRegistry(bad)).toThrow('查询向量')
      expect(() => parseLocalConfig({ registry: bad })).toThrow()
    }
  }
  expect(() => layeredSettings({ queryEmbeddingTimeoutMs: 4000, queryEmbeddingColdTimeoutMs: 3000 })).toThrow('不能短于')
  const changed = { ...library, layered: { queryEmbeddingTimeoutMs: 3000, queryEmbeddingColdTimeoutMs: 12000 } }
  expect(importConfig(exportConfig({ ...registry, libraries: [changed] }), emptyRegistry(), 'replace').libraries[0]!.layered).toEqual(changed.layered)
  expect(buildRegistrationKey(changed)).toBe(buildRegistrationKey(library))
  expect(buildConfiguration(layeredSettings(changed.layered))).toBe(buildConfiguration(layeredSettings()))
})
