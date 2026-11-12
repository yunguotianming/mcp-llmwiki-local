import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { layeredSettings } from '../src/domain/config.js'
import { OpenAICompatibleEmbeddingClient } from '../src/layered/cloud-embedding.js'
import { normalized } from '../src/layered/embedding.js'
import { probeIdentity } from '../src/layered/vector-identity.js'

const settings = { embeddingMode: 'cloud' as const, cloudEmbeddingUrl: 'https://embedding.invalid/v1', cloudEmbeddingKeyEnv: 'LLMWIKI_TEST_CLOUD_KEY' }
const response = (vectors: number[][]) => new Response(JSON.stringify({ data: vectors.map((embedding, index) => ({ index, embedding })).reverse() }))
let key: string
beforeEach(() => { key = randomUUID(); vi.stubEnv(settings.cloudEmbeddingKeyEnv, key); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('测试禁止真实网络请求') })) })
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

it('C01 云端请求格式、索引排序、条数与字节分批、规范化身份和探针维度', async () => {
  const request = vi.fn<typeof fetch>(async (_url, init) => response(JSON.parse(String(init!.body)).input.map((text: string) => [text.length, 2])))
  const client = new OpenAICompatibleEmbeddingClient({ ...settings, cloudEmbeddingUrl: 'https://EMBEDDING.invalid:443/v1///', embeddingBatchSize: 2, embeddingBatchBytes: 6 }, request)
  const inputs = ['中', '文', '甲乙', 'a']
  expect(await client.embed(inputs)).toEqual(inputs.map(text => normalized([text.length, 2])))
  expect(request.mock.calls.map(call => JSON.parse(String(call[1]!.body)))).toEqual([
    { model: 'text-embedding-3-small', input: ['中', '文'] }, { model: 'text-embedding-3-small', input: ['甲乙'] }, { model: 'text-embedding-3-small', input: ['a'] },
  ])
  for (const [url, init] of request.mock.calls) {
    expect(url).toBe('https://embedding.invalid/v1/embeddings')
    expect(init).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: 'Bearer ' + key, 'content-type': 'application/json' } })
  }
  expect(await client.identity()).toMatch(/^cloud:sha256:[a-f0-9]{64}$/)
  expect(await client.identity()).toBe(await new OpenAICompatibleEmbeddingClient(settings, request).identity())
  expect(await client.identity()).not.toBe(await new OpenAICompatibleEmbeddingClient({ ...settings, cloudEmbeddingModel: 'other' }, request).identity())
  const identity = await probeIdentity(new OpenAICompatibleEmbeddingClient(settings, request), layeredSettings(settings))
  expect(identity).toMatchObject({ provider: 'cloud', service_url: settings.cloudEmbeddingUrl, model: 'text-embedding-3-small', dimensions: 2 })
  expect(JSON.stringify(identity)).not.toContain(key)
})

it('C02 429、5xx与网络错误有限退避，前一成功批次不重发', async () => {
  vi.useFakeTimers()
  const request = vi.fn<typeof fetch>().mockResolvedValueOnce(response([[1, 0]]))
    .mockResolvedValueOnce(new Response('', { status: 429 })).mockResolvedValueOnce(new Response('', { status: 503 })).mockResolvedValueOnce(response([[0, 1]]))
  const pending = new OpenAICompatibleEmbeddingClient({ ...settings, embeddingBatchSize: 1 }, request).embed(['甲', '乙'])
  await vi.advanceTimersByTimeAsync(1999); expect(request).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(1); expect(request).toHaveBeenCalledTimes(3)
  await vi.advanceTimersByTimeAsync(4000); expect(await pending).toEqual([[1, 0], [0, 1]])
  expect(request.mock.calls.map(call => JSON.parse(String(call[1]!.body)).input)).toEqual([['甲'], ['乙'], ['乙'], ['乙']])
  request.mockReset().mockRejectedValue(new TypeError(key))
  const failure = new OpenAICompatibleEmbeddingClient(settings, request).embed(['甲']).catch(error => error)
  await vi.advanceTimersByTimeAsync(6000)
  expect(request).toHaveBeenCalledTimes(3)
  expect(String(await failure)).not.toContain(key); expect((await failure).cause).toBeUndefined()
  request.mockReset().mockResolvedValueOnce({ ok: true, json: async () => { throw new TypeError(key) } } as Response)
    .mockResolvedValueOnce(response([[1, 0]]))
  const interrupted = new OpenAICompatibleEmbeddingClient(settings, request).embed(['甲'])
  await vi.advanceTimersByTimeAsync(2000)
  expect(await interrupted).toEqual([[1, 0]]); expect(request).toHaveBeenCalledTimes(2)
  expect(vi.getTimerCount()).toBe(0)
})

it('C03 401不重试，响应正文及网络错误中的密钥不会进入错误链', async () => {
  const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(key, { status: 401 }))
  const error = await new OpenAICompatibleEmbeddingClient(settings, request).embed(['甲']).catch(error => error)
  expect(error.message).toContain('HTTP 401'); expect(request).toHaveBeenCalledTimes(1)
  expect(error.message + error.stack + JSON.stringify(error)).not.toContain(key); expect(error.cause).toBeUndefined()
  request.mockReset().mockRejectedValue(new TypeError('Authorization: Bearer ' + key))
  const network = await new OpenAICompatibleEmbeddingClient(settings, request, 0).embed(['甲']).catch(error => error)
  expect(network.message + network.stack + JSON.stringify(network)).not.toContain(key); expect(network.cause).toBeUndefined()
  vi.stubEnv(settings.cloudEmbeddingKeyEnv, undefined); request.mockClear()
  await expect(new OpenAICompatibleEmbeddingClient(settings, request).embed(['甲'])).rejects.toThrow('环境变量')
  expect(request).not.toHaveBeenCalled()
})

it('C04 非法向量、重复索引、数量与维度不符均拒绝且不重试', async () => {
  for (const data of [[], [{ index: 0, embedding: [0, 0] }], [{ index: 1, embedding: [1, 0] }],
    [{ index: 0, embedding: [null, 1] }], [{ index: 0, embedding: [1e308, 1e308] }, { index: 0, embedding: [1, 0] }]]) {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ data })))
    await expect(new OpenAICompatibleEmbeddingClient(settings, request).embed(['甲'])).rejects.toThrow()
    expect(request).toHaveBeenCalledTimes(1)
  }
  const request = vi.fn<typeof fetch>().mockResolvedValue(response([[1, 0], [1, 0, 0]]))
  await expect(new OpenAICompatibleEmbeddingClient(settings, request).embed(['甲', '乙'])).rejects.toThrow()
  expect(request).toHaveBeenCalledTimes(1)
})

it('C05 超时后重试与取消释放计时器，不发送后续批次', async () => {
  vi.useFakeTimers()
  const wait: typeof fetch = async (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true }))
  const request = vi.fn<typeof fetch>().mockImplementationOnce(wait).mockResolvedValueOnce(response([[1, 0]]))
  const pending = new OpenAICompatibleEmbeddingClient({ ...settings, embeddingTimeoutMs: 100 }, request).embed(['甲'])
  await vi.advanceTimersByTimeAsync(2100); expect(await pending).toEqual([[1, 0]])
  expect(request).toHaveBeenCalledTimes(2); expect(vi.getTimerCount()).toBe(0)
  request.mockReset().mockImplementation(wait)
  const controller = new AbortController(), reason = new Error('用户取消')
  const cancelled = new OpenAICompatibleEmbeddingClient({ ...settings, embeddingBatchSize: 1 }, request).embed(['甲', '乙'], controller.signal)
  const assertion = expect(cancelled).rejects.toBe(reason)
  controller.abort(reason); await assertion
  expect(request).toHaveBeenCalledTimes(1); expect(vi.getTimerCount()).toBe(0)
})
