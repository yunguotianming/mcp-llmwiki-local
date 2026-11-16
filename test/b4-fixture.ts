import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { ModelRuntime } from '../src/llm/client.js'
import { defaultPolicy } from '../src/domain/policy.js'
import { callDetailed } from '../src/llm/detailed-client.js'
import { StageScheduler } from '../src/llm/scheduler.js'
import type { AttemptRequest, AttemptOutcome, CandidateDescriptor, DetailedExecution, HostExecution, RetryScopeState } from '../src/llm/execution.js'

let serial = 0
export const success: StreamChunk[] = [{ type: 'text-delta', index: 0, text: '完成' }, { type: 'finish', reason: { kind: 'stop' } }]
export const failure = (status = 503, retryAfter?: number): StreamChunk => ({ type: 'finish', reason: { kind: 'error', failure: {
  code: 'SERVER', message: '连接超时', status, ...(retryAfter === undefined ? {} : { providerRetryAfterMs: retryAfter }),
} } })
export function candidate(lineId: string, concurrency = 2): CandidateDescriptor {
  return { candidateId: 'candidate-' + lineId, lineId, provider: '供应商', requestedModel: lineId, bindingRevision: 'binding-v1', capabilityRevision: 'cap-v1',
    parameters: { reasoningEffort: 'high', temperature: 0.2, maxOutputTokens: 10 },
    capabilities: { contextWindowTokens: 10000, maxOutputTokens: 100, inputModalities: ['text', 'image'], reasoningEfforts: ['high'], structuredOutput: 'prompt-validated', streaming: true, source: '桩', validationRevision: 'v1' },
    limits: { quotaGroupId: '账户-' + lineId, maxConcurrency: concurrency, initialConcurrency: concurrency, minConcurrency: 1 }, priceSnapshot: { currency: 'CNY', unit: 1, input: 1, cacheRead: 1, cacheWrite: 1, output: 1, priceRevision: 'v1' }, qualityEvidence: [] }
}
export function host(candidates: CandidateDescriptor[], globalMaxInFlight = 1000): HostExecution {
  return { globalMaxInFlight, lineBindings: Object.fromEntries(candidates.map(item => [item.lineId, { provider: item.provider, ...item.limits }])),
    quotaGroups: Object.fromEntries(candidates.map(item => [item.limits.quotaGroupId, { maxConcurrency: 50 }])) }
}
export function fixture(candidates = [candidate('甲'), candidate('乙')]) {
  const runId = `运行-${++serial}`, scopes = new Map<string, RetryScopeState>(), records = new Map<string, { request: AttemptRequest; state: string; tokens: number }>()
  let sequence = 0
  const outcomes: AttemptOutcome[] = [], released: string[] = [], events: string[] = [], sent: GenerateOptions[] = []
  const limits: { calls?: number; tokens?: number; money?: number; correction?: boolean } = {}
  const scheduler = new StageScheduler(), modelExecution = host(candidates), policy = { ...defaultPolicy(), batchDelayMs: 0, ingestRequestTimeoutSeconds: 10 }
  const execution: DetailedExecution = {
    taskId: `t:${runId}`, runId, retryScopeId: '原任务', operation: 'extract', modelExecution,
    stagePlan: { stage: 'extract', selection: 'priority-spillover', candidates, executionRevision: 'execution-v1' },
    retry: { maxAttempts: 4, maxAttemptsPerLine: 2, deadlineMs: 120000 },
    checkpoint: {
      async openScope(_runId, scopeId, queuedAt, retry) {
        if (!scopes.has(scopeId)) scopes.set(scopeId, { attempts: 0, attemptsPerLine: {}, visitedLines: [], deadlineAt: queuedAt + retry.deadlineMs })
        return structuredClone(scopes.get(scopeId)!)
      },
      async allocateAttempt() { sequence++; return { attemptId: `a:${runId}:${sequence}`, sequence } },
    },
    hooks: {
      async beforeAttempt(request) {
        events.push('预留'); const active = [...records.values()].filter(record => record.state !== 'released')
        const tokens = request.estimatedInputTokens + request.maxOutputTokens
        if (limits.correction || limits.calls !== undefined && active.length >= limits.calls
          || limits.tokens !== undefined && active.reduce((sum, record) => sum + record.tokens, 0) + tokens > limits.tokens
          || limits.money !== undefined && (request.priceSnapshot === null || active.reduce((sum, record) => sum + record.tokens, 0) + tokens > limits.money))
          return { status: 'paused', reason: '预算到限' }
        const reservationId = '预留-' + request.attemptId
        records.set(reservationId, { request, tokens, state: 'reserved' }); return { status: 'reserved', reservationId }
      },
      async onDispatch(id) {
        events.push('派发'); const record = records.get(id)!; record.state = 'dispatched'
        const scope = scopes.get(record.request.retryScopeId)!, line = record.request.candidate.lineId
        scope.attempts++; scope.attemptsPerLine[line] = (scope.attemptsPerLine[line] ?? 0) + 1
        if (scope.visitedLines.at(-1) !== line) scope.visitedLines.push(line)
      },
      async afterAttempt(outcome) { events.push('终态'); outcomes.push(structuredClone(outcome)); records.get(outcome.reservationId)!.state = outcome.state },
      async releaseAttempt(id) { events.push('释放'); released.push(id); records.get(id)!.state = 'released' },
    },
    budget(item, request) { return { candidateId: item.candidateId, capabilityRevision: item.capabilityRevision, inputLimitBytes: item.capabilities.contextWindowTokens - 100,
      estimatedInputTokens: Math.ceil(Buffer.byteLength(request.system + request.input) / 4) + request.images.length * 100, maxOutputTokens: 10 } },
  }
  let stream: (options: GenerateOptions) => AsyncIterable<StreamChunk> = async function* () { yield* success }
  const runtime: ModelRuntime = { async resolveModelInfo() { throw new Error('新入口不能再次解析目录') }, async *stream(options) { sent.push(options); events.push('请求'); yield* stream(options) } }
  return { execution, policy, runtime, scheduler, sent, outcomes, records, scopes, released, events, limits,
    setStream(work: typeof stream) { stream = work },
    call(task = `任务-${++serial}`, libraryId = '库', signal?: AbortSignal, scope = task) {
      return callDetailed(runtime, libraryId, policy, '规则', '输入', signal, [], { execution: { ...execution, taskId: task, retryScopeId: scope } }, scheduler)
    },
  }
}
