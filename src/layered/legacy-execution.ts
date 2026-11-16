import { effectiveSourceRoots, layeredSettings } from '../domain/config.js'
import { ModelClient } from '../llm/client.js'
import type { ModelAttempt } from '../llm/client.js'
import { ExecutionError } from '../llm/execution.js'
import type { CallDetailedResult } from '../llm/execution.js'
import { taskIdFor } from './accepted.js'
import type { LegacyRecoveryBindings, ResponseAttempt } from './accepted.js'
import { createExecutionLedger, normalizeUsage, recoverExecutionRun } from './costs.js'
import { productionId, protocolDigest, validateAcceptedRecord } from './models.js'
import type { BuildLayeredOptions, ExecutionHooks } from './schema.js'
import { upgradeReviewEstimator, upgradeReviewRunner } from './upgrade.js'
import type { UpgradeOptions } from './upgrade.js'

type LegacyAttempt = ResponseAttempt & { attemptId: string; reservationId: string; actual: CallDetailedResult['actual'] }
async function ledgerIO<T>(work: () => Promise<T>): Promise<T> {
  try { return await work() }
  catch (cause) { throw Object.assign(cause instanceof Error ? cause : new Error(String(cause)), { storageFailure: true }) }
}

/** 原 models 路由补接受与账本；调度、重试及参数继续由旧客户端决定，不构造新策略或质量证据。 */
export function legacyBuildBindings(client: ModelClient, root: string, libraryId: string, topics: BuildLayeredOptions['topics'],
  limits?: { maxCalls?: number | undefined; maxTokens?: number | undefined }, knowledgeRoot?: string) {
  const upgrade = limits ? { ...(limits.maxCalls === undefined ? {} : { maxCalls: limits.maxCalls }),
    ...(limits.maxTokens === undefined ? {} : { maxTokens: limits.maxTokens }) } : undefined
  const { policy } = client.legacyConfiguration(), settings = layeredSettings(topics || {})
  const ledger = createExecutionLedger(root, { ...(settings.maxBuildCalls === undefined ? {} : { maxCalls: settings.maxBuildCalls }),
    ...(settings.maxBuildTokens === undefined ? {} : { maxTokens: settings.maxBuildTokens }) })
  const started = new Map<string, Promise<unknown>>()
  const bind = (hooks: ExecutionHooks = ledger): LegacyRecoveryBindings => ({
    libraryId, hooks, productionId, validateAcceptedRecord,
    async startRun(runId) { if (!started.has(runId)) started.set(runId, recoverExecutionRun(root, runId)); await started.get(runId) },
    async stageInputBudgets(stage, request, maxInputBytes) {
      const limit = await client.inputBudget('ingest', undefined, stage)
      if (!limit) throw new Error('模型未声明可用上下文预算。')
      const maxOutputTokens = policy.maxTokensPerCall || (await client.info('ingest', undefined, undefined, stage)).defaultMaxTokens || 4096
      return [{ inputLimitBytes: Math.min(limit, maxInputBytes ?? Infinity), estimatedInputTokens: Math.ceil(Buffer.byteLength(request.system + request.input) / 4),
        maxOutputTokens }]
    },
    async execute(identity, runId, retryScopeId, operation, args) {
      const taskId = taskIdFor(identity), stage = args[5]?.operation ?? identity.stage
      const attempts: LegacyAttempt[] = [], active = new Map<ModelAttempt, LegacyAttempt>()
      const { onAttempt: _onAttempt, beforeAttempt: _beforeAttempt, ...callOptions } = args[5] ?? {}
      let response: LegacyAttempt | undefined
      try {
        const text = await client.call(args[0], args[1], args[2], args[3], args[4], { ...callOptions,
          lifecycle: {
            async dispatch(attempt, info, options) {
              const parameters = { reasoningEffort: options.reasoningEffort ?? 'runtime-default', temperature: options.temperature ?? 'runtime-default' as const,
                maxOutputTokens: options.maxTokens ?? 'runtime-default' as const }
              if (hooks !== ledger && upgrade?.maxTokens !== undefined && parameters.maxOutputTokens === 'runtime-default')
                throw new ExecutionError('BUDGET_PAUSED', '升级 Token 上限需要明确的输出硬限制。')
              // 旧宿主未暴露的默认值保留 runtime-default；摘要只包含非敏感的已知模型能力。
              const actual: CallDetailedResult['actual'] = { lineId: 'models:' + attempt.route.provider, provider: attempt.route.provider,
                requestedModel: attempt.route.model, reportedModel: null, parameters,
                bindingRevision: protocolDigest({ source: 'legacy-model-info', provider: info.provider, id: info.id }),
                capabilityRevision: protocolDigest({ contextWindow: info.context?.contextWindow ?? null, inputModalities: info.inputModalities ?? null,
                  reasoning: info.reasoning?.efforts.map(item => item.id) ?? null, defaultMaxTokens: info.defaultMaxTokens ?? null }) }
              const allocated = await ledgerIO(() => ledger.allocateAttempt(runId))
              const reserved = await ledgerIO(() => hooks.beforeAttempt({ runId, taskId, retryScopeId, attemptId: allocated.attemptId, stage, operation,
                candidate: { candidateId: protocolDigest(actual), ...actual, parameters: { ...parameters } },
                estimatedInputTokens: attempt.estimatedInputTokens ?? 0, maxOutputTokens: policy.maxTokensPerCall || info.defaultMaxTokens || 4096, priceSnapshot: null }))
              if (reserved.status === 'paused') throw new ExecutionError('BUDGET_PAUSED', reserved.reason)
              try { args[3]?.throwIfAborted(); await ledgerIO(() => hooks.onDispatch(reserved.reservationId)) }
              catch (error) { await ledgerIO(() => hooks.releaseAttempt(reserved.reservationId, '旧路由未派发')); throw error }
              active.set(attempt, { attemptId: allocated.attemptId, reservationId: reserved.reservationId, actual,
                provider: attempt.route.provider, model: attempt.route.model, status: null, usage: null, errorCategory: null,
                localExitStatus: 'error', startedAt: Date.parse(attempt.startedAt), durationMs: 0 })
            },
            async settled(attempt) {
              const detail = active.get(attempt)
              if (!detail) return
              detail.status = attempt.finish === 'stop' ? 'success' : attempt.finish === 'aborted' ? 'cancelled' : 'transport-error'
              detail.localExitStatus = attempt.finish === 'stop' ? 'completed' : attempt.finish === 'aborted' ? 'cancelled' : 'error'
              detail.usage = attempt.usage ?? null; detail.durationMs = attempt.durationMs; detail.errorCategory = attempt.error ?? null
              detail.actual.reportedModel = attempt.reportedModel ?? null
              await ledgerIO(() => hooks.afterAttempt({ attemptId: detail.attemptId, reservationId: detail.reservationId, status: 'finished', finish: detail.status,
                provider: detail.provider, model: detail.model, reportedModel: detail.actual.reportedModel, requestId: attempt.requestId ?? null,
                usage: detail.usage ? normalizeUsage(detail.usage) : null, errorCategory: detail.errorCategory,
                localExitStatus: detail.localExitStatus === 'completed' ? 0 : null }))
              attempts.push(detail)
              if (detail.status === 'success') response = detail
            },
          } })
        if (!response) throw new Error('旧路由响应缺少实际派发记录。')
        return { text, responseAttemptId: response.attemptId, attempts, actual: response.actual }
      } catch (cause) {
        throw Object.assign(cause instanceof Error ? cause : new Error(String(cause)), { attempts })
      }
    },
  })
  const upgradeOptions: UpgradeOptions = { initialPolicy: policy, ...(upgrade ? { upgrade } : {}) }
  const options = { knowledgeRoot: knowledgeRoot ?? effectiveSourceRoots(client.legacyConfiguration().library)[0] ?? root, wikiPath: root, client, ...(topics === undefined ? {} : { topics }) }
  upgradeOptions.runStep = upgradeReviewRunner(bind, options)
  upgradeOptions.estimateReview = upgradeReviewEstimator(bind, options)
  return { recovery: bind(), bindRecovery: bind, upgradeOptions }
}
