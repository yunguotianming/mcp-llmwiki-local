import { embeddingEndpoint, layeredSettings, type LayeredSettings, type LibraryRegistration } from '../domain/config.js'
import { findLayeredLibrary } from '../wiki/query.js'
import { createEmbeddingClient } from './cloud-embedding.js'
import { backoff, normalized } from './embedding.js'
import { readCurrent, readManifest } from './objects.js'
import { deadline, libraryVectorState, lockedEmbeddingSettings, probeAttemptMs } from './vector-identity.js'
import type { EmbeddingClient } from './schema.js'

// Ollama 默认空闲驻留五分钟；不发送 keep_alive，也不把历史成功视为永久就绪。
export const embeddingReadyIdleMs = 5 * 60 * 1000
type ReadyState = { status: 'unknown' } | { status: 'ready'; lastSuccess: number } | { status: 'failed'; cause: unknown }
type WarmupState = { status: 'warming'; controller: AbortController; result: Promise<ReadyState> }
type ServiceState = ReadyState | WarmupState

export function embeddingTimedOut(error: unknown): boolean {
  const seen = new Set<unknown>()
  while (error instanceof Error && !seen.has(error)) {
    if (/TimeoutError|ETIMEDOUT|超时/i.test(error.name + ' ' + error.message)) return true
    seen.add(error); error = error.cause
  }
  return false
}

export class EmbeddingReadiness {
  private readonly services = new Map<string, ServiceState>()
  private lifecycle: AbortSignal | undefined
  useLifecycle(signal: AbortSignal): void { this.lifecycle = signal }
  private key(settings: LayeredSettings): string {
    const endpoint = embeddingEndpoint(settings)
    return JSON.stringify([settings.embeddingMode === 'cloud' ? 'cloud' : 'ollama', new URL(endpoint.url).href.replace(/\/+$/, ''), endpoint.model])
  }
  state(settings: LayeredSettings): ServiceState {
    const state = this.services.get(this.key(settings)) ?? { status: 'unknown' }
    return state.status === 'ready' && Date.now() - state.lastSuccess >= embeddingReadyIdleMs ? { status: 'unknown' } : state
  }
  ready(settings: LayeredSettings): void {
    if (this.lifecycle?.aborted) return
    const previous = this.services.get(this.key(settings))
    this.services.set(this.key(settings), { status: 'ready', lastSuccess: Date.now() })
    if (previous?.status === 'warming') previous.controller.abort(new Error('查询已确认向量服务就绪。'))
  }
  failed(settings: LayeredSettings, cause: unknown): void {
    // 某个查询放弃等待，不应取消其他读者共享的预热。
    if (this.state(settings).status !== 'warming') this.services.set(this.key(settings), { status: 'failed', cause })
  }
  warm(settings: LayeredSettings, client?: EmbeddingClient, retry = false): Promise<ReadyState> {
    if (settings.embeddingMode !== 'ollama' || this.lifecycle?.aborted) return Promise.resolve({ status: 'unknown' })
    const key = this.key(settings), existing = this.services.get(key)
    if (existing?.status === 'warming') return existing.result
    if (existing && !retry) return Promise.resolve(existing)
    const controller = new AbortController()
    const state: WarmupState = { status: 'warming', controller, result: Promise.resolve({ status: 'unknown' }) }
    this.services.set(key, state)
    state.result = deadline(probeAttemptMs, controller.signal, async signal => {
      // 让出当前调用栈，后台推理不延迟装配或本次降级返回。
      await backoff(0, signal)
      const embedding = client ?? createEmbeddingClient({ ...settings, embeddingTimeoutMs: probeAttemptMs }, fetch, 0)
      const vectors = await embedding.embed(['a'], signal)
      if (vectors.length !== 1) throw new Error('预热嵌入结果数量无效。')
      normalized(vectors[0]!)
    }).then<ReadyState, ReadyState>(() => ({ status: 'ready', lastSuccess: Date.now() }), cause => ({ status: 'failed', cause }))
      .then(result => {
        const current = this.services.get(key)
        if (current === state) this.services.set(key, result)
        // 并发查询先成功时，其成功状态也交给等待预热的读者，避免误缓存取消错误。
        else if (current?.status === 'ready') return current
        return result
      })
    return state.result
  }
  async warmRegistered(libraries: LibraryRegistration[], signal: AbortSignal): Promise<void> {
    await Promise.all(libraries.filter(library => library.enabled && library.kind !== 'whalefall').map(async library => {
      try {
        const layered = await findLayeredLibrary(library.wikiPath)
        if (!layered || signal.aborted) return
        const vector = await libraryVectorState(layered.root, await readManifest(layered.root, await readCurrent(layered.root)), library.layered)
        if (vector?.mode !== 'ollama' || vector.identity?.provider !== 'ollama' || signal.aborted) return
        const settings = layeredSettings(library.layered)
        lockedEmbeddingSettings(settings, vector.identity)
        await this.warm(settings)
      } catch { /* 旧库或不可读目录没有可证明的 Ollama 身份，不发出预热请求。 */ }
    }))
  }
  cancel(): void {
    for (const state of this.services.values()) if (state.status === 'warming') state.controller.abort(new Error('插件已卸载，取消向量预热。'))
    this.services.clear()
  }
}

export const embeddingReadiness = new EmbeddingReadiness()
