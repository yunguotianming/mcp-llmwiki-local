import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { candidate, fixture, success, failure } from './b4-fixture.js'
import { callDetailed } from '../src/llm/detailed-client.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.useRealTimers() })

describe('容量', () => {
  it('主线满载溢出，所有候选满载时排队，释放后按库轮转', async () => {
    const f = fixture([candidate('甲', 1), candidate('乙', 1)]), holds = Array.from({ length: 4 }, () => Promise.withResolvers<void>())
    f.setStream(async function* (options) { const index = f.sent.indexOf(options); await holds[index]!.promise; yield* success })
    const a = f.call('任务甲', '库一'), b = f.call('任务乙', '库一'), c = f.call('任务丙', '库一'), d = f.call('任务丁', '库二')
    await vi.advanceTimersByTimeAsync(0); expect(f.sent.map(value => value.model)).toEqual(['甲', '乙'])
    holds[0]!.resolve(); await a; await vi.advanceTimersByTimeAsync(0); expect(f.sent).toHaveLength(3)
    expect([...f.records.values()].at(-1)!.request.taskId).toBe('任务丁')
    holds[1]!.resolve(); await b; await vi.advanceTimersByTimeAsync(0); expect(f.sent).toHaveLength(4)
    holds[2]!.resolve(); holds[3]!.resolve(); await Promise.all([c, d])
  })
  it('failover 正常满载等主线，不抢备用', async () => {
    const f = fixture([candidate('甲', 1), candidate('乙', 1)]), hold = Promise.withResolvers<void>()
    f.execution.stagePlan.selection = 'failover'; f.setStream(async function* () { await hold.promise; yield* success })
    const a = f.call(), b = f.call(); await vi.advanceTimersByTimeAsync(0)
    expect(f.sent.map(value => value.model)).toEqual(['甲']); hold.resolve(); await Promise.all([a, b]); expect(f.sent.map(value => value.model)).toEqual(['甲', '甲'])
  })
  it('同账户跨线路跨库共享组限额，独立账户仍可执行', async () => {
    const candidates = [candidate('甲'), candidate('乙'), candidate('丙')]; candidates[1]!.limits.quotaGroupId = candidates[0]!.limits.quotaGroupId
    const f = fixture(candidates), hold = Promise.withResolvers<void>(); f.execution.modelExecution.quotaGroups['账户-甲']!.maxConcurrency = 1
    f.setStream(async function* () { await hold.promise; yield* success })
    const calls = [f.call('一', '库一'), f.call('二', '库二'), f.call('三', '库三')]; await vi.advanceTimersByTimeAsync(0)
    expect(f.sent.map(value => value.model)).toEqual(['甲', '丙', '丙']); hold.resolve(); await Promise.all(calls)
  })
  it('宿主总额与库调用额度均守恒，并拒绝在途换设置', async () => {
    const f = fixture([candidate('甲', 10)]), hold = Promise.withResolvers<void>(); f.execution.modelExecution.globalMaxInFlight = 3; f.policy.pageGenerationConcurrency = 2
    f.setStream(async function* () { await hold.promise; yield* success })
    const calls = [f.call('一', '库一'), f.call('二', '库一'), f.call('三', '库一'), f.call('四', '库二')]; await vi.advanceTimersByTimeAsync(0)
    expect(f.sent).toHaveLength(3)
    expect(() => f.scheduler.configure({ ...f.execution.modelExecution, globalMaxInFlight: 4 })).toThrow('暂停')
    hold.resolve(); await Promise.all(calls); f.scheduler.configure({ ...f.execution.modelExecution, globalMaxInFlight: 4 })
  })
  it('保留默认值，库上限收紧，拒绝超过 1000', async () => {
    const f = fixture([candidate('甲', 50)]), hold = Promise.withResolvers<void>()
    expect(f.policy).toMatchObject({ concurrencyLimit: 50, pageGenerationConcurrency: 3, analysisConcurrency: 1 })
    expect(f.execution.modelExecution.globalMaxInFlight).toBe(1000); expect(f.execution.modelExecution.quotaGroups['账户-甲']!.maxConcurrency).toBe(50)
    f.policy.concurrencyLimit = 1; f.policy.pageGenerationConcurrency = 3; f.setStream(async function* () { await hold.promise; yield* success })
    const a = f.call(), b = f.call(); await vi.advanceTimersByTimeAsync(0); expect(f.sent).toHaveLength(1); hold.resolve(); await Promise.all([a, b])
    expect(() => f.scheduler.configure({ ...f.execution.modelExecution, globalMaxInFlight: 1001 })).toThrow('1000')
  })
})

describe('速率', () => {
  it('RPM 共享额度组按分钟释放', async () => {
    const f = fixture([candidate('甲')]); f.execution.modelExecution.quotaGroups['账户-甲']!.rpm = 1
    await f.call(); const next = f.call(); await vi.advanceTimersByTimeAsync(59999); expect(f.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1); await next; expect(f.sent).toHaveLength(2)
  })
  it('未知 usage 保留输入加输出的 TPM 预占，可靠 usage 可结算', async () => {
    const f = fixture([candidate('甲')]); f.execution.modelExecution.quotaGroups['账户-甲']!.tpm = 14
    await f.call(); const next = f.call(); await vi.advanceTimersByTimeAsync(59999); expect(f.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1); await next; await vi.advanceTimersByTimeAsync(60000)
    f.setStream(async function* () { yield { type: 'usage', usage: { inputTokens: 1, outputTokens: 0, cacheReadTokens: 0 } }; yield* success })
    await f.call(); await f.call(); expect(f.sent).toHaveLength(4)
  })
  it('未派发取消归还 RPM 与 TPM 预占', async () => {
    const f = fixture([candidate('甲')]); f.execution.modelExecution.quotaGroups['账户-甲'] = { maxConcurrency: 1, rpm: 1, tpm: 14 }
    const original = f.execution.hooks.beforeAttempt, started = Promise.withResolvers<void>(), held = Promise.withResolvers<void>()
    f.execution.hooks.beforeAttempt = async request => { started.resolve(); await held.promise; return original(request) }
    const abort = new AbortController(), cancelled = f.call('取消任务', '库', abort.signal).catch(error => error); await started.promise
    abort.abort(new Error('取消预留')); await cancelled; held.resolve(); await vi.advanceTimersByTimeAsync(0)
    f.execution.hooks.beforeAttempt = original; await f.call(); expect(f.sent).toHaveLength(1); expect(f.released).toHaveLength(1)
  })
  it('单次完整请求超过 TPM 立即报错', async () => {
    const f = fixture([candidate('甲')]); f.execution.modelExecution.quotaGroups['账户-甲']!.tpm = 1
    await expect(f.call()).rejects.toMatchObject({ code: 'RATE_BUDGET_EXCEEDED' }); expect(f.sent).toHaveLength(0)
  })
  it('排队取消不产生预留且移除定时唤醒', async () => {
    const f = fixture([candidate('甲')]); f.execution.modelExecution.quotaGroups['账户-甲']!.rpm = 1
    await f.call(); const abort = new AbortController(), pending = f.call('取消队列', '库', abort.signal).catch(error => error)
    await vi.advanceTimersByTimeAsync(0); abort.abort(new Error('取消')); await pending; expect(f.records.size).toBe(1); expect(vi.getTimerCount()).toBe(0)
  })
})

describe('健康', () => {
  it('窗口内只减半一次，连续失败开路，冷却后单探测并缓升', async () => {
    const c = candidate('甲', 8), f = fixture([c]); f.policy.pageGenerationConcurrency = 8
    f.execution.modelExecution.lineBindings['甲']!.adaptive = { enabled: true, healthWindowMs: 30000, minSuccesses: 2, consecutiveFailureLimit: 3, failureRateWindow: 10, failureRateThreshold: 1, cooldownMs: 30000, maxCooldownMs: 60000 }
    f.execution.retry.maxAttempts = 1; f.execution.retry.maxAttemptsPerLine = 1
    f.setStream(async function* () { yield failure(503, 0) })
    await f.call().catch(() => {}); expect(f.scheduler.lineStatus(c).effectiveConcurrency).toBe(4)
    await f.call().catch(() => {}); expect(f.scheduler.lineStatus(c).effectiveConcurrency).toBe(4)
    await f.call().catch(() => {}); expect(f.scheduler.lineStatus(c).state).toBe('open')
    const hold = Promise.withResolvers<void>(); f.setStream(async function* () { await hold.promise; yield* success })
    const a = f.call(), b = f.call(); await vi.advanceTimersByTimeAsync(29999); expect(f.sent).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1); expect(f.sent).toHaveLength(4); expect(f.scheduler.lineStatus(c).state).toBe('half-open')
    hold.resolve(); await Promise.all([a, b]); expect(f.scheduler.lineStatus(c).effectiveConcurrency).toBe(1)
    await vi.advanceTimersByTimeAsync(30000); await f.call(); expect(f.scheduler.lineStatus(c).effectiveConcurrency).toBe(2)
  })
  it('失败率窗口触发开路并且半开失败延长冷却', async () => {
    const c = candidate('甲', 4), f = fixture([c]); f.execution.retry.maxAttempts = 1; f.execution.retry.maxAttemptsPerLine = 1
    f.execution.modelExecution.lineBindings['甲']!.adaptive = { enabled: true, healthWindowMs: 30000, minSuccesses: 2, consecutiveFailureLimit: 5, failureRateWindow: 2, failureRateThreshold: 0.5, cooldownMs: 100, maxCooldownMs: 400 }
    await f.call(); f.setStream(async function* () { yield failure(503, 0) }); await f.call().catch(() => {})
    expect(f.scheduler.lineStatus(c).state).toBe('open'); const next = f.call().catch(error => error)
    await vi.advanceTimersByTimeAsync(100); await next
    expect(f.scheduler.lineStatus(c).nextProbeAt).toBe(Date.now() + 200)
  })
  it('429 透传 Retry-After，未提供时记录缺失并沿用退避', async () => {
    const f = fixture([candidate('甲')]); f.setStream(async function* () { if (f.sent.length === 1) yield failure(429, 5000); else yield* success })
    const pending = f.call(); await vi.advanceTimersByTimeAsync(4999); expect(f.sent).toHaveLength(1)
    await vi.advanceTimersByTimeAsync(1); const result = await pending; expect(result.attempts[0]).toMatchObject({ retryAfterMs: 5000, retryAfterMissing: false })
    f.setStream(async function* () { if (f.sent.length === 3) yield failure(429); else yield* success })
    const missing = f.call(); await vi.advanceTimersByTimeAsync(1999); expect(f.sent).toHaveLength(3)
    await vi.advanceTimersByTimeAsync(1); expect((await missing).attempts[0]!.retryAfterMissing).toBe(true)
  })
  it('业务失败与预算暂停不影响健康，未启用不自动降速', async () => {
    const c = candidate('甲', 8), f = fixture([c]); f.execution.retry.maxAttempts = 1; f.execution.retry.maxAttemptsPerLine = 1
    f.setStream(async function* () { yield failure() }); await f.call().catch(() => {}); expect(f.scheduler.lineStatus(c).effectiveConcurrency).toBe(8)
    f.setStream(async function* () { yield failure(400) }); await vi.advanceTimersByTimeAsync(2000); await f.call().catch(() => {})
    f.limits.correction = true; await f.call().catch(() => {}); expect(f.scheduler.lineStatus(c).state).toBe('healthy')
  })
  it('自适应采用显式初始与最小并发，不突破线路上限', async () => {
    const c = candidate('甲', 10); c.limits.initialConcurrency = 6; c.limits.minConcurrency = 4
    const f = fixture([c]); f.execution.retry.maxAttempts = 1; f.execution.retry.maxAttemptsPerLine = 1
    f.execution.modelExecution.lineBindings['甲']!.adaptive = { enabled: true, healthWindowMs: 100, minSuccesses: 1, consecutiveFailureLimit: 5, failureRateWindow: 10, failureRateThreshold: 1, cooldownMs: 100, maxCooldownMs: 200 }
    f.setStream(async function* () { yield failure(503, 0) }); await f.call().catch(() => {}); expect(f.scheduler.lineStatus(c).effectiveConcurrency).toBe(4)
    f.setStream(async function* () { yield* success }); await vi.advanceTimersByTimeAsync(100); await f.call(); expect(f.scheduler.lineStatus(c).effectiveConcurrency).toBe(5)
  })
})

describe('共享边界', () => {
  it('较小库候选不改写其他库共用线路的宿主容量', async () => {
    const narrow = fixture([candidate('甲', 1)]), wide = fixture([candidate('甲', 4)]), hold = Promise.withResolvers<void>()
    narrow.execution.modelExecution = wide.execution.modelExecution
    await narrow.call()
    wide.setStream(async function* () { await hold.promise; yield* success })
    const calls = ['宽一', '宽二', '宽三'].map(taskId => callDetailed(wide.runtime, '宽库', wide.policy, '规则', '输入', undefined, [], {
      execution: { ...wide.execution, taskId, retryScopeId: taskId },
    }, narrow.scheduler))
    await vi.advanceTimersByTimeAsync(0); expect(wide.sent).toHaveLength(3)
    hold.resolve(); await Promise.all(calls)
  })
})
