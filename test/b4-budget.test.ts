import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callDetailed } from '../src/llm/detailed-client.js'
import { candidate, fixture, success, failure } from './b4-fixture.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('预算分组', () => {
  it('调用预算计失败尝试，不能换线绕过', async () => {
    const f = fixture(); f.limits.calls = 1; f.setStream(async function* () { yield failure(503, 0) })
    await expect(f.call()).rejects.toMatchObject({ code: 'BUDGET_PAUSED' }); expect(f.sent).toHaveLength(1); expect(f.outcomes).toHaveLength(1)
  })
  it('Token 预算包括最大输出和并行在途预留', async () => {
    const f = fixture(), hold = Promise.withResolvers<void>(); f.limits.tokens = 20
    f.setStream(async function* () { await hold.promise; yield* success })
    const first = f.call(), second = f.call().catch(error => error); await vi.advanceTimersByTimeAsync(0)
    expect((await second).code).toBe('BUDGET_PAUSED'); expect(f.sent).toHaveLength(1); hold.resolve(); await first
  })
  it('费用预算无价格暂停，有价格仍受上限限制', async () => {
    const f = fixture(); f.limits.money = 100; f.execution.stagePlan.candidates[0]!.priceSnapshot = null
    await expect(f.call()).rejects.toMatchObject({ code: 'BUDGET_PAUSED' }); expect(f.sent).toHaveLength(0)
    f.execution.stagePlan.candidates[0]!.priceSnapshot = { input: 1 }; f.limits.money = 1
    await expect(f.call()).rejects.toMatchObject({ code: 'BUDGET_PAUSED' }); expect(f.sent).toHaveLength(0)
  })
  it('阶段纠正护栏暂停保持健康，反馈不能刷新运行预算', async () => {
    const f = fixture(); await f.call('首轮', '库', undefined, '原任务'); f.limits.correction = true
    await expect(f.call('纠正', '库', undefined, '原任务')).rejects.toMatchObject({ code: 'BUDGET_PAUSED' })
    expect(f.scopes.get('原任务')!.attempts).toBe(1); expect(f.sent).toHaveLength(1)
  })
  it('升级零调用上限不发请求、不提交业务接受', async () => {
    const f = fixture(); f.limits.calls = 0
    await expect(f.call()).rejects.toMatchObject({ code: 'BUDGET_PAUSED' }); expect(f.sent).toHaveLength(0); expect(f.outcomes).toEqual([]); expect(f.released).toEqual([])
  })
})

describe('候选预算', () => {
  it('候选太小跳过，所有候选太小明确失败', async () => {
    const f = fixture(); const budget = f.execution.budget
    f.execution.budget = (c, request) => ({ ...budget(c, request), inputLimitBytes: c.lineId === '甲' ? 1 : 1000 })
    const result = await f.call(); expect(result.actual.lineId).toBe('乙'); expect(f.records.size).toBe(1)
    f.execution.budget = (c, request) => ({ ...budget(c, request), inputLimitBytes: 1 })
    await expect(f.call()).rejects.toMatchObject({ code: 'NO_COMPATIBLE_CANDIDATE' }); expect(f.sent).toHaveLength(1)
  })
  it('派发前再次校验实际候选，并释放过时预占', async () => {
    const f = fixture([candidate('甲', 1), candidate('乙', 1)]), budget = f.execution.budget; let checks = 0
    f.execution.budget = (c, request) => ({ ...budget(c, request), inputLimitBytes: c.lineId === '甲' && ++checks > 1 ? 1 : 10000 })
    const result = await f.call(); expect(result.actual.lineId).toBe('乙'); expect(f.sent).toHaveLength(1); expect(f.records.size).toBe(1)
  })
  it('系统提示、Schema 包装和图片一同交给 B2 估算', async () => {
    const f = fixture(), budget = vi.fn(f.execution.budget); f.execution.budget = budget
    await callDetailed(f.runtime, '库', f.policy, '系统提示', '正文', undefined, [{ type: 'image', url: '固定图片' } as never], {
      execution: f.execution, structuredSchema: { name: 'b4_schema', schema: { type: 'object', properties: { value: { type: 'string' } } } },
    }, f.scheduler)
    const request = budget.mock.calls[0]![1]; expect(request.system).toContain('系统提示'); expect(request.system.length).toBeGreaterThan(4); expect(request.images).toHaveLength(1)
    expect([...f.records.values()][0]!.request.estimatedInputTokens).toBeGreaterThan(100)
  })
  it('能力修订不符与缺少能力直接失败，不填造默认能力', async () => {
    const f = fixture(), budget = f.execution.budget; f.execution.budget = (c, request) => ({ ...budget(c, request), capabilityRevision: '旧能力' })
    await expect(f.call()).rejects.toMatchObject({ code: 'CAPABILITY_UNKNOWN' }); expect(f.sent).toHaveLength(0)
    f.execution.stagePlan.candidates[0]!.capabilities = undefined as never
    await expect(f.call()).rejects.toMatchObject({ code: 'CAPABILITY_UNKNOWN' })
  })
  it('缺省参数保留 runtime-default 修订，不猜模型默认值', async () => {
    const f = fixture(); f.execution.stagePlan.candidates[0]!.parameters = { reasoningEffort: 'runtime-default', temperature: 'runtime-default', maxOutputTokens: 'runtime-default' }
    const result = await f.call(); expect(f.sent[0]!.temperature).toBeUndefined(); expect(f.sent[0]!.maxTokens).toBeUndefined()
    expect(result.actual.parameters.temperature).toEqual('runtime-default')
  })
})

describe('持久化取消', () => {
  it('预算预留挂起超时后归还容量，迟到预留补偿释放', async () => {
    const f = fixture(), original = f.execution.hooks.beforeAttempt, hold = Promise.withResolvers<void>(); f.policy.ingestRequestTimeoutSeconds = 1
    f.execution.hooks.beforeAttempt = async request => { await hold.promise; return original(request) }
    const pending = f.call().catch(error => error); await vi.advanceTimersByTimeAsync(1000); expect((await pending).code).toBe('RESERVATION_TIMEOUT')
    hold.resolve(); await vi.advanceTimersByTimeAsync(0); expect(f.released).toHaveLength(1)
    f.execution.hooks.beforeAttempt = original; await f.call(); expect(f.sent).toHaveLength(1)
  })
  it('onDispatch 明确失败释放预留，不发请求也不尝试备用', async () => {
    const f = fixture(); f.execution.hooks.onDispatch = async () => { throw Object.assign(new Error('写盘失败'), { code: 'NETWORK_ERROR' }) }
    await expect(f.call()).rejects.toThrow('写盘失败'); expect(f.sent).toHaveLength(0); expect(f.released).toHaveLength(1); expect(f.outcomes).toEqual([])
  })
  it('onDispatch 期间取消不发送，意图不明保存 unknown', async () => {
    const f = fixture(), abort = new AbortController(), started = Promise.withResolvers<void>(), hold = Promise.withResolvers<void>()
    f.execution.hooks.onDispatch = async () => { started.resolve(); await hold.promise }
    const pending = f.call('取消派发', '库', abort.signal).catch(error => error); await started.promise; abort.abort(new Error('取消')); await pending
    expect(f.sent).toHaveLength(0); expect(f.released).toEqual([]); expect(f.outcomes[0]).toMatchObject({ state: 'unknown', localExitStatus: 'cancelled' }); hold.resolve()
    await expect(f.call('取消后的反馈', '库', undefined, '取消派发')).rejects.toMatchObject({ code: 'LEDGER_WRITE_FAILED' })
  })
  it('afterAttempt 失败不重复结算也不伪装传输错误重试', async () => {
    const f = fixture(), settle = vi.fn(async () => { throw Object.assign(new Error('账本不可写'), { code: 'NETWORK_ERROR' }) }); f.execution.hooks.afterAttempt = settle
    await expect(f.call()).rejects.toMatchObject({ code: 'LEDGER_WRITE_FAILED' }); expect(settle).toHaveBeenCalledTimes(1); expect(f.sent).toHaveLength(1)
  })
  it('最后订阅者取消后不回收已派发预算，无挂起流槽泄漏', async () => {
    const f = fixture([candidate('甲', 1)]), abort = new AbortController(); f.setStream(() => ({ [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}), return: () => new Promise(() => {}) }) }))
    const pending = f.call('挂起请求', '库', abort.signal).catch(error => error); await vi.advanceTimersByTimeAsync(0); abort.abort(new Error('停止')); await pending
    expect(f.released).toEqual([]); expect(f.outcomes[0]!.state).toBe('unknown')
    f.setStream(async function* () { yield* success }); await f.call(); expect(f.sent).toHaveLength(2)
  })
})
