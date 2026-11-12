import { afterEach, expect, it, vi } from 'vitest'
import { setImmediate } from 'node:timers/promises'
import { ModelClient, ModelCallError } from '../src/llm/client.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { newLibrary } from '../src/domain/config.js'
import { defaultPolicy, validatePolicy } from '../src/domain/policy.js'
import { policySchema } from '../src/domain/policy-schema.js'
import { understandQuery } from '../src/wiki/query-understanding.js'
import { auditFixture, envelope, point } from './speed-fix-audit-fixture.js'

afterEach(() => vi.useRealTimers())
function configured(cap: number) {
  const lib = newLibrary('并发审查')
  lib.models.unified = { provider: 'a', model: 'audit' }; lib.models.fallbacks = []
  lib.models.layeredRoutes = { topic: { route: { provider: 'b', model: 'audit' } }, term: { route: { provider: 'c', model: 'audit' } }, parent: { route: { provider: 'd', model: 'audit' } } }
  for (const p of ['a', 'b', 'c', 'd']) lib.models.providerProfiles[p] = { concurrency: 50, retryLimit: 2, backoffMs: 100, cacheMode: 'automatic-prefix' }
  return { lib, policy: { ...defaultPolicy(), pageGenerationConcurrency: cap, batchDelayMs: 0 } }
}

it('A25 1、3、30、50均实际限流，提取纠正核对主题术语父主题跨供应商共享上限', async () => {
  for (const cap of [1, 3, 30, 50]) {
    const { lib, policy } = configured(cap); let active = 0, peak = 0
    const runtime: ModelRuntime = { resolveModelInfo: async (provider, id) => ({ provider, id, name: id }), async *stream() {
      peak = Math.max(peak, ++active); await setImmediate(); active--
      yield { type: 'text-delta', index: 0, text: '{}' }; yield { type: 'finish', reason: { kind: 'stop' } }
    } }
    const client = new ModelClient(runtime, lib, policy)
    const operations = ['extract', 'extract', 'extract', 'topic', 'term', 'parent'] as const
    await Promise.all(Array.from({ length: 90 }, (_, i) => client.call('ingest', '规则', '{}', undefined, [], { operation: operations[i % operations.length]! })))
    expect(peak, '并发=' + cap).toBe(cap); expect(active).toBe(0); expect(client.attempts).toHaveLength(90)
  }
})

it('A26 产品默认3，超并发上限、非整数及非有限值在两条设置校验入口均拒绝', () => {
  expect(defaultPolicy().pageGenerationConcurrency).toBe(3)
  for (const cap of [0, 51, 1.5, NaN, Infinity]) {
    const policy = { ...defaultPolicy(), pageGenerationConcurrency: cap }
    expect(validatePolicy(policy)).toContain(cap === 51 ? 'pageGenerationConcurrency 不能超过并发上限 50。' : 'pageGenerationConcurrency 应为 1～1000 的整数。')
    expect(policySchema.safeParse(policy).success).toBe(false)
  }
})

it('A27 429及503退避释放名额，重试成功只计一个成果且不产生缺口', async () => {
  vi.useFakeTimers()
  const f = auditFixture('研究结果增加20%。'), { lib, policy } = configured(1)
  const starts: { at: number; task: string }[] = []; let attempt = 0
  const runtime: ModelRuntime = { resolveModelInfo: async (provider, id) => ({ provider, id, name: id }), async *stream(options) {
    const input = (options.messages[0]!.content[0] as { text: string }).text
    starts.push({ at: Date.now(), task: input === '插队' ? '插队' : '提取' })
    if (input !== '插队' && attempt++ < 2) throw new ModelCallError('限流暂退', 'http', attempt === 1 ? 429 : 503)
    yield { type: 'text-delta', index: 0, text: input === '插队' ? '{}' : JSON.stringify(envelope([point(f.parts[0]!)])) }; yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const client = new ModelClient(runtime, lib, policy); f.options.client = client; f.processing.model = 'a/audit'
  const start = Date.now(), pending = f.run()
  await vi.advanceTimersByTimeAsync(0)
  expect(await client.call('ingest', '规则', '插队', undefined, [], { operation: 'term' })).toBe('{}')
  expect(starts.find(s => s.task === '插队')!.at).toBe(start)
  await vi.advanceTimersByTimeAsync(300)
  const result = await pending
  expect(result.gaps).toEqual([]); expect(result.segments[0]!.points).toHaveLength(1)
  expect(starts.filter(s => s.task === '提取').map(s => s.at - start)).toEqual([0, 100, 300])
})

it('A28 查询理解与建库同时调用不得绕过统一并发3', async () => {
  const { lib, policy } = configured(3); lib.queryUnderstanding = { model: { provider: 'a', model: 'audit' } }
  let active = 0, peak = 0
  const runtime: ModelRuntime = { resolveModelInfo: async (provider, id) => ({ provider, id, name: id }), async *stream() {
    peak = Math.max(peak, ++active); await setImmediate(); active--
    yield { type: 'text-delta', index: 0, text: '{"variants":["临床证据"]}' }; yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const client = new ModelClient(runtime, lib, policy)
  await Promise.all([client.call('ingest', '规则', '{}', undefined, [], { operation: 'extract' }),
    ...Array.from({ length: 30 }, () => understandQuery('研究效果', [], lib, runtime))])
  expect(active).toBe(0); expect(peak).toBeLessThanOrEqual(3)
})
