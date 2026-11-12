import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { ModelCallError, ModelClient, ModelTransportError } from '../src/llm/client.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { newLibrary } from '../src/domain/config.js'
import { defaultPolicy } from '../src/domain/policy.js'
import { routesSchema } from '../src/domain/route-schema.js'
import { ProviderGate } from '../src/llm/scheduler.js'

const ok: StreamChunk[] = [{ type: 'text-delta', index: 0, text: '{"ok":true}' }, { type: 'finish', reason: { kind: 'stop' } }]
function base(runtime: ModelRuntime, concurrency = 3) {
  const library = newLibrary('adapter'), policy = defaultPolicy()
  library.models.unified = { provider: 'mock', model: 'primary' }
  library.models.providerProfiles!.mock = { concurrency, retryLimit: 2, backoffMs: 1000, cacheMode: 'automatic-prefix' }
  policy.pageGenerationConcurrency = concurrency; policy.batchDelayMs = 0
  return { library, policy, client: new ModelClient(runtime, library, policy) }
}
const runtimeInfo = async (provider: string, id: string) => ({ provider, id, name: id, reasoning: { efforts: [{ id: 'high', name: 'high' }] } })

describe('P2 模型调用适配', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
      const abort = new AbortController()
      setTimeout(() => abort.abort(new DOMException('请求超时', 'TimeoutError')), milliseconds)
      return abort.signal
    })
  })
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  it('同一供应商的不同客户端共用全局与档案较小并发上限', async () => {
    let active = 0, peak = 0, release!: () => void
    const hold = new Promise<void>(resolve => { release = resolve }), runtime: ModelRuntime = {
      resolveModelInfo: runtimeInfo,
      async *stream() { active++; peak = Math.max(peak, active); await hold; active--; yield* ok },
    }
    const a = base(runtime, 2), b = base(runtime, 4)
    a.library.models.providerProfiles!.mock.concurrency = 3; b.library.models.providerProfiles!.mock.concurrency = 3
    const calls = [a.client, a.client, b.client, b.client].map((client, index) => client.call('ingest', '固定规则', `资料${index}`))
    await vi.advanceTimersByTimeAsync(0)
    expect(peak).toBe(2)
    release(); await Promise.all(calls)
  })

  it('每分钟请求上限用虚拟时钟排队', async () => {
    let calls = 0
    const runtime: ModelRuntime = { resolveModelInfo: runtimeInfo, async *stream() { calls++; yield* ok } }
    const f = base(runtime, 2)
    f.library.models.providerProfiles!.mock.requestsPerMinute = 1
    const first = f.client.call('ingest', '', 'a'); await vi.advanceTimersByTimeAsync(0); await first
    const second = f.client.call('ingest', '', 'b'); await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(59_999); expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(1); await second
    expect(calls).toBe(2)
    const tokenRuntime: ModelRuntime = { resolveModelInfo: runtimeInfo, async *stream() { calls++; yield* ok } }
    const tokenGated = base(tokenRuntime, 2)
    tokenGated.library.models.providerProfiles!.mock.tokensPerMinute = 1
    calls = 0
    const a = tokenGated.client.call('ingest', 'x', 'y'); await vi.advanceTimersByTimeAsync(0); await a
    const b = tokenGated.client.call('ingest', 'x', 'y'); await vi.advanceTimersByTimeAsync(0)
    expect(calls).toBe(1)
    await vi.advanceTimersByTimeAsync(60_000); await b
    expect(calls).toBe(2)
  })

  it('按 429、5xx 与传输错误退避重试后逐个切 fallback，并统计每次实际调用', async () => {
    const routes: string[] = [], counts = new Map<string, number>(), times: number[] = [], start = Date.now()
    const runtime: ModelRuntime = { resolveModelInfo: runtimeInfo, async *stream(options) {
      routes.push(options.model); times.push(Date.now() - start); const count = (counts.get(options.model) ?? 0) + 1; counts.set(options.model, count)
      yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, totalTokens: 12 } }
      if (options.model === 'primary') {
        const [status, code] = count === 1 ? [429, 'rate'] : count === 2 ? [503, 'overload'] : [undefined, 'transport']
        if (status) yield { type: 'finish', reason: { kind: 'error', failure: { code, message: code, status } } }
        else throw new ModelTransportError('连接中断', 'NETWORK_ERROR')
      } else if (options.model === 'backup-a') yield { type: 'finish', reason: { kind: 'error', failure: { code: 'overload', message: '繁忙', status: 500 } } }
      else yield* ok
    } }
    const f = base(runtime); f.library.models.fallbacks = [{ provider: 'backup', model: 'backup-a' }, { provider: 'backup2', model: 'backup-b' }]
    f.library.models.providerProfiles!['mock']!.retryLimit = 2
    f.library.models.providerProfiles!['mock']!.backoffMs = 1000
    f.library.models.providerProfiles!.backup = { concurrency: 1, retryLimit: 1, backoffMs: 1000, cacheMode: 'none' }
    const result = f.client.call('ingest', '规则', '输入')
    await vi.advanceTimersByTimeAsync(20_000)
    await expect(result).resolves.toBe('{"ok":true}')
    expect(routes).toEqual(['primary', 'primary', 'primary', 'backup-a', 'backup-a', 'backup-b'])
    expect(times).toEqual([0, 1000, 3000, 3000, 4000, 4000])
    expect(f.client.attempts).toHaveLength(6)
    expect(f.client.attempts.reduce((sum, attempt) => sum + (attempt.usage?.inputTokens ?? 0), 0)).toBe(60)
  })

  it('超时、外部取消与参数错误不在当前模型重试', async () => {
    let primary = 0, backup = 0
    const runtime: ModelRuntime = { resolveModelInfo: runtimeInfo, async *stream(options) {
      const message = options.messages[0]!.content[0]!, input = message.type === 'text' ? message.text : ''
      if (options.model === 'backup') backup++
      if (options.model === 'primary') {
        primary++
        if (input !== 'bad-request') { await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true })); options.signal!.throwIfAborted() }
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'bad-request', message: '参数错误', status: 400 } } }
      } else yield* ok
    } }
    const f = base(runtime, 1); f.policy.ingestRequestTimeoutSeconds = 1; f.library.models.fallbacks = [{ provider: 'mock', model: 'backup' }]
    const timeout = f.client.call('ingest', '', 'timeout')
    await vi.advanceTimersByTimeAsync(1000); await timeout
    expect(primary).toBe(1); expect(backup).toBe(1)
    const cancel = new AbortController(), pending = f.client.call('ingest', '', 'cancel', cancel.signal).catch(error => error)
    await vi.advanceTimersByTimeAsync(0); cancel.abort(new Error('用户取消')); await vi.advanceTimersByTimeAsync(0)
    expect((await pending).message).toBe('用户取消')
    expect(primary).toBe(2); expect(backup).toBe(1)
    const invalid: ModelRuntime = { resolveModelInfo: runtimeInfo, async *stream() { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'bad-request', message: '参数错误', status: 400 } } } } }
    const bad = base(invalid); bad.library.models.fallbacks = [{ provider: 'mock', model: 'backup' }]
    await expect(bad.client.call('ingest', '', 'bad-request')).rejects.toThrow('参数错误')
    expect(bad.client.attempts).toHaveLength(1)
  })

  it('分层路由选择各自模型与推理深度，缺省沿用统一模型；支持 schema 时发送结构化约束', async () => {
    const seen: { model: string; effort?: string; schema?: unknown; cacheMode?: string }[] = []
    const runtime: ModelRuntime = { resolveModelInfo: runtimeInfo, supportsStructuredOutput: () => true, supportsCacheMode: () => true,
      async *stream(options) { seen.push({ model: options.model, ...(options.reasoningEffort ? { effort: options.reasoningEffort } : {}),
        schema: (options as unknown as { responseFormat?: unknown }).responseFormat, cacheMode: (options as unknown as { cacheMode?: string }).cacheMode }); yield* ok } }
    const f = base(runtime)
    f.library.models.providerProfiles!.mock.cacheMode = 'none'
    f.library.models.layeredRoutes!.extract = { route: { provider: 'mock', model: 'fast' }, reasoningEffort: 'high' }
    f.library.models.layeredRoutes!.topic = { route: { provider: 'mock', model: 'quality' } }
    const structuredSchema = { name: 'check', schema: { type: 'object', properties: { ok: { type: 'boolean' } } } }
    await f.client.call('ingest', '固定', '原文', undefined, [], { operation: 'extract', structuredSchema })
    await f.client.call('ingest', '固定', '原文', undefined, [], { operation: 'topic', structuredSchema })
    await f.client.call('ingest', '固定', '原文')
    expect(seen.map(item => item.model)).toEqual(['fast', 'quality', 'primary'])
    expect(seen[0]).toMatchObject({ effort: 'high', schema: { type: 'json_schema', json_schema: { name: 'check', strict: true } } })
    expect(seen[2]?.schema).toBeUndefined(); expect(seen[0]?.cacheMode).toBe('none')
  })

  it('运行时不支持结构化输出时保留 JSON 提示调用路径', async () => {
    let schema: unknown
    const runtime: ModelRuntime = { resolveModelInfo: runtimeInfo, supportsStructuredOutput: () => false,
      async *stream(options) { schema = (options as unknown as { responseFormat?: unknown }).responseFormat; yield* ok } }
    const f = base(runtime)
    await f.client.call('ingest', '只输出 JSON', '{}', undefined, [], { operation: 'extract', structuredSchema: { name: 'x', schema: {} } })
    expect(schema).toBeUndefined()
  })

  it('旧模型配置读入后仍获得统一模型路由、空供应商档案与空分层路由', () => {
    const { providerProfiles, layeredRoutes } = routesSchema.parse({ unified: { provider: 'mock', model: 'primary' }, perTask: false,
      ingest: { provider: '', model: '' }, query: { provider: '', model: '' }, lint: { provider: '', model: '' }, vision: { provider: '', model: '' }, fallbacks: [] })
    expect(providerProfiles).toEqual({}); expect(layeredRoutes).toEqual({})
  })

  it('限流排队不启动请求超时，不产生虚假尝试；排队取消不执行', async () => {
    const runtime: ModelRuntime = { resolveModelInfo: runtimeInfo, async *stream() { yield* ok } }
    const f = base(runtime, 2); f.policy.ingestRequestTimeoutSeconds = 1
    f.library.models.providerProfiles.mock.requestsPerMinute = 1
    await f.client.call('ingest', '', '一')
    const next = f.client.call('ingest', '', '二'), abort = new AbortController()
    const cancelled = f.client.call('ingest', '', '三', abort.signal).catch(error => error)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(f.client.attempts).toHaveLength(1)
    abort.abort(new Error('取消排队')); expect((await cancelled).message).toBe('取消排队')
    await vi.advanceTimersByTimeAsync(1); await next
    expect(f.client.attempts).toHaveLength(2)
    expect(f.client.attempts.every(attempt => attempt.finish === 'stop')).toBe(true)
  })

  it('退避期间并发减半，到期恢复且失败用量参与 Token 限流', async () => {
    const gate = new ProviderGate(4, { concurrency: 4 }), releases: (() => void)[] = []
    let started = 0
    gate.penalize(1000)
    const calls = Array.from({ length: 4 }, () => gate.run(async () => { started++; await new Promise<void>(resolve => releases.push(resolve)) }))
    await vi.advanceTimersByTimeAsync(999); expect(started).toBe(2)
    await vi.advanceTimersByTimeAsync(1); expect(started).toBe(4)
    releases.forEach(release => release()); await Promise.all(calls)
    const tokens = new ProviderGate(1, { concurrency: 1, tokensPerMinute: 5 })
    await expect(tokens.run(async () => { throw new Error('供应商失败') }, 1, undefined, () => 5)).rejects.toThrow('供应商失败')
    let second = false
    const next = tokens.run(async () => { second = true }, 1)
    await vi.advanceTimersByTimeAsync(59_999); expect(second).toBe(false)
    await vi.advanceTimersByTimeAsync(1); await next; expect(second).toBe(true)
    await expect(tokens.run(async () => {}, 6)).rejects.toThrow('单次请求超过')
  })
})
