import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ModelClient } from '../src/llm/client.js'
import { newLibrary } from '../src/domain/config.js'
import { callDetailed } from '../src/llm/detailed-client.js'
import { candidate, fixture, success, failure } from './b4-fixture.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('身份重试', () => {
  it('有限尝试单向换线，反馈子调用继承访问线路与次数', async () => {
    const f = fixture(); f.execution.retry.maxAttempts = 3
    f.setStream(async function* (options) { if (options.model === '甲') yield failure(503, 0); else yield* success })
    const first = await f.call('生成', '库', undefined, '同一逻辑任务')
    expect(first.attempts.map(item => item.candidate.lineId)).toEqual(['甲', '甲', '乙'])
    await expect(f.call('结构反馈', '库', undefined, '同一逻辑任务')).rejects.toMatchObject({ code: 'ATTEMPTS_EXHAUSTED' })
    expect(f.sent).toHaveLength(3); expect(new Set(first.attempts.map(item => item.attemptId)).size).toBe(3)
  })
  it('恢复读取累计状态，不复用旧序号或返回已访问的线路', async () => {
    const f = fixture(); f.scopes.set('恢复', { attempts: 2, attemptsPerLine: { 甲: 1, 乙: 1 }, visitedLines: ['甲', '乙'], deadlineAt: Date.now() + 10000 })
    await f.execution.checkpoint.allocateAttempt(f.execution.runId); await f.execution.checkpoint.allocateAttempt(f.execution.runId)
    const result = await f.call('恢复任务', '库', undefined, '恢复')
    expect(result.responseAttemptId).toBe(`a:${f.execution.runId}:3`); expect(f.sent.map(item => item.model)).toEqual(['乙'])
  })
  it('恢复截止时间不刷新，排队时间包含在期限内', async () => {
    const f = fixture([candidate('甲')]); f.scopes.set('过期', { attempts: 0, attemptsPerLine: {}, visitedLines: [], deadlineAt: Date.now() - 1 })
    await expect(f.call('过期任务', '库', undefined, '过期')).rejects.toMatchObject({ code: 'DEADLINE_EXCEEDED' })
    f.execution.modelExecution.quotaGroups['账户-甲']!.rpm = 1; await f.call()
    f.execution.retry.deadlineMs = 100; const queued = f.call().catch(error => error)
    await vi.advanceTimersByTimeAsync(100); expect((await queued).code).toBe('DEADLINE_EXCEEDED'); expect(f.sent).toHaveLength(1)
  })
  it('同一 taskId 跨客户端只执行一次，独立订阅取消不取消其他人', async () => {
    const f = fixture(), hold = Promise.withResolvers<void>(), abort = new AbortController()
    f.setStream(async function* () { await hold.promise; yield* success })
    const a = f.call('共享任务', '库', abort.signal), b = f.call('共享任务', '库')
    const cancelled = a.catch(error => error); await vi.advanceTimersByTimeAsync(0); abort.abort(new Error('订阅者取消')); await cancelled
    expect(f.sent).toHaveLength(1); expect(f.sent[0]!.signal!.aborted).toBe(false)
    hold.resolve(); await b
  })
  it('同一运行的并行重试域使用不同的持久序号', async () => {
    const f = fixture(), results = await Promise.all([f.call('并发一'), f.call('并发二'), f.call('并发三')])
    expect(new Set(results.map(item => item.responseAttemptId)).size).toBe(3)
    expect(results.every(item => Object.isFrozen(item.attempts) && Object.isFrozen(item.attempts[0]!.candidate.parameters))).toBe(true)
  })
})

describe('响应契约', () => {
  it('参数沿用候选快照，真实模型缺失为 null，可靠元数据才记录', async () => {
    const f = fixture(), first = await f.call(); expect(first.actual.reportedModel).toBeNull()
    expect(f.sent[0]).toMatchObject({ model: '甲', reasoningEffort: 'high', temperature: 0.2, maxTokens: 10 })
    f.runtime.responseMetadata = event => event.type === 'finish' ? { reportedModel: '真实模型', requestId: '响应编号' } : undefined
    const second = await f.call(); expect(second.actual.reportedModel).toBe('真实模型'); expect(second.attempts[0]!.requestId).toBe('响应编号')
  })
  it('新入口不调用旧预算钩子，业务接受不由 client 提交', async () => {
    const f = fixture(), old = vi.fn(() => { throw new Error('重复预算') })
    const result = await callDetailed(f.runtime, '库', f.policy, '规则', '输入', undefined, [], { execution: f.execution, beforeAttempt: old, onAttempt: old }, f.scheduler)
    expect(result.text).toBe('完成'); expect(old).not.toHaveBeenCalled(); expect(f.events).toEqual(['预留', '派发', '请求', '终态'])
  })
  it('HTTP 状态优先：400 不受 timeout 文本影响，401 转显式候选', async () => {
    const f = fixture(); f.setStream(async function* () { yield failure(400) })
    await expect(f.call()).rejects.toThrow('连接超时'); expect(f.sent).toHaveLength(1)
    f.setStream(async function* (options) { if (options.model === '甲') yield failure(401); else yield* success })
    const result = await f.call(); expect(result.actual.lineId).toBe('乙'); expect(result.attempts).toHaveLength(2)
  })
  it('在途取消与超时保存 unknown，清理本地流且不假退调用额度', async () => {
    const f = fixture([candidate('甲')]), abort = new AbortController(); let closed = 0
    f.setStream(async function* (options) { try { await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true })); options.signal!.throwIfAborted() } finally { closed++ } })
    const pending = f.call('取消在途', '库', abort.signal).catch(error => error); await vi.advanceTimersByTimeAsync(0); abort.abort(new Error('暂停')); await pending
    expect(f.outcomes[0]).toMatchObject({ state: 'unknown', status: null, localExitStatus: 'cancelled' }); expect(f.released).toEqual([]); expect(closed).toBe(1)
    f.execution.retry.maxAttempts = 1; f.execution.retry.maxAttemptsPerLine = 1; f.policy.ingestRequestTimeoutSeconds = 1
    const timed = f.call().catch(error => error); await vi.advanceTimersByTimeAsync(1000); await timed
    expect(f.outcomes[1]).toMatchObject({ state: 'unknown', localExitStatus: 'timeout' }); expect(closed).toBe(2)
  })
  it('真实 ModelClient 新旧入口在不同 runtime 对象之间共享宿主总额', async () => {
    const f = fixture([candidate('甲', 4)]), hold = Promise.withResolvers<void>(); f.execution.modelExecution.globalMaxInFlight = 1
    f.setStream(async function* () { await hold.promise; yield* success })
    const a = new ModelClient(f.runtime, newLibrary('库甲'), f.policy), b = new ModelClient({ ...f.runtime }, newLibrary('库乙'), f.policy)
    const first = a.callDetailed('ingest', '', '', undefined, [], { execution: { ...f.execution, taskId: '全局甲', retryScopeId: '甲' } })
    const second = b.callDetailed('ingest', '', '', undefined, [], { execution: { ...f.execution, taskId: '全局乙', retryScopeId: '乙' } })
    await vi.advanceTimersByTimeAsync(0); expect(f.sent).toHaveLength(1)
    const legacy = new ModelClient({ ...f.runtime, resolveModelInfo: async (provider, id) => ({ provider, id, name: id }) }, newLibrary('旧库'), f.policy)
    const third = legacy.call('ingest', '', '旧调用'); await vi.advanceTimersByTimeAsync(0); expect(f.sent).toHaveLength(1)
    hold.resolve(); await Promise.all([first, second, third]); expect(f.sent).toHaveLength(3)
  })
})

describe('运行边界', () => {
  it('同一运行不能通过新任务热换阶段执行修订', async () => {
    const f = fixture(); await f.call()
    f.execution.stagePlan.executionRevision = 'execution-v2'
    await expect(f.call()).rejects.toMatchObject({ code: 'EXECUTION_CHANGED' }); expect(f.sent).toHaveLength(1)
  })
  it('鉴权失败的绑定在同一运行后续任务中仍禁用', async () => {
    const f = fixture(); f.setStream(async function* (options) { if (options.model === '甲') yield failure(401); else yield* success })
    await f.call(); await f.call()
    expect(f.sent.map(item => item.model)).toEqual(['甲', '乙', '乙'])
  })
  it('预留迟到释放失败会阻止后续任务，保留预留现场', async () => {
    const f = fixture(), before = f.execution.hooks.beforeAttempt, hold = Promise.withResolvers<void>(); f.policy.ingestRequestTimeoutSeconds = 1
    f.execution.hooks.beforeAttempt = async request => { await hold.promise; return before(request) }
    f.execution.hooks.releaseAttempt = async () => { throw new Error('释放落盘失败') }
    const pending = f.call().catch(error => error); await vi.advanceTimersByTimeAsync(1000); await pending
    hold.resolve(); await vi.advanceTimersByTimeAsync(0)
    await expect(f.call()).rejects.toMatchObject({ code: 'LEDGER_WRITE_FAILED' })
    expect(f.sent).toHaveLength(0); expect([...f.records.values()][0]!.state).toBe('reserved')
  })
  it('预留清理未确认前新任务不能刷新预算', async () => {
    const f = fixture(), before = f.execution.hooks.beforeAttempt, hold = Promise.withResolvers<void>(); f.policy.ingestRequestTimeoutSeconds = 1
    f.execution.hooks.beforeAttempt = async request => { await hold.promise; return before(request) }
    const pending = f.call().catch(error => error); await vi.advanceTimersByTimeAsync(1000); await pending
    await expect(f.call()).rejects.toMatchObject({ code: 'LEDGER_PENDING' })
    hold.resolve(); await vi.advanceTimersByTimeAsync(0); f.execution.hooks.beforeAttempt = before
    await f.call(); expect(f.sent).toHaveLength(1); expect(f.released).toHaveLength(1)
  })
  it('终态落盘失败后同一运行的其他重试域也停止派发', async () => {
    const f = fixture(); f.execution.hooks.afterAttempt = async () => { throw new Error('终态不可写') }
    await expect(f.call()).rejects.toMatchObject({ code: 'LEDGER_WRITE_FAILED' })
    await expect(f.call()).rejects.toMatchObject({ code: 'LEDGER_WRITE_FAILED' }); expect(f.sent).toHaveLength(1)
  })
})
