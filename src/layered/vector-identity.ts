import { embeddingEndpoint, layeredSettings, normalizeCloudEmbeddingUrl, type LayeredSettings } from '../domain/config.js'
import { readVectorRecord, vectorUnavailable } from './vectors.js'
import type { EmbeddingClient, EmbeddingIdentity, LibraryVectorState, SnapshotManifest } from './schema.js'

export const embeddingProbe = ['这是一条用于验证检索向量的合成短句。', 'A synthetic sentence for checking retrieval embeddings.']
export const embeddingHelp = '向量服务不可用。请安装 Ollama 并执行 ollama pull qwen3-embedding:0.6b，或在设置中确认不使用向量；主题归属需要向量。'
// 模型已安装但首次推理超时，多半是 Ollama 仍在把权重载入内存；与“未安装”分开提示。
export const embeddingLoadingHelp = '向量模型已安装，但在等待时间内没有完成加载。Ollama 首次载入较大的模型可能需要数分钟，请稍后重试；若反复出现，可在终端执行 ollama run <模型名> 预先载入。'
// 单次推理等待上限；超时后稍等再试一次，覆盖冷启动载入权重的时间。
export const probeAttemptMs = 90000, probeRetryDelayMs = 5000
export const queryPreprocessing = (model: string) => /^qwen3-embedding(?::|$)/.test(model) ? 'qwen3-retrieval-v1' : 'raw-v1'
export function queryInput(input: string, identity: EmbeddingIdentity): string {
  if (identity.query_preprocessing === 'raw-v1') return input
  if (identity.query_preprocessing === 'qwen3-retrieval-v1') return 'Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: ' + input
  throw new Error('向量查询前处理版本不受本机支持。')
}
export function identityKey(identity: EmbeddingIdentity): string {
  return JSON.stringify([identity.provider, identity.model, identity.revision, identity.dimensions, identity.precision, identity.document_preprocessing, identity.query_preprocessing,
    ...(identity.provider === 'cloud' ? [identity.service_url] : [])])
}
export const hasVectorMode = (mode: LibraryVectorState['mode'] | undefined): boolean => mode === 'ollama' || mode === 'cloud'
export function lockedEmbeddingSettings(settings: LayeredSettings, identity: EmbeddingIdentity): void {
  if (identity.provider === 'lexical') throw new Error('词项向量不能用于语义嵌入。')
  settings.embeddingMode = identity.provider
  settings.vectorPrecision = identity.precision
  if (identity.provider === 'cloud') {
    if (!identity.service_url) throw new Error('云端向量身份缺少服务地址，请显式修复。')
    settings.cloudEmbeddingUrl = normalizeCloudEmbeddingUrl(identity.service_url)
    settings.cloudEmbeddingModel = identity.model
  } else settings.localEmbeddingModel = identity.model
}
export const sameIdentity = (a: EmbeddingIdentity | undefined, b: EmbeddingIdentity | undefined) => !!a && !!b && identityKey(a) === identityKey(b)
export function selection(settings: LayeredSettings): LibraryVectorState['selection'] {
  return { mode: settings.embeddingMode, model: embeddingEndpoint(settings).model, precision: settings.vectorPrecision,
    ...(settings.embeddingMode === 'cloud' ? { service_url: settings.cloudEmbeddingUrl } : {}),
    ...(settings.embeddingChangeToken ? { token: settings.embeddingChangeToken } : {}) }
}
export async function deadline<T>(milliseconds: number, signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
  const timer = setTimeout(() => controller.abort(new DOMException('向量服务检测超时。', 'TimeoutError')), milliseconds)
  let abort: () => void = () => {}
  try {
    combined.throwIfAborted()
    return await Promise.race([action(combined), new Promise<never>((_, reject) => {
      abort = () => reject(combined.reason); combined.addEventListener('abort', abort, { once: true })
      if (combined.aborted) abort()
    })])
  } finally { clearTimeout(timer); combined.removeEventListener('abort', abort) }
}
// 设置页只读元数据，不加载模型、不推理；同一轮 tags/show 共用两秒期限。
export async function detectOllama(settings: LayeredSettings, auto = false, signal?: AbortSignal, request: typeof fetch = fetch) {
  return deadline(2000, signal, async signal => {
    const base = settings.localEmbeddingUrl.replace(/\/+$/, '')
    const response = await request(base + '/api/tags', { signal })
    if (!response.ok) throw new Error(embeddingHelp)
    const tags = await response.json() as { models?: { name: string; model?: string; digest?: string; capabilities?: string[] }[] }
    const candidates = auto ? [...new Set([settings.localEmbeddingModel, 'qwen3-embedding:0.6b', 'bge-m3', ...(tags.models ?? []).map(model => model.name).sort()])] : [settings.localEmbeddingModel]
    for (const name of candidates) {
      const model = tags.models?.find(item => [item.name, item.model, item.name.replace(/:latest$/, ''), item.model?.replace(/:latest$/, '')].includes(name))
      if (!model?.digest) continue
      let capabilities = model.capabilities
      if (!capabilities) {
        const show = await request(base + '/api/show', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: model.name }), signal })
        if (!show.ok) continue
        const detail = await show.json() as { capabilities?: string[]; model_info?: Record<string, unknown> }
        capabilities = detail.capabilities
        // 旧服务没有 capabilities 时，不能把聊天模型的 embedding_length 当作嵌入能力。
        if (!capabilities && /^(qwen3-embedding|bge-m3|nomic-embed-text)(:|$)/.test(model.name)) capabilities = ['embedding']
      }
      if (capabilities?.includes('embedding')) return { model: name, revision: model.digest }
    }
    throw new Error(embeddingHelp)
  })
}
export async function probeIdentity(client: EmbeddingClient, settings: LayeredSettings, signal?: AbortSignal, locked?: EmbeddingIdentity,
  timing: { attemptMs: number; retryDelayMs: number } = { attemptMs: probeAttemptMs, retryDelayMs: probeRetryDelayMs }): Promise<EmbeddingIdentity> {
  const timedOut = (error: unknown) => error instanceof DOMException && error.name === 'TimeoutError'
  try { return await probeOnce(client, settings, signal, locked, timing.attemptMs) }
  catch (error) {
    signal?.throwIfAborted()
    if (!timedOut(error)) throw error
    // 第一次超时通常是模型仍在载入；载入在 Ollama 侧继续进行，稍等后再试一次。
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, timing.retryDelayMs)
      signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
    })
    try { return await probeOnce(client, settings, signal, locked, timing.attemptMs) }
    catch (retry) { signal?.throwIfAborted(); throw timedOut(retry) ? new Error(settings.embeddingMode === 'cloud' ? '云端向量探针超时，请稍后重试。' : embeddingLoadingHelp, { cause: retry }) : retry }
  }
}
async function probeOnce(client: EmbeddingClient, settings: LayeredSettings, signal: AbortSignal | undefined, locked: EmbeddingIdentity | undefined, milliseconds: number): Promise<EmbeddingIdentity> {
  return deadline(milliseconds, signal, async signal => {
    const revision = await client.identity?.(signal)
    if (!revision || revision === 'query-v1') throw new Error('向量服务缺少真实权重版本。')
    if (locked && revision !== locked.revision) throw new Error('向量权重与本库锁定身份不符，换模型请复制一份库再切换。')
    // 同一不可变权重已有探针结果；缓存续跑无需再次推理，实际新增嵌入仍逐条核验维度。
    if (locked) return structuredClone(locked)
    const vectors = await client.embed(embeddingProbe, signal)
    const dimensions = vectors[0]?.length
    if (vectors.length !== 2 || !dimensions || vectors.some(vector => vector.length !== dimensions || vector.some(value => !Number.isFinite(value)) || !Math.hypot(...vector))) throw new Error('向量探针返回的条数或维度无效。')
    const cloud = settings.embeddingMode === 'cloud', model = embeddingEndpoint(settings).model
    const identity: EmbeddingIdentity = { provider: cloud ? 'cloud' : 'ollama', model, revision, dimensions, precision: settings.vectorPrecision,
      ...(cloud ? { service_url: settings.cloudEmbeddingUrl } : {}),
      document_preprocessing: 'utf8-normalized-v1', query_preprocessing: queryPreprocessing(model) }
    return identity
  })
}
export function recordIdentity(record: Awaited<ReturnType<typeof readVectorRecord>>, originalUrl?: string): EmbeddingIdentity {
  const { identity, precision } = record
  if (identity.provider === 'lexical') {
    if (identity.model !== 'lexical-bigram-tfidf-v1' || identity.preprocessing !== identity.model || identity.query_preprocessing !== 'disabled-v1'
      || identity.dimensions !== 2048 || precision !== 'float32' || !/^sha256:[a-f0-9]{64}$/.test(identity.revision)) throw new Error('词项向量头不能证明完整身份。')
    return { provider: 'lexical', model: identity.model, revision: identity.revision, dimensions: identity.dimensions, precision,
      document_preprocessing: identity.preprocessing, query_preprocessing: identity.query_preprocessing }
  }
  const cloud = identity.provider === 'cloud'
  if (identity.provider !== 'ollama' && !cloud && identity.provider !== originalUrl || identity.revision === 'query-v1' || !identity.revision
    || identity.preprocessing !== 'utf8-normalized-v1' || !['raw-v1', 'qwen3-retrieval-v1'].includes(identity.query_preprocessing ?? 'raw-v1')) throw new Error('向量头不能证明完整身份。')
  if (cloud && (!identity.service_url || normalizeCloudEmbeddingUrl(identity.service_url) !== identity.service_url)) throw new Error('云端向量头缺少规范化服务身份。')
  return { provider: cloud ? 'cloud' : 'ollama', ...(cloud ? { service_url: identity.service_url! } : {}), model: identity.model, revision: identity.revision, dimensions: identity.dimensions, precision,
    document_preprocessing: identity.preprocessing, query_preprocessing: identity.query_preprocessing ?? 'raw-v1' }
}
// 只从随库证据恢复，调用方是读者时也不会写回或探测本机服务。
export async function libraryVectorState(root: string, manifest: SnapshotManifest, original: Partial<LayeredSettings> = {}): Promise<LibraryVectorState | undefined> {
  if (manifest.vector_state) return structuredClone(manifest.vector_state)
  if (!manifest.version && !manifest.sources.length && !manifest.topics) return undefined
  const settings = layeredSettings(original), topic = manifest.topics
  const unresolved: LibraryVectorState = { mode: 'unresolved', generation: 0, selection: selection(settings), coverage: { embedded: [], missing: [] }, pending_points: [],
    message: '旧库缺少可交叉验证的向量身份，仅使用全文检索；请由写入端在设置中确认修复。' }
  const references = Object.entries(topic?.vectors ?? {})
  if (!topic || !references.length) return unresolved
  try {
    let recovered: EmbeddingIdentity | undefined
    for (const [, reference] of references) {
      if (!reference.vector_id) return unresolved
      const identity = recordIdentity(await readVectorRecord(root, reference.vector_id), topic.embedding.url)
      if (identity.model !== topic.embedding.model || identity.precision !== (topic.embedding.precision ?? 'float32') || recovered && !sameIdentity(recovered, identity)) return unresolved
      recovered = identity
    }
    for (const contribution of Object.values(manifest.deps?.pages ?? {}).flatMap(page => page.terms ?? []).flatMap(term => term.contributions)) {
      if (!contribution.vector_id) return unresolved
      if (!sameIdentity(recovered, recordIdentity(await readVectorRecord(root, contribution.vector_id), topic.embedding.url))) return unresolved
    }
    return { ...unresolved, mode: recovered!.provider === 'lexical' ? 'none' : recovered!.provider, identity: recovered!, generation: 1, message: '已从向量头与主题原配置恢复身份。',
      coverage: { embedded: references.map(([id]) => id).sort(), missing: [] } }
  } catch (error) {
    if (vectorUnavailable(error) || error instanceof Error && /身份/.test(error.message)) return unresolved
    throw error
  }
}
