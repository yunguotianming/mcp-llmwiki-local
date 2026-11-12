import { layeredSettings, type LayeredSettings } from '../domain/config.js'
import { backoff, embeddingBatches, normalized, OllamaEmbeddingClient, similarity } from './embedding.js'
import { hash } from './files.js'
import type { EmbeddingClient } from './schema.js'

export const cloudEmbeddingHelp = '云端向量服务不可用，请检查服务地址、模型名及宿主进程的密钥环境变量。'
// 只读取进程环境，密钥不进入设置对象、随库身份或错误链。
export function cloudEmbeddingKey(settings: LayeredSettings): string | undefined {
  const key = process.env[settings.cloudEmbeddingKeyEnv]?.trim()
  return key && /^[\x21-\x7e]+$/.test(key) ? key : undefined
}
export class OpenAICompatibleEmbeddingClient implements EmbeddingClient {
  private readonly settings: LayeredSettings
  constructor(settings: Partial<LayeredSettings>, private readonly request: typeof fetch = fetch, private readonly retryLimit = 2) {
    this.settings = layeredSettings(settings)
  }
  async identity(signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted()
    return 'cloud:' + hash(JSON.stringify([this.settings.cloudEmbeddingUrl, this.settings.cloudEmbeddingModel]))
  }
  async embed(input: string[], signal?: AbortSignal): Promise<number[][]> {
    signal?.throwIfAborted()
    const vectors: number[][] = []
    for (const batch of embeddingBatches(input, text => text, this.settings)) vectors.push(...await this.embedBatch(batch, signal))
    for (const vector of vectors) similarity(vectors[0]!, vector)
    return vectors
  }
  private async embedBatch(input: string[], signal?: AbortSignal): Promise<number[][]> {
    const key = cloudEmbeddingKey(this.settings)
    if (!key) throw new Error('云端向量密钥环境变量未设置或格式无效。')
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted()
      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(new DOMException('云端嵌入请求超时。', 'TimeoutError')), this.settings.embeddingTimeoutMs)
      let retryable = false, failure = cloudEmbeddingHelp
      try {
        let response: Response
        try {
          response = await this.request(this.settings.cloudEmbeddingUrl + '/embeddings', {
            method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
            body: JSON.stringify({ model: this.settings.cloudEmbeddingModel, input }),
            signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
          })
        } catch {
          retryable = true
          throw new Error('云端向量服务连接失败。')
        }
        if (!response.ok) {
          retryable = response.status === 429 || response.status >= 500 && response.status <= 599
          failure = `云端向量服务不可用（HTTP ${response.status}）。`
          // 不读取错误正文，供应商或代理可能回显 Authorization。
          throw new Error(failure)
        }
        let value: { data?: { index: number; embedding: number[] }[] }
        try { value = await response.json() as typeof value }
        catch (error) {
          // 响应头之后断线也是网络失败；无效 JSON 不重试，原始异常不外传。
          retryable = error instanceof TypeError
          throw error
        }
        if (!Array.isArray(value?.data) || value.data.length !== input.length) throw new Error('嵌入结果数量不匹配。')
        const rows = value.data.sort((left, right) => left.index - right.index)
        if (rows.some((row, index) => row.index !== index)) throw new Error('嵌入结果索引无效。')
        const vectors = rows.map(row => normalized(row.embedding))
        for (const vector of vectors) similarity(vectors[0]!, vector)
        signal?.throwIfAborted(); timeout.signal.throwIfAborted()
        return vectors
      } catch {
        signal?.throwIfAborted()
        if (timeout.signal.aborted) { retryable = true; failure = '云端嵌入请求超时。' }
        if (!retryable || attempt >= this.retryLimit) throw new Error(failure)
      } finally { clearTimeout(timer) }
      await backoff(2000 * 2 ** attempt, signal)
    }
  }
}
export function createEmbeddingClient(settings: LayeredSettings, request: typeof fetch = fetch, retryLimit = 2): EmbeddingClient {
  return settings.embeddingMode === 'cloud' ? new OpenAICompatibleEmbeddingClient(settings, request, retryLimit)
    : new OllamaEmbeddingClient(settings, request, retryLimit)
}
