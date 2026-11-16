import { afterEach, expect, it, vi } from 'vitest'
import { layeredSettings } from '../src/domain/config.js'
import { normalized, OllamaEmbeddingClient } from '../src/layered/embedding.js'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })
const response = (embeddings: number[][]) => new Response(JSON.stringify({ embeddings }))
const waitForAbort: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => {
  init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })
})

it('646 条同时受条数与 UTF-8 字节上限约束，串行有序且逐元素等同一次性返回', async () => {
  const settings = layeredSettings(), inputs = Array.from({ length: 646 }, (_, index) => `${index}：` + '中'.repeat(index < 320 ? 5 : 700))
  const vector = (text: string) => [(Number(text.split('：')[0]) || 0) + 1, 2, 3]
  let active = 0, peak = 0
  const batches: string[][] = []
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    active++; peak = Math.max(peak, active)
    const input = JSON.parse(String(init!.body)).input as string[]
    batches.push(input); await Promise.resolve(); active--
    return response(input.map(vector))
  })
  expect(await new OllamaEmbeddingClient(settings, request).embed(inputs)).toEqual(inputs.map(text => normalized(vector(text))))
  expect(batches.flat()).toEqual(inputs); expect(peak).toBe(1)
  expect(batches.slice(0, 10).every(batch => batch.length === 32)).toBe(true)
  expect(batches.slice(10, -1).every(batch => batch.length === 15)).toBe(true)
  expect(batches.every(batch => batch.length <= 32 && batch.reduce((sum, text) => sum + Buffer.byteLength(text), 0) <= 32768)).toBe(true)
  request.mockClear(); batches.length = 0
  await new OllamaEmbeddingClient({ embeddingBatchSize: 2, embeddingBatchBytes: 6 }, request).embed(['中', '文', '甲乙', 'a'])
  expect(batches).toEqual([['中', '文'], ['甲乙'], ['a']])
  request.mockClear()
  await expect(new OllamaEmbeddingClient({ embeddingBatchBytes: 2 }, request).embed(['中'])).rejects.toThrow('暂停')
  expect(request).not.toHaveBeenCalled()
  expect(settings).toMatchObject({ embeddingBatchSize: 32, embeddingBatchBytes: 32768, embeddingTimeoutMs: 120000 })
  for (const key of ['embeddingBatchSize', 'embeddingBatchBytes', 'embeddingTimeoutMs'] as const) {
    for (const value of [0, -1, 1.5, NaN, Infinity]) expect(() => layeredSettings({ [key]: value })).toThrow()
  }
})

it('单批超时后等待 2 秒成功，前批不重发且超时定时器释放', async () => {
  vi.useFakeTimers()
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response([[1, 0]]))
    .mockImplementationOnce(waitForAbort).mockResolvedValueOnce(response([[0, 1]]))
  const pending = new OllamaEmbeddingClient({ embeddingBatchSize: 1, embeddingTimeoutMs: 1234 }, request).embed(['甲', '乙'])
  await vi.advanceTimersByTimeAsync(1233); expect(request).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1); expect(request).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1999); expect(request).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1)
  expect(await pending).toEqual([[1, 0], [0, 1]])
  expect(request.mock.calls.map(call => JSON.parse(String(call[1]!.body)).input)).toEqual([['甲'], ['乙'], ['乙']])
  expect(vi.getTimerCount()).toBe(0)
})

it('连接失败按 2/4 秒退避，第三次成功；HTTP 和非法响应立即暂停', async () => {
  vi.useFakeTimers()
  const request = vi.fn<typeof fetch>().mockRejectedValueOnce(new TypeError('fetch failed'))
    .mockRejectedValueOnce(new TypeError('fetch failed')).mockResolvedValueOnce(response([[3, 4]]))
  const pending = new OllamaEmbeddingClient({}, request).embed(['甲'])
  await vi.advanceTimersByTimeAsync(1999); expect(request).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1); expect(request).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(3999); expect(request).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1); expect(await pending).toEqual([[0.6, 0.8]])
  for (const invalid of [new Response('', { status: 503 }), response([]), response([[0, 0]]), new Response('null')]) {
    request.mockReset().mockResolvedValueOnce(invalid)
    await expect(new OllamaEmbeddingClient({}, request).embed(['甲'])).rejects.toThrow('暂停')
    expect(request).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0)
  }
})

it('请求中取消与预先取消均保留取消原因，不重试也不发送后续批次', async () => {
  vi.useFakeTimers()
  const controller = new AbortController(), reason = new Error('用户取消')
  const request = vi.fn<typeof fetch>(waitForAbort), client = new OllamaEmbeddingClient({ embeddingBatchSize: 1 }, request)
  const pending = client.embed(['甲', '乙'], controller.signal)
  const rejected = expect(pending).rejects.toBe(reason)
  await vi.advanceTimersByTimeAsync(0)
  controller.abort(reason); await rejected
  await vi.advanceTimersByTimeAsync(200000)
  expect(request).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0)
  request.mockClear()
  await expect(client.embed(['甲'], controller.signal)).rejects.toBe(reason)
  expect(request).not.toHaveBeenCalled()
})

it('退避期间取消立即停止，不等满退避且不重试', async () => {
  vi.useFakeTimers()
  const controller = new AbortController(), reason = new Error('取消退避')
  const request = vi.fn<typeof fetch>().mockRejectedValue(new TypeError('fetch failed'))
  const pending = new OllamaEmbeddingClient({}, request).embed(['甲'], controller.signal)
  const rejected = expect(pending).rejects.toBe(reason)
  await vi.advanceTimersByTimeAsync(0); controller.abort(reason); await rejected
  await vi.advanceTimersByTimeAsync(6000)
  expect(request).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0)
})
