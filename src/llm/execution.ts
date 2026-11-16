import type { ImageBlock, TokenUsage } from '@deepseek-ai/dsh-llm'

import type { StageId } from '../domain/route-schema.js'
import type { CandidateDescriptor, StagePlan } from '../domain/stage-policy.js'
export type { StageId, CandidateDescriptor, StagePlan }
export interface StageBudget {
  candidateId: string; inputLimitBytes: number; estimatedInputTokens: number; maxOutputTokens: number; capabilityRevision: string
}
export interface RetryPolicy { maxAttempts: number; maxAttemptsPerLine: number; deadlineMs: number }
export interface RetryScopeState {
  attempts: number; attemptsPerLine: Record<string, number>; visitedLines: string[]; deadlineAt: number
}
// B3 把这两个适配操作映射到自己的运行头；B4 不规定文件格式，也不自行落盘。
export interface ExecutionCheckpoint {
  openScope(runId: string, retryScopeId: string, queuedAt: number, retry: RetryPolicy): Promise<RetryScopeState>
  allocateAttempt(runId: string): Promise<{ attemptId: string; sequence: number }>
}
export interface AttemptRequest {
  runId: string; taskId: string; retryScopeId: string; attemptId: string; stage: StageId; operation: string
  candidate: CandidateDescriptor; estimatedInputTokens: number; maxOutputTokens: number; priceSnapshot: CandidateDescriptor['priceSnapshot']
}
export interface AttemptOutcome {
  attemptId: string; reservationId: string; state: 'finished' | 'unknown'
  status: 'success' | 'transport-error' | 'cancelled' | null
  provider: string; model: string; reportedModel: string | null; usage: TokenUsage | null; requestId: string | null
  errorCategory: string | null; localExitStatus: 'completed' | 'error' | 'cancelled' | 'timeout'
}
export interface AttemptHooks {
  beforeAttempt(request: AttemptRequest): Promise<{ status: 'reserved'; reservationId: string } | { status: 'paused'; reason: string }>
  onDispatch(reservationId: string): Promise<void>
  afterAttempt(outcome: AttemptOutcome): Promise<void>
  releaseAttempt(reservationId: string, reason: string): Promise<void>
}
export interface AdaptiveOptions {
  enabled: boolean; healthWindowMs: number; minSuccesses: number; consecutiveFailureLimit: number
  failureRateWindow: number; failureRateThreshold: number; cooldownMs: number; maxCooldownMs: number
}
export interface QuotaLimits { maxConcurrency: number; rpm?: number; tpm?: number }
export interface HostExecution {
  globalMaxInFlight: number
  quotaGroups: Record<string, QuotaLimits>
  lineBindings: Record<string, { provider: string; quotaGroupId: string; maxConcurrency: number; initialConcurrency: number; minConcurrency: number; adaptive?: AdaptiveOptions }>
}
export interface DetailedExecution {
  taskId: string; runId: string; retryScopeId: string; stagePlan: StagePlan; hooks: AttemptHooks
  retry: RetryPolicy; checkpoint: ExecutionCheckpoint; modelExecution: HostExecution
  operation: string
  // B2 接收已包装的完整请求，返回阶段预算；派发前再次调用，不复制其窗口算法。
  budget(candidate: CandidateDescriptor, request: { system: string; input: string; images: ImageBlock[] }): StageBudget
}
export interface ActualModel {
  lineId: string; provider: string; requestedModel: string; reportedModel: string | null
  parameters: CandidateDescriptor['parameters']; bindingRevision: string; capabilityRevision: string
}
export interface DetailedAttempt extends AttemptOutcome {
  taskId: string; runId: string; retryScopeId: string; sequence: number; candidate: CandidateDescriptor
  queuedAt: number; startedAt: number; durationMs: number; retryAfterMs: number | null; retryAfterMissing: boolean
}
export interface CallDetailedResult { text: string; responseAttemptId: string; attempts: readonly Readonly<DetailedAttempt>[]; actual: ActualModel }
export class ExecutionError extends Error {
  readonly budgetPause: boolean
  attempts: readonly Readonly<DetailedAttempt>[] = []
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options); this.name = 'ExecutionError'; this.budgetPause = code === 'BUDGET_PAUSED'
    if (code.startsWith('LEDGER_')) Object.assign(this, { storageFailure: true })
  }
}
export function positive(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) throw new ExecutionError('INVALID_EXECUTION', `${name} 必须为有限正整数。`)
}
export function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value) }
  return value
}
export function snapshot<T>(value: T): T { return frozen(structuredClone(value)) }
interface RunState {
  revisions: Map<StageId, string>
  disabled: Set<string>
  pendingCleanup: number
  failure?: unknown
}
const runs = new Map<string, RunState>()
// 显式续跑使用新 runId；落盘结果不确定的旧运行保留现场，不能通过新 taskId 绕过。
export function executionRun(execution: DetailedExecution) {
  let state = runs.get(execution.runId)
  if (!state) {
    state = { revisions: new Map(), disabled: new Set(), pendingCleanup: 0 }
    runs.set(execution.runId, state)
  }
  const run = state, { stage, executionRevision } = execution.stagePlan
  const prior = run.revisions.get(stage)
  if (prior !== undefined && prior !== executionRevision)
    throw new ExecutionError('EXECUTION_CHANGED', '执行快照变更须暂停后以新 runId 续跑。')
  run.revisions.set(stage, executionRevision)
  return {
    disabled: run.disabled,
    check() {
      if (run.failure !== undefined) throw new ExecutionError('LEDGER_WRITE_FAILED', '运行账本需恢复确认后显式续跑。', { cause: run.failure })
      if (run.pendingCleanup) throw new ExecutionError('LEDGER_PENDING', '运行仍有待确认的预留清理。')
    },
    fail(error: unknown) { run.failure = error ?? new Error('账本状态不确定。') },
    cleanup(work: Promise<unknown>) {
      run.pendingCleanup++
      void work.catch(error => { run.failure = error ?? new Error('预留清理失败。') }).finally(() => { run.pendingCleanup-- })
    },
  }
}
export function limitedSignal(signal: AbortSignal, milliseconds: number, reason: Error): { signal: AbortSignal; dispose: () => void } {
  const timerAbort = new AbortController()
  const timer = setTimeout(() => timerAbort.abort(reason), Math.min(2_147_483_647, Math.max(0, milliseconds)))
  return { signal: AbortSignal.any([signal, timerAbort.signal]), dispose: () => clearTimeout(timer) }
}
export function interruptible<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) reject(signal.reason)
    else signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort)).catch(() => {})
  })
}
// 同一重试域串行承接反馈调用；不同重试域可以并行派发。
const scopeTails = new Map<string, Promise<void>>()
export async function inRetryScope<T>(key: string, signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  const prior = scopeTails.get(key) ?? Promise.resolve()
  let release!: () => void
  const hold = new Promise<void>(resolve => { release = resolve })
  const tail = prior.then(() => hold)
  scopeTails.set(key, tail)
  try { await interruptible(prior, signal); signal.throwIfAborted(); return await work() }
  finally { release(); void tail.then(() => { if (scopeTails.get(key) === tail) scopeTails.delete(key) }) }
}
interface SharedTask { abort: AbortController; promise: Promise<CallDetailedResult>; subscribers: number }
const tasks = new Map<string, SharedTask>()
export async function shareTask(taskId: string, signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<CallDetailedResult>): Promise<CallDetailedResult> {
  signal?.throwIfAborted()
  let entry = tasks.get(taskId)
  if (entry?.abort.signal.aborted) {
    await entry.promise.catch(() => {}); signal?.throwIfAborted(); return shareTask(taskId, signal, work)
  }
  if (!entry) {
    const abort = new AbortController()
    entry = { abort, subscribers: 0, promise: Promise.resolve().then(() => work(abort.signal)) }
    tasks.set(taskId, entry)
    const current = entry
    void entry.promise.finally(() => { if (tasks.get(taskId) === current) tasks.delete(taskId) }).catch(() => {})
  }
  const shared = entry; shared.subscribers++
  try { return signal ? await interruptible(shared.promise, signal) : await shared.promise }
  finally {
    if (--shared.subscribers === 0 && signal?.aborted) {
      shared.abort.abort(signal.reason)
      // 最后一个订阅者等本地尝试清理完毕；其他订阅者取消不影响执行者。
      await shared.promise.catch(() => {})
    }
  }
}
