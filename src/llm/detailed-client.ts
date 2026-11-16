import type { GenerateOptions, ImageBlock, TokenUsage } from '@deepseek-ai/dsh-llm'
import { StagePolicyError } from '../domain/stage-policy.js'
import { defaultProviderProfile } from '../domain/config.js'
import type { LibraryPolicy } from '../domain/policy.js'
import { ModelCallError, isModelTransportError } from './client.js'
import type { ModelCallOptions, ModelRuntime } from './client.js'
import { jsonProtocol, registerStructuredSchema, strictSchema } from './protocol.js'
import { stageScheduler } from './scheduler.js'
import type { StageScheduler } from './scheduler.js'
import { ExecutionError, executionRun, frozen, inRetryScope, interruptible, limitedSignal, positive, shareTask, snapshot } from './execution.js'
import type { CallDetailedResult, CandidateDescriptor, DetailedAttempt, DetailedExecution, RetryScopeState, StageBudget } from './execution.js'

export interface DetailedCallOptions extends Omit<ModelCallOptions, 'operation'> { execution: DetailedExecution }
export interface ResponseMetadata { reportedModel?: string; requestId?: string }

function budgetFor(execution: DetailedExecution, candidate: CandidateDescriptor, request: { system: string; input: string; images: ImageBlock[] }): StageBudget | undefined {
  let budget: StageBudget
  try { budget = execution.budget(candidate, request) }
  catch (error) { if (error instanceof StagePolicyError) return undefined; throw error }
  const capability = candidate.capabilities
  if (!budget || budget.candidateId !== candidate.candidateId || budget.capabilityRevision !== candidate.capabilityRevision)
    throw new ExecutionError('CAPABILITY_UNKNOWN', `候选 ${candidate.lineId} 的阶段预算与能力修订不一致。`)
  positive(budget.inputLimitBytes, 'inputLimitBytes'); positive(budget.maxOutputTokens, 'maxOutputTokens')
  if (!Number.isSafeInteger(budget.estimatedInputTokens) || budget.estimatedInputTokens < 0)
    throw new ExecutionError('INVALID_EXECUTION', '估算输入 Token 必须为非负整数。')
  if (Buffer.byteLength(request.system + request.input) > budget.inputLimitBytes
    || budget.estimatedInputTokens + budget.maxOutputTokens > capability.contextWindowTokens
    || budget.maxOutputTokens > capability.maxOutputTokens
    || typeof candidate.parameters.maxOutputTokens === 'number' && candidate.parameters.maxOutputTokens > budget.maxOutputTokens
    || request.images.length > 0 && !capability.inputModalities.includes('image')) return undefined
  return snapshot(budget)
}
function validateExecution(execution: DetailedExecution): void {
  if (!execution.taskId || !execution.runId || !execution.retryScopeId || !execution.operation || !execution.stagePlan?.executionRevision)
    throw new ExecutionError('INVALID_EXECUTION', '缺少任务、运行、重试域或执行快照身份。')
  for (const key of ['maxAttempts', 'maxAttemptsPerLine', 'deadlineMs'] as const) positive(execution.retry[key], key)
  if (execution.retry.maxAttemptsPerLine > execution.retry.maxAttempts) throw new ExecutionError('INVALID_EXECUTION', '每线重试上限不能超过总上限。')
  for (const name of ['beforeAttempt', 'onDispatch', 'afterAttempt', 'releaseAttempt'] as const)
    if (typeof execution.hooks?.[name] !== 'function') throw new ExecutionError('INVALID_EXECUTION', `缺少 IF-51 ${name}。`)
  if (typeof execution.checkpoint?.openScope !== 'function' || typeof execution.checkpoint.allocateAttempt !== 'function' || typeof execution.budget !== 'function')
    throw new ExecutionError('INVALID_EXECUTION', '缺少 B2 阶段预算或 B3 执行检查点适配。')
  const lines = new Set<string>(), ids = new Set<string>()
  for (const candidate of execution.stagePlan.candidates) {
    if (!candidate.lineId || !candidate.provider || !candidate.requestedModel || !candidate.bindingRevision)
      throw new ExecutionError('LINE_UNBOUND', '候选线路尚未完整绑定。')
    if (!candidate.candidateId || lines.has(candidate.lineId) || ids.has(candidate.candidateId)) throw new ExecutionError('INVALID_EXECUTION', '阶段候选必须去重。')
    lines.add(candidate.lineId); ids.add(candidate.candidateId)
    const capability = candidate.capabilities, limits = candidate.limits
    if (!capability || !candidate.capabilityRevision || !capability.source || !capability.validationRevision || !capability.inputModalities?.length)
      throw new ExecutionError('CAPABILITY_UNKNOWN', `线路 ${candidate.lineId} 缺少能力描述。`)
    positive(capability.contextWindowTokens, 'contextWindowTokens'); positive(capability.maxOutputTokens, '能力 maxOutputTokens')
    for (const key of ['maxConcurrency', 'initialConcurrency', 'minConcurrency'] as const) positive(limits[key], key)
    if (limits.minConcurrency > limits.initialConcurrency || limits.initialConcurrency > limits.maxConcurrency)
      throw new ExecutionError('INVALID_EXECUTION', '候选并发必须满足 min ≤ initial ≤ max。')
    if (limits.rpm !== undefined) positive(limits.rpm, '候选 rpm')
    if (limits.tpm !== undefined) positive(limits.tpm, '候选 tpm')
    for (const [name, parameter] of Object.entries(candidate.parameters)) {
      if (parameter === 'runtime-default') continue
      if (name === 'reasoningEffort' && typeof parameter === 'string' && capability.reasoningEfforts.includes(parameter)) continue
      if (name === 'temperature' && typeof parameter === 'number' && Number.isFinite(parameter) && parameter >= 0) continue
      if (name === 'maxOutputTokens' && typeof parameter === 'number' && Number.isSafeInteger(parameter) && parameter > 0 && parameter <= capability.maxOutputTokens) continue
      throw new ExecutionError('INVALID_EXECUTION', `线路 ${candidate.lineId} 的参数 ${name} 不受支持。`)
    }
    if (!candidate.parameters.reasoningEffort || candidate.parameters.temperature === undefined || candidate.parameters.maxOutputTokens === undefined)
      throw new ExecutionError('INVALID_EXECUTION', '候选缺省参数必须显式解析。')
  }
}
function usageTokens(usage: TokenUsage | null): number | undefined {
  // dsh TokenUsage 的输入与缓存互不重叠，推理 Token 已包含在输出中。
  return usage ? usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0) + usage.outputTokens : undefined
}
function retryAfter(error: unknown): number | null {
  if (!error || typeof error !== 'object') return null
  const data = error as { providerRetryAfterMs?: number; retryAfterMs?: number; headers?: Headers | Record<string, string> }
  const value = data.providerRetryAfterMs ?? data.retryAfterMs
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  const header = data.headers instanceof Headers ? data.headers.get('retry-after') : data.headers?.['retry-after']
  if (!header) return null
  const seconds = Number(header)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000
  const date = Date.parse(header)
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null
}
function failureCode(error: unknown): string {
  return error && typeof error === 'object' && 'code' in error ? String(error.code) : error instanceof Error ? error.name : 'unknown'
}
function disabledCandidate(error: unknown): boolean {
  const status = error && typeof error === 'object' && 'status' in error ? error.status : undefined
  return status === 401 || status === 403 || status === 404 || ['MODEL_NOT_FOUND', 'AUTHENTICATION', 'CONFIGURATION', 'INVALID_MODEL'].includes(failureCode(error).toUpperCase())
}
async function ledger<T>(work: () => Promise<T>, timeoutMs: number): Promise<T> {
  const guard = limitedSignal(new AbortController().signal, timeoutMs, new ExecutionError('LEDGER_WRITE_FAILED', '尝试账本回调超时。'))
  try { return await interruptible(Promise.resolve().then(work), guard.signal) }
  catch (error) { throw new ExecutionError('LEDGER_WRITE_FAILED', '尝试账本未完成持久化。', { cause: error }) }
  finally { guard.dispose() }
}

/** 使用已解析候选；不再查询模型目录，不提交业务接受。 */
export async function callDetailed(runtime: ModelRuntime, libraryId: string, policy: LibraryPolicy, system: string, input: string,
  signal: AbortSignal | undefined, images: ImageBlock[], options: DetailedCallOptions, scheduler: StageScheduler = stageScheduler,
  backoffs: Readonly<Record<string, number>> = {}): Promise<CallDetailedResult> {
  validateExecution(options.execution)
  const queuedAt = Date.now(), provided = options.execution
  // 运行参数和候选固化；函数接点保留，不能序列化闭包。
  const execution: DetailedExecution = { ...provided, stagePlan: snapshot(provided.stagePlan), retry: snapshot(provided.retry), modelExecution: snapshot(provided.modelExecution) }
  const frozenPolicy = snapshot(policy), schema = options.structuredSchema ? snapshot(options.structuredSchema) : undefined
  if (schema) { registerStructuredSchema(schema.name, schema.schema); system = jsonProtocol(system, schema.schema) }
  const request = snapshot({ system, input, images: structuredClone(images) })
  const run = executionRun(execution)
  run.check()
  scheduler.configure(execution.modelExecution)
  return shareTask(execution.taskId, signal, async taskSignal => {
    const initial = limitedSignal(taskSignal, execution.retry.deadlineMs, new ExecutionError('DEADLINE_EXCEEDED', '逻辑任务已到截止时间。'))
    try {
      return await inRetryScope(JSON.stringify([execution.runId, execution.retryScopeId]), initial.signal, async () => {
        const state = structuredClone(await interruptible(execution.checkpoint.openScope(execution.runId, execution.retryScopeId, queuedAt, execution.retry), initial.signal))
        const deadline = limitedSignal(initial.signal, state.deadlineAt - Date.now(), new ExecutionError('DEADLINE_EXCEEDED', '恢复任务已到原截止时间。'))
        try { return await execute(state, deadline.signal) } finally { deadline.dispose() }
      })
    } finally { initial.dispose() }
  })

  async function execute(state: RetryScopeState, runSignal: AbortSignal): Promise<CallDetailedResult> {
    const attempts: DetailedAttempt[] = [], candidates = execution.stagePlan.candidates, disabled = new Set<string>()
    const perLine = state.attemptsPerLine
    let lastError: unknown, floor = 0
    if (!Number.isFinite(state.deadlineAt) || !Number.isSafeInteger(state.attempts) || state.attempts < 0) throw new ExecutionError('INVALID_CHECKPOINT', '重试域检查点无效。')
    if (state.visitedLines.length) {
      floor = candidates.findIndex(candidate => candidate.lineId === state.visitedLines.at(-1))
      if (floor < 0) throw new ExecutionError('EXECUTION_CHANGED', '自动恢复必须使用原候选执行快照。')
    }
    try {
      while (true) {
        runSignal.throwIfAborted()
        run.check()
        if (Date.now() >= state.deadlineAt) throw new ExecutionError('DEADLINE_EXCEEDED', '逻辑任务已到原截止时间。')
        if (state.attempts >= execution.retry.maxAttempts) throw new ExecutionError('ATTEMPTS_EXHAUSTED', '逻辑任务的实际尝试已达上限。', { cause: lastError })
        const eligible = candidates.slice(floor).filter(candidate => !disabled.has(candidate.lineId)
          && !run.disabled.has(JSON.stringify([candidate.lineId, candidate.bindingRevision]))
          && (perLine[candidate.lineId] ?? 0) < execution.retry.maxAttemptsPerLine
          && (!state.visitedLines.includes(candidate.lineId) || state.visitedLines.at(-1) === candidate.lineId))
        if (!eligible.length) throw new ExecutionError('ATTEMPTS_EXHAUSTED', '剩余候选的尝试额度已用完或线路已禁用。', { cause: lastError })
        const compatible = eligible.flatMap(candidate => { const budget = budgetFor(execution, candidate, request); return budget ? [{ candidate, budget }] : [] })
        if (!compatible.length) throw new StagePolicyError('NO_COMPATIBLE_CANDIDATE', execution.stagePlan.stage, 0, eligible.map(c => c.lineId).join(','), '没有候选可容纳完整输入。')
        const lease = await scheduler.acquire({ libraryId, libraryLimit: frozenPolicy.concurrencyLimit, callLimit: frozenPolicy.pageGenerationConcurrency,
          selection: execution.stagePlan.selection, candidates: compatible, signal: runSignal })
        let terminal: DetailedAttempt | undefined
        try {
          const candidate = lease.selected.candidate
          runSignal.throwIfAborted()
          run.check()
          if (schema && candidate.capabilities.structuredOutput === 'native' && !runtime.supportsStructuredOutput?.(candidate.provider, candidate.requestedModel))
            throw new ExecutionError('CAPABILITY_UNKNOWN', '宿主未提供候选声明的原生结构化输出。')
          const checked = budgetFor(execution, candidate, request)
          if (!checked || JSON.stringify(checked) !== JSON.stringify(lease.selected.budget)) {
            // 入队后预算改变时重新准入，旧 Token 预留不能承接扩大后的请求。
            if (!checked) disabled.add(candidate.lineId)
            continue
          }
          const allocated = await interruptible(execution.checkpoint.allocateAttempt(execution.runId), runSignal)
          if (!Number.isSafeInteger(allocated.sequence) || allocated.sequence < 1 || allocated.attemptId !== `a:${execution.runId}:${allocated.sequence}`)
            throw new ExecutionError('INVALID_CHECKPOINT', '持久尝试序号无效。')
          const attemptRequest = snapshot({ runId: execution.runId, taskId: execution.taskId, retryScopeId: execution.retryScopeId,
            attemptId: allocated.attemptId, stage: execution.stagePlan.stage, operation: execution.operation, candidate,
            estimatedInputTokens: checked.estimatedInputTokens, maxOutputTokens: checked.maxOutputTokens, priceSnapshot: candidate.priceSnapshot })
          const timeoutMs = frozenPolicy.ingestRequestTimeoutSeconds * 1000
          const reservationGuard = limitedSignal(runSignal, timeoutMs, new ExecutionError('RESERVATION_TIMEOUT', '预算预留超时。'))
          const pendingReservation = Promise.resolve().then(() => execution.hooks.beforeAttempt(attemptRequest))
          let reservation: Awaited<ReturnType<DetailedExecution['hooks']['beforeAttempt']>>
          try { reservation = await interruptible(pendingReservation, reservationGuard.signal) }
          catch (error) {
            // B3 若在本地取消后才完成预留，补偿释放，不再进入派发。
            run.cleanup(pendingReservation.then(async result => {
              if (result.status === 'reserved') await ledger(() => execution.hooks.releaseAttempt(result.reservationId, '预留期间已取消或超时'), timeoutMs)
            }))
            throw error
          } finally { reservationGuard.dispose() }
          if (reservation.status === 'paused') throw new ExecutionError('BUDGET_PAUSED', reservation.reason)
          const reservationId = reservation.reservationId
          let intent = false, settled = false
          const attemptGuard = limitedSignal(runSignal, timeoutMs, new ExecutionError('REQUEST_TIMEOUT', '模型请求超时。'))
          const startedAt = Date.now()
          terminal = { attemptId: allocated.attemptId, sequence: allocated.sequence, taskId: execution.taskId, runId: execution.runId,
            retryScopeId: execution.retryScopeId, candidate, queuedAt, startedAt, durationMs: 0, reservationId, state: 'unknown', status: null,
            provider: candidate.provider, model: candidate.requestedModel, reportedModel: null, usage: null, requestId: null,
            errorCategory: null, localExitStatus: 'error', retryAfterMs: null, retryAfterMissing: false }
          let output = '', finished = false, health: 'success' | 'failure' | 'neutral' = 'neutral', delay = 0
          try {
            attemptGuard.signal.throwIfAborted()
            run.check()
            const dispatch = Promise.resolve().then(() => execution.hooks.onDispatch(reservationId))
            // 回调挂起时无法证明意图未落盘，保守占用预算；绝不补发请求。
            try { await interruptible(dispatch, attemptGuard.signal) }
            catch (error) {
              if (attemptGuard.signal.aborted) { intent = true; lease.commit() }
              run.fail(error)
              throw error
            }
            intent = true; lease.commit(); state.attempts++; perLine[candidate.lineId] = (perLine[candidate.lineId] ?? 0) + 1
            if (state.visitedLines.at(-1) !== candidate.lineId) state.visitedLines.push(candidate.lineId)
            floor = candidates.indexOf(candidate)
            attemptGuard.signal.throwIfAborted()
            run.check()
            const parameters = candidate.parameters, native = schema && candidate.capabilities.structuredOutput === 'native'
            const generate = { provider: candidate.provider, model: candidate.requestedModel, system: request.system,
              messages: [{ role: 'user', content: [{ type: 'text', text: request.input }, ...request.images] }], signal: attemptGuard.signal,
              ...(parameters.reasoningEffort !== 'runtime-default' ? { reasoningEffort: parameters.reasoningEffort as NonNullable<GenerateOptions['reasoningEffort']> } : {}),
              ...(typeof parameters.temperature === 'number' ? { temperature: parameters.temperature } : {}),
              ...(typeof parameters.maxOutputTokens === 'number' ? { maxTokens: parameters.maxOutputTokens } : {}),
              ...(native ? { responseFormat: { type: 'json_schema', json_schema: { name: schema!.name, strict: true, schema: strictSchema(schema!.schema) } } } : {}) } as GenerateOptions
            const iterator = runtime.stream(generate)[Symbol.asyncIterator]()
            try {
              while (true) {
                const item = await interruptible(iterator.next(), attemptGuard.signal)
                if (item.done) break
                const event = item.value, metadata = runtime.responseMetadata?.(event)
                if (metadata?.reportedModel) terminal.reportedModel = metadata.reportedModel
                if (metadata?.requestId) terminal.requestId = metadata.requestId
                if (event.type === 'text-delta') output += event.text
                if (event.type === 'usage') terminal.usage = structuredClone(event.usage)
                if (event.type === 'finish') {
                  finished = true; terminal.state = 'finished'; terminal.status = 'success'
                  if (event.reason.kind === 'error' || event.reason.kind === 'aborted') {
                    const failure = event.reason.failure
                    terminal.status = event.reason.kind === 'aborted' ? 'cancelled' : 'transport-error'
                    if (failure.requestId) terminal.requestId = String(failure.requestId)
                    throw Object.assign(new ModelCallError(failure.message, failure.code, failure.status), { providerRetryAfterMs: failure.providerRetryAfterMs })
                  }
                  if (event.reason.kind !== 'stop') throw new ModelCallError('模型输出未完整结束：' + event.reason.kind, event.reason.kind)
                  break
                }
              }
            } finally {
              const closing = iterator.return?.()
              if (closing) await interruptible(closing, attemptGuard.signal).catch(() => {})
            }
            attemptGuard.signal.throwIfAborted()
            if (!finished) throw new ModelCallError('模型响应缺少终止状态。', 'missing-finish')
            if (!output.trim()) throw new ModelCallError('模型返回空正文。', 'empty-output')
            terminal.localExitStatus = 'completed'; health = 'success'
          } catch (error) {
            if (!intent) throw error
            lastError = error; terminal.errorCategory = failureCode(error)
            const cancelled = runSignal.aborted, timedOut = attemptGuard.signal.aborted && !cancelled
            terminal.localExitStatus = cancelled ? 'cancelled' : timedOut ? 'timeout' : 'error'
            if (!finished) { terminal.state = 'unknown'; terminal.status = null }
            const transport = !cancelled && (timedOut || isModelTransportError(error))
            if (transport) {
              health = 'failure'; terminal.retryAfterMs = retryAfter(error)
              terminal.retryAfterMissing = !!error && typeof error === 'object' && 'status' in error && error.status === 429 && terminal.retryAfterMs === null
              delay = terminal.retryAfterMs ?? (backoffs[candidate.provider] ?? defaultProviderProfile.backoffMs) * 2 ** Math.min((perLine[candidate.lineId] ?? 1) - 1, 10)
            } else if (disabledCandidate(error)) run.disabled.add(JSON.stringify([candidate.lineId, candidate.bindingRevision]))
            else throw error
          } finally {
            attemptGuard.dispose()
            terminal.durationMs = Date.now() - startedAt
            if (intent) {
              attempts.push(snapshot(terminal))
              try { await ledger(() => execution.hooks.afterAttempt(snapshot(terminal!)), timeoutMs); settled = true }
              catch (error) { run.fail(error); throw error }
              finally { lease.finish(health, usageTokens(terminal.usage), delay, terminal.retryAfterMissing) }
            } else {
              try { await ledger(() => execution.hooks.releaseAttempt(reservationId, '确认未派发'), timeoutMs) }
              catch (error) { run.fail(error); throw error }
            }
          }
          if (settled && terminal.localExitStatus === 'completed') return frozen({ text: output, responseAttemptId: terminal.attemptId,
            attempts: snapshot(attempts), actual: snapshot({ lineId: candidate.lineId, provider: candidate.provider, requestedModel: candidate.requestedModel,
              reportedModel: terminal.reportedModel, parameters: candidate.parameters, bindingRevision: candidate.bindingRevision, capabilityRevision: candidate.capabilityRevision }) })
          runSignal.throwIfAborted()
        } finally { lease.finish('neutral') }
      }
    } catch (error) {
      const failure = error instanceof ExecutionError ? error : new ExecutionError(failureCode(error), error instanceof Error ? error.message : String(error), { cause: error })
      if (error instanceof StagePolicyError) Object.assign(failure, { stagePause: true, stage: error.stage })
      if (error && typeof error === 'object' && 'storageFailure' in error) Object.assign(failure, { storageFailure: true })
      failure.attempts = snapshot(attempts); throw failure
    }
  }
}
