import { expect, it } from 'vitest'
import { layeredSettings } from '../src/domain/config.js'
import { embeddingLoadingHelp, probeIdentity } from '../src/layered/vector-identity.js'
import type { EmbeddingClient } from '../src/layered/schema.js'

const settings = layeredSettings({ localEmbeddingModel: 'qwen3-embedding:0.6b' })
const timing = { attemptMs: 40, retryDelayMs: 5 }
// 模拟 Ollama 冷启动：前 n 次推理在期限内不返回，之后正常。
function slowClient(slowCalls: number): EmbeddingClient & { calls: number } {
  const client = { calls: 0, identity: async () => 'sha256:weights',
    embed: async (inputs: string[], signal?: AbortSignal) => {
      client.calls++
      if (client.calls <= slowCalls) await new Promise((_resolve, reject) => signal?.addEventListener('abort', () => reject(signal.reason), { once: true }))
      return inputs.map(() => [1, 0, 0])
    } }
  return client
}

it('首次推理超时（模型仍在载入）后稍等重试一次，载入完成即通过', async () => {
  const client = slowClient(1)
  const identity = await probeIdentity(client, settings, undefined, undefined, timing)
  expect(identity.dimensions).toBe(3)
  expect(client.calls).toBe(2)
})

it('重试仍超时时提示模型正在载入，而不是提示未安装', async () => {
  const client = slowClient(2)
  await expect(probeIdentity(client, settings, undefined, undefined, timing)).rejects.toThrow(embeddingLoadingHelp)
  expect(client.calls).toBe(2)
})

it('非超时错误不重试，外部取消立即结束', async () => {
  let calls = 0
  const broken: EmbeddingClient = { identity: async () => 'sha256:weights', embed: async () => { calls++; return [] } }
  await expect(probeIdentity(broken, settings, undefined, undefined, timing)).rejects.toThrow('向量探针返回的条数或维度无效。')
  expect(calls).toBe(1)
  const abort = new AbortController(); abort.abort(new Error('用户取消'))
  await expect(probeIdentity(slowClient(5), settings, abort.signal, undefined, timing)).rejects.toThrow('用户取消')
})
