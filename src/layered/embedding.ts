import path from 'node:path'
import { embeddingEndpoint, layeredSettings, type LayeredSettings } from '../domain/config.js'
import { defaultPolicy } from '../domain/policy.js'
import { mapConcurrent, ProviderGate } from '../llm/scheduler.js'
import { readOptional } from '../storage/files.js'
import { safePath } from '../storage/paths.js'
import { hash, writeJson } from './files.js'
import { putVector, readVectorRecord, vectorUnavailable } from './vectors.js'
import { recordIdentity, sameIdentity } from './vector-identity.js'
import type { VectorReference } from './vectors.js'
import type { EmbeddingClient, EmbeddingIdentity, Point, TopicState } from './schema.js'

export function normalized(vector: number[]): number[] {
  if (!Array.isArray(vector) || !vector.length || vector.some(value => typeof value !== 'number' || !Number.isFinite(value))) throw new Error('嵌入向量为空或包含无效数值。')
  const length = Math.hypot(...vector)
  if (!Number.isFinite(length) || !length) throw new Error('嵌入向量长度无效。')
  return vector.map(value => value / length)
}
export function similarity(left: number[], right: number[]): number {
  if (left.length !== right.length) throw new Error('嵌入向量维度不一致。')
  let sum = 0
  // 维度顺序和逐项乘加保持不变，避免高维近邻循环为每个元素调用回调。
  for (let index = 0; index < left.length; index++) sum += left[index]! * right[index]!
  return sum
}
export function centroid(vectors: number[][]): number[] {
  if (!vectors.length) return []
  const sum = vectors[0]!.map(() => 0)
  for (const vector of vectors) {
    if (sum.length !== vector.length) throw new Error('嵌入向量维度不一致。')
    vector.forEach((value, index) => { sum[index]! += value })
  }
  // 相反方向恰好抵消时，用稳定的首个向量继续归属判断。
  return sum.some(value => value !== 0) ? normalized(sum) : vectors[0]!
}

interface CentroidInput { vector: number[]; vector_id?: string; input_hash: string }
interface CentroidSnapshot { ids: string[]; inputs: { vector: number[] | undefined; vectorId: string | undefined; inputHash: string | undefined }[]; value: number[] }
// 严格与容忍缺失两种口径结果不同，分开缓存，交替调用时互不挤出。
const centroidCaches = [new WeakMap<object, CentroidSnapshot>(), new WeakMap<object, CentroidSnapshot>()] as const
// 向量数组写入后不原地修改（解码、嵌入、归一化都返回新数组），按数组身份、对象 ID 和输入哈希判定命中。
// 命中只比较成员身份，不逐维比较、不另存数值副本：护士库 3 万余条 4096 维向量另存副本约占 1GB。
export function cachedCentroid(owner: object, ids: readonly string[], vectors: Record<string, CentroidInput>, tolerateMissing = false): number[] {
  const cache = centroidCaches[tolerateMissing ? 1 : 0], previous = cache.get(owner)
  if (previous && previous.ids.length === ids.length && ids.every((id, index) => {
    const input = vectors[id], saved = previous.inputs[index]!
    return id === previous.ids[index] && input?.vector === saved.vector && input?.vector_id === saved.vectorId && input?.input_hash === saved.inputHash
  })) return previous.value
  const inputs = ids.map(id => vectors[id])
  const value = centroid(tolerateMissing ? inputs.flatMap(input => input?.vector.length ? [input.vector] : []) : inputs.map(input => input!.vector))
  cache.set(owner, { ids: [...ids], inputs: inputs.map(input => ({ vector: input?.vector, vectorId: input?.vector_id, inputHash: input?.input_hash })), value })
  return value
}
export function* embeddingBatches<T>(items: T[], text: (item: T) => string, settings: LayeredSettings): Generator<T[]> {
  let batch: T[] = [], bytes = 0
  for (const item of items) {
    const size = Buffer.byteLength(text(item), 'utf8')
    // 单条不能截断，否则缓存的文本身份与实际向量不一致。
    if (size > settings.embeddingBatchBytes) throw new Error('单条要点超过嵌入字节上限，请调整 embeddingBatchBytes。')
    if (batch.length && (batch.length >= settings.embeddingBatchSize || bytes + size > settings.embeddingBatchBytes)) {
      yield batch; batch = []; bytes = 0
    }
    batch.push(item); bytes += size
  }
  if (batch.length) yield batch
}
export function backoff(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cancelled = () => { clearTimeout(timer); reject(signal!.reason) }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancelled); resolve() }, ms)
    signal?.addEventListener('abort', cancelled, { once: true })
  })
}
export class OllamaEmbeddingClient implements EmbeddingClient {
  private readonly settings: LayeredSettings
  constructor(settings: Partial<LayeredSettings>, private readonly request: typeof fetch = fetch, private readonly retryLimit = 2) { this.settings = layeredSettings(settings) }
  private modelIdentity: Promise<string> | undefined
  identity(signal?: AbortSignal): Promise<string> {
    return this.modelIdentity ??= this.resolveIdentity(signal).catch(error => { this.modelIdentity = undefined; throw error })
  }
  private async resolveIdentity(signal?: AbortSignal): Promise<string> {
    const timeout = AbortSignal.timeout(this.settings.embeddingTimeoutMs)
    const response = await this.request(this.settings.localEmbeddingUrl.replace(/\/+$/, '') + '/api/tags', { signal: signal ? AbortSignal.any([signal, timeout]) : timeout })
    if (!response.ok) throw new Error('无法读取嵌入模型权重身份。')
    const value = await response.json() as { models?: { name: string; model?: string; digest?: string }[] }
    const model = value.models?.find(item => [item.name, item.model, item.name.replace(/:latest$/, ''), item.model?.replace(/:latest$/, '')].includes(this.settings.localEmbeddingModel))
    if (!model?.digest) throw new Error('嵌入模型缺少不可变权重摘要。')
    return model.digest
  }
  async embed(input: string[], signal?: AbortSignal): Promise<number[][]> {
    signal?.throwIfAborted()
    try {
      const vectors: number[][] = []
      for (const batch of embeddingBatches(input, text => text, this.settings)) {
        vectors.push(...await this.embedBatch(batch, signal))
      }
      for (const vector of vectors) similarity(vectors[0]!, vector)
      return vectors
    } catch (cause) {
      signal?.throwIfAborted()
      throw new Error('本地向量模型不可用，主题聚类已暂停。', { cause })
    }
  }
  private async embedBatch(input: string[], signal?: AbortSignal): Promise<number[][]> {
    for (let attempt = 0; ; attempt++) {
      signal?.throwIfAborted()
      const timeout = new AbortController()
      const timer = setTimeout(() => timeout.abort(new DOMException('嵌入请求超时。', 'TimeoutError')), this.settings.embeddingTimeoutMs)
      try {
        const response = await this.request(this.settings.localEmbeddingUrl.replace(/\/+$/, '') + '/api/embed', {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ model: this.settings.localEmbeddingModel, input, truncate: false }),
          signal: signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal,
        })
        if (!response.ok) throw new Error(response.status === 404 ? '嵌入模型缺失（HTTP 404）。' : `HTTP ${response.status}`)
        const value = await response.json() as { embeddings?: number[][] }
        if (!Array.isArray(value?.embeddings) || value.embeddings.length !== input.length) throw new Error('嵌入结果数量不匹配。')
        const vectors = value.embeddings.map(normalized)
        for (const vector of vectors) similarity(vectors[0]!, vector)
        signal?.throwIfAborted(); timeout.signal.throwIfAborted()
        return vectors
      } catch (cause) {
        signal?.throwIfAborted()
        // fetch 的连接失败为 TypeError；HTTP 和响应校验错误不重试。
        if (attempt >= this.retryLimit || !(timeout.signal.aborted || cause instanceof TypeError || cause instanceof Error && cause.name === 'TimeoutError')) throw cause
      } finally { clearTimeout(timer) }
      await backoff(2000 * 2 ** attempt, signal)
    }
  }
}

interface EmbeddingCacheEntry { vector_id: string; input_hash: string }
interface EmbeddingCacheFile { format_version: number; vectors: Record<string, EmbeddingCacheEntry> }
interface EmbeddingCacheState {
  cache: Record<string, EmbeddingCacheEntry>
  inFlight: Map<string, Promise<VectorReference>>
  persist: Promise<void>
  active: number
}
interface EmbeddingClaim {
  input: string; key: string; promise: Promise<VectorReference>; settled: boolean
  resolve: (value: VectorReference) => void
  reject: (error: unknown) => void
}
const cacheStates = new Map<string, EmbeddingCacheState>()
function cacheState(root: string): EmbeddingCacheState {
  const key = path.resolve(root)
  let state = cacheStates.get(key)
  if (!state) { state = { cache: {}, inFlight: new Map(), persist: Promise.resolve(), active: 0 }; cacheStates.set(key, state) }
  return state
}
async function readEmbeddingCache(root: string): Promise<Record<string, EmbeddingCacheEntry> | undefined> {
  const saved = await readOptional<EmbeddingCacheFile>(await safePath(root, 'state/embeddings.json'))
    .catch(error => { if (error instanceof SyntaxError) return undefined; throw error })
  return saved?.format_version === 2 && saved.vectors && typeof saved.vectors === 'object' && !Array.isArray(saved.vectors) ? saved.vectors : undefined
}
// 只读已落盘缓存，用于断点覆盖统计，不触发服务检测或推理。
export async function cachedPointVectors(root: string, points: Point[], identity: EmbeddingIdentity, originalUrl?: string): Promise<TopicState['vectors']> {
  const cache = await readEmbeddingCache(root) ?? {}, wanted = new Set(points.map(point => hash(point.text)))
  const found = new Map<string, VectorReference>()
  for (const reference of Object.values(cache)) {
    if (!wanted.has(reference.input_hash) || found.has(reference.input_hash)) continue
    try {
      const record = await readVectorRecord(root, reference.vector_id)
      if (record.identity.input_hash === reference.input_hash && sameIdentity(identity, recordIdentity(record, originalUrl))) found.set(reference.input_hash, { ...reference, vector: normalized(record.vector) })
    } catch (error) { if (!vectorUnavailable(error) && !(error instanceof Error && /身份/.test(error.message))) throw error }
  }
  return Object.fromEntries(points.flatMap(point => { const reference = found.get(hash(point.text)); return reference ? [[point.point_id, reference]] : [] }))
}
// 进程内共享缓存：并发调用合并同一份索引；文件是持久化真源，读回时合并而不是覆盖。
async function loadEmbeddingCache(root: string, state: EmbeddingCacheState): Promise<void> {
  const saved = await readEmbeddingCache(root)
  if (saved) state.cache = { ...saved, ...state.cache }
  // 文件被删除或损坏且没有在途写入时，内存派生映射一并失效，续跑会重新计算。
  else if (state.active === 1 && state.inFlight.size === 0) state.cache = {}
}
function persistEmbeddingCache(root: string, state: EmbeddingCacheState): Promise<void> {
  const write = state.persist.catch(() => {}).then(async () => {
    const saved = await readEmbeddingCache(root)
    const merged = { ...(saved ?? {}), ...state.cache }
    state.cache = merged
    await writeJson(root, 'state/embeddings.json', { format_version: 2, vectors: merged })
  })
  state.persist = write
  return write
}
// 使用通用供应商闸门；每次调用的并发上限也约束同模型的在途批次。
const embeddingGates = new Map<string, ProviderGate>()
function embeddingGate(key: string): ProviderGate {
  let gate = embeddingGates.get(key)
  if (!gate) { gate = new ProviderGate(50, { concurrency: 50 }); embeddingGates.set(key, gate) }
  return gate
}
function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    signal.addEventListener('abort', aborted, { once: true })
    promise.then(value => { signal.removeEventListener('abort', aborted); resolve(value) },
      error => { signal.removeEventListener('abort', aborted); reject(error) })
  })
}
export async function embedInputs(root: string, inputs: string[], settings: LayeredSettings, client: EmbeddingClient,
  signal?: AbortSignal, concurrency = defaultPolicy().pageGenerationConcurrency, identity?: EmbeddingIdentity): Promise<VectorReference[]> {
  if (!inputs.length) return []
  const revision = client.identity ? await client.identity(signal) : undefined
  if (!revision) throw new Error('嵌入客户端必须提供不可变模型身份（identity）。')
  if (identity && revision !== identity.revision) throw new Error('向量权重与锁定身份不符。')
  const state = cacheState(root), owned = new Map<string, EmbeddingClaim>()
  const fail = (claim: EmbeddingClaim, error: unknown) => {
    if (claim.settled) return
    claim.settled = true
    if (state.inFlight.get(claim.key) === claim.promise) state.inFlight.delete(claim.key)
    claim.reject(error)
  }
  state.active++
  try {
    await loadEmbeddingCache(root, state)
    const endpoint = embeddingEndpoint(settings)
    const base = { provider: identity?.provider ?? endpoint.url, model: identity?.model ?? endpoint.model, revision, preprocessing: identity?.document_preprocessing ?? 'utf8-normalized-v1',
      ...(identity?.service_url ? { service_url: identity.service_url } : {}),
      ...(identity ? { query_preprocessing: identity.query_preprocessing } : {}) }
    const key = (input: string) => hash(JSON.stringify([base, hash(input), settings.vectorPrecision]))
    const gate = embeddingGate(JSON.stringify([path.resolve(root), base, settings.vectorPrecision]))
    const results = new Map<string, VectorReference>(), waits: Promise<void>[] = []
    for (const input of new Set(inputs)) {
      signal?.throwIfAborted()
      const cacheKey = key(input)
      const old = state.cache[cacheKey]
      // 旧缓存以设备地址作键；头部证明完整身份相同后可复用，不因迁移键重算。
      const candidates = old ? [old] : identity ? Object.values(state.cache).filter(item => item.input_hash === hash(input)) : []
      for (const reference of candidates) {
        if (reference.input_hash !== hash(input)) continue
        try {
          const record = await readVectorRecord(root, reference.vector_id)
          if (identity && !sameIdentity(identity, recordIdentity(record, settings.localEmbeddingUrl))) throw new Error('缓存向量身份不符。')
          if (record.identity.input_hash !== reference.input_hash) throw new Error('缓存向量输入不符。')
          results.set(input, { ...reference, vector: normalized(record.vector) }); state.cache[cacheKey] = reference; break
        }
        catch { /* 派生缓存损坏时重新计算，权威向量读取仍校验对象。 */ }
      }
      if (results.has(input)) continue
      if (old) delete state.cache[cacheKey]
      // 同一模型身份、输入指纹和精度的在途文本共享一次请求；不同文本仍各自成批。
      const pending = state.inFlight.get(cacheKey)
      if (pending) {
        const wait = abortable(pending, signal).then(reference => { results.set(input, reference) })
        void wait.catch(() => {}); waits.push(wait)
        continue
      }
      let resolve!: (value: VectorReference) => void, reject!: (error: unknown) => void
      const promise = new Promise<VectorReference>((accept, refuse) => { resolve = accept; reject = refuse })
      void promise.catch(() => {})
      state.inFlight.set(cacheKey, promise)
      owned.set(cacheKey, { input, key: cacheKey, promise, settled: false, resolve, reject })
    }
    const claims = [...owned.values()]
    const batches: EmbeddingClaim[][] = []
    try { for (const batch of embeddingBatches(claims, claim => claim.input, settings)) batches.push(batch) }
    catch (error) { for (const claim of claims) fail(claim, error); throw error }
    if (batches.length) try {
      await mapConcurrent(batches, Math.max(1, concurrency), signal ?? new AbortController().signal, async (batch, batchSignal) => {
        const queuedAt = Date.now()
        const vectors = await gate.run(() => client.embed(batch.map(claim => claim.input), batchSignal, queuedAt), 0, batchSignal, undefined, concurrency, 0)
        if (vectors.length !== batch.length) throw new Error('嵌入结果数量不匹配。')
        for (let index = 0; index < batch.length; index++) {
          const claim = batch[index]!, vector = normalized(vectors[index]!)
          if (identity && vector.length !== identity.dimensions) throw new Error('向量维度与锁定身份不符。')
          const reference = results.values().next().value?.vector
          if (reference) similarity(reference, vector)
          const stored = await putVector(root, { ...base, dimensions: vector.length, input_hash: hash(claim.input) }, vector, settings.vectorPrecision)
          stored.vector = normalized(stored.vector)
          state.cache[claim.key] = { vector_id: stored.vector_id, input_hash: stored.input_hash }
          claim.settled = true
          if (state.inFlight.get(claim.key) === claim.promise) state.inFlight.delete(claim.key)
          results.set(claim.input, stored)
          claim.resolve(stored)
        }
        await persistEmbeddingCache(root, state)
      })
    } catch (error) {
      for (const claim of claims) fail(claim, error)
      throw error
    }
    await Promise.all(waits)
    const ordered = inputs.map(input => results.get(input)!)
    for (const reference of ordered) similarity(ordered[0]!.vector, reference.vector)
    return ordered
  } catch (error) {
    for (const claim of owned.values()) fail(claim, error)
    throw error
  } finally {
    state.active--
    // 一轮并发结束后由磁盘重新建立派生缓存，撤权或外部清理不会被旧内存覆盖。
    if (!state.active) {
      cacheStates.delete(path.resolve(root))
      for (const key of embeddingGates.keys()) if (JSON.parse(key)[0] === path.resolve(root)) embeddingGates.delete(key)
    }
  }
}
export async function embedPoints(root: string, points: Point[], settings: LayeredSettings, client: EmbeddingClient,
  _previous: TopicState['vectors'], signal?: AbortSignal, concurrency = defaultPolicy().pageGenerationConcurrency, identity?: EmbeddingIdentity): Promise<TopicState['vectors']> {
  const vectors = await embedInputs(root, points.map(point => point.text), settings, client, signal, concurrency, identity)
  return Object.fromEntries(points.map((point, index) => [point.point_id, vectors[index]!]))
}
