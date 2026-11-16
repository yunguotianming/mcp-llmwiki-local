import { effectiveSourceRoots, layeredSettings, resolveLayeredRoute } from '../domain/config.js'
import type { LibraryRegistration, Registry } from '../domain/config.js'
import type { LibraryPolicy } from '../domain/policy.js'
import { buildStageSelection, resolveStagePlan, StagePolicyError } from '../domain/stage-policy.js'
import type { ResolveCandidateModel, StagePlan } from '../domain/stage-policy.js'
import type { StageId } from '../domain/route-schema.js'
import { ModelClient } from '../llm/client.js'
import type { ModelRuntime } from '../llm/client.js'
import { createLocalRuntime } from '../local/runtime.js'
import { candidateInputBudget, stageInputBudgets } from '../layered/input-budget.js'
import { createExecutionLedger, normalizeUsage, recoverExecutionRun } from '../layered/costs.js'
import { productionId, validateAcceptedRecord } from '../layered/models.js'
import { taskIdFor } from '../layered/accepted.js'
import type { RecoveryBindings } from '../layered/accepted.js'
import type { ExecutionHooks } from '../layered/schema.js'
import type { HostExecution, DetailedExecution } from '../llm/execution.js'
import { upgradeReviewEstimator, upgradeReviewRunner } from '../layered/upgrade.js'
import type { UpgradeOptions } from '../layered/upgrade.js'
import { legacyBuildBindings } from '../layered/legacy-execution.js'
import type { AcceptanceBindings } from '../layered/accepted.js'
import { compatibleRuntime, hostCandidate } from './compatible-models.js'
import type { CompatibleRuntimeOptions } from './compatible-models.js'
import { bindEmbeddingCredential } from '../llm/credentials.js'

/** 宿主在启动或显式续跑时固定快照；模型目录只在未完成阶段请求解析时访问。 */
export function createBuildStageResolver(registry: Registry, library: LibraryRegistration, policy: LibraryPolicy, resolve: ResolveCandidateModel) {
  const snapshot = structuredClone({ execution: registry.modelExecution, library, policy })
  return async (stage: StageId, signal?: AbortSignal) => {
    signal?.throwIfAborted()
    const selection = buildStageSelection(snapshot.library, snapshot.policy, stage)
    if (selection.source === 'models') return selection
    if (!snapshot.execution) throw new StagePolicyError('LINE_UNBOUND', stage, 0, selection.selection.candidates[0]!.line, '宿主尚未配置线路绑定。')
    return { source: selection.source, plan: await resolveStagePlan(snapshot.policy.buildModels!, stage, snapshot.execution,
      snapshot.policy.pageGenerationConcurrency, resolve, signal ? { signal } : {}) }
  }
}

/** 旧 ModelClient 的参数读取也能继承 extract；副本只供本次装配，不回写登记。 */
export function legacyReviewRoutes(library: LibraryRegistration): LibraryRegistration {
  const copy = structuredClone(library)
  for (const stage of ['extractionReview', 'topicReview'] as const) {
    const inherited = resolveLayeredRoute(copy.models, stage)
    if (inherited) copy.models.layeredRoutes[stage] = structuredClone(inherited)
  }
  return copy
}

export type BuildModelClient = ModelClient & { recovery?: AcceptanceBindings; bindRecovery?: (hooks: ExecutionHooks) => AcceptanceBindings; upgradeOptions?: UpgradeOptions }

/** 固定执行配置；接受恢复完成前不查询模型目录。 */
export function createBuildModelClient(runtime: ModelRuntime, library: LibraryRegistration, policy: LibraryPolicy, registry?: Registry): BuildModelClient {
  const client: BuildModelClient = new ModelClient(runtime, legacyReviewRoutes(library), policy)
  if (!policy.buildModels) return Object.assign(client, legacyBuildBindings(client, library.wikiPath, library.id, library.layered, registry?.upgrade))
  const snapshot = structuredClone({ library, policy, execution: registry?.modelExecution, upgrade: registry?.upgrade })
  const plans = new Map<StageId, Promise<StagePlan>>()
  const plan = (stage: StageId, signal?: AbortSignal) => {
    let saved = plans.get(stage)
    if (!saved) {
      if (!snapshot.execution) throw new StagePolicyError('LINE_UNBOUND', stage, 0, snapshot.policy.buildModels!.stages[stage].candidates[0]!.line, '宿主尚未配置线路绑定。')
      saved = resolveStagePlan(snapshot.policy.buildModels!, stage, snapshot.execution, snapshot.policy.pageGenerationConcurrency,
        runtime.resolveBuildModel ?? ((provider, model, _line, signal) => hostCandidate(runtime, provider, model, signal)), signal ? { signal } : {})
      plans.set(stage, saved)
    }
    return saved
  }
  const settings = layeredSettings(snapshot.library.layered)
  const ledger = createExecutionLedger(library.wikiPath, { ...(settings.maxBuildCalls === undefined ? {} : { maxCalls: settings.maxBuildCalls }),
    ...(settings.maxBuildTokens === undefined ? {} : { maxTokens: settings.maxBuildTokens }) })
  const started = new Map<string, Promise<unknown>>()
  const bind = (hooks: ExecutionHooks = ledger): RecoveryBindings => ({
    libraryId: library.id, hooks, productionId, validateAcceptedRecord,
    async startRun(runId) { if (!started.has(runId)) started.set(runId, recoverExecutionRun(library.wikiPath, runId)); await started.get(runId) },
    async resolveExecution(identity, runId, retryScopeId, route) {
      const stage = route?.stage ?? identity.stage, stagePlan = await plan(stage)
      const host = snapshot.execution!
      const modelExecution: HostExecution = { globalMaxInFlight: host.globalMaxInFlight, quotaGroups: Object.fromEntries(Object.entries(host.quotaGroups).map(([id, group]) => [id, { maxConcurrency: group.maxConcurrency, ...(group.rpm === undefined ? {} : { rpm: group.rpm }), ...(group.tpm === undefined ? {} : { tpm: group.tpm }) }])),
        lineBindings: Object.fromEntries(Object.entries(host.lineBindings).map(([id, binding]) => [id, { provider: binding.provider, quotaGroupId: binding.quotaGroupId, maxConcurrency: binding.maxConcurrency,
          initialConcurrency: binding.initialConcurrency ?? binding.maxConcurrency, minConcurrency: binding.minConcurrency ?? 1,
          ...(binding.adaptive?.enabled ? { adaptive: binding.adaptive as NonNullable<HostExecution['lineBindings'][string]['adaptive']> } : {}) }])) }
      const execution: DetailedExecution = { taskId: taskIdFor(identity), runId, retryScopeId, stagePlan,
        retry: snapshot.policy.buildModels!.retry, checkpoint: ledger, modelExecution, operation: route?.operation ?? identity.operation,
        hooks: { beforeAttempt: request => hooks !== ledger && snapshot.upgrade?.maxTokens !== undefined && request.candidate.parameters.maxOutputTokens === 'runtime-default'
          ? Promise.resolve({ status: 'paused', reason: '升级 Token 上限需要明确的输出硬限制。' }) : hooks.beforeAttempt({ ...request, candidate: { ...request.candidate, parameters: { ...request.candidate.parameters } } }), onDispatch: id => hooks.onDispatch(id),
          releaseAttempt: (id, reason) => hooks.releaseAttempt(id, reason),
          afterAttempt: outcome => hooks.afterAttempt({ attemptId: outcome.attemptId, reservationId: outcome.reservationId,
            status: outcome.state, finish: outcome.status, provider: outcome.provider, model: outcome.model,
            reportedModel: outcome.reportedModel, usage: outcome.usage ? normalizeUsage(outcome.usage) : null,
            requestId: outcome.requestId, errorCategory: outcome.errorCategory, localExitStatus: outcome.localExitStatus === 'completed' ? 0 : null }) },
        budget: (candidate, request) => candidateInputBudget(stage, candidate, { ...request, imageCount: request.images.length }, stagePlan.candidates.indexOf(candidate)),
      }
      return execution
    },
    callDetailed: (...args) => client.callDetailed(...args),
    stageInputBudgets: async (stage, request, maxInputBytes) => stageInputBudgets(await plan(stage), request, maxInputBytes),
  })
  client.recovery = bind()
  client.bindRecovery = bind
  client.inputBudget = async (_task, signal, stage = 'extract') => stageInputBudgets(await plan(stage, signal), { system: '', input: '' })[0]!.inputLimitBytes
  client.info = async (_task, signal, required, stage = 'extract') => {
    const selected = (await plan(stage, signal)).candidates.find(candidate => !required || candidate.capabilities.inputModalities.includes(required))
    if (!selected) throw new StagePolicyError('NO_COMPATIBLE_CANDIDATE', stage, 0, required ?? 'text', '没有兼容输入类型的候选。')
    return { provider: selected.provider, id: selected.requestedModel, name: selected.requestedModel,
      context: { contextWindow: selected.capabilities.contextWindowTokens }, defaultMaxTokens: typeof selected.parameters.maxOutputTokens === 'number' ? selected.parameters.maxOutputTokens : selected.capabilities.maxOutputTokens }
  }
  client.call = async () => { throw new Error('ACCEPTANCE_TASK_REQUIRED：新策略调用必须经过业务接受任务。') }
  client.upgradeOptions = { initialPolicy: snapshot.policy, ...(snapshot.upgrade ? { upgrade: { ...(snapshot.upgrade.maxCalls === undefined ? {} : { maxCalls: snapshot.upgrade.maxCalls }), ...(snapshot.upgrade.maxTokens === undefined ? {} : { maxTokens: snapshot.upgrade.maxTokens }) } } : {}) }
  const upgradeBuildOptions = { knowledgeRoot: effectiveSourceRoots(library)[0] ?? library.wikiPath, wikiPath: library.wikiPath, client, topics: snapshot.library.layered ?? {} }
  client.upgradeOptions.runStep = upgradeReviewRunner(bind, upgradeBuildOptions)
  client.upgradeOptions.estimateReview = upgradeReviewEstimator(bind, upgradeBuildOptions)
  return client
}

// 独立宿主沿用本库运行配置；兼容接口共用上游协议，类型导入不加载 dsh。
export function modelRuntime(base: ModelRuntime | undefined, registry?: Registry, options: CompatibleRuntimeOptions = {}) {
  const local = base ?? createLocalRuntime({ codexExecutable: 'codex', codexContextWindowTokens: 256000, deepseekBaseUrl: 'https://api.deepseek.com/v1' })
  if (registry?.embeddingService) bindEmbeddingCredential(registry.embeddingService, options.env)
  const compatible = compatibleRuntime(registry?.compatibleProviders ?? {}, options)
  const select = (provider: string) => provider.startsWith('compatible:') ? compatible : local
  return {
    listProviders: () => [{ id: 'codex-cli', name: 'Codex CLI' }, { id: 'deepseek-official', name: 'DeepSeek' }, ...compatible.listProviders()],
    listModels: (provider: string) => provider.startsWith('compatible:') ? compatible.listModels(provider) : Promise.resolve([]),
    resolveModelInfo: (provider, model, signal) => select(provider).resolveModelInfo(provider, model, signal),
    resolveBuildModel: (provider, model, line, signal) => {
      const runtime = select(provider)
      return runtime.resolveBuildModel ? runtime.resolveBuildModel(provider, model, line, signal) : hostCandidate(runtime, provider, model, signal)
    },
    stream: input => select(input.provider).stream(input),
    supportsStructuredOutput: (provider, model) => select(provider).supportsStructuredOutput?.(provider, model) ?? false,
    supportsCacheMode: (provider, model) => select(provider).supportsCacheMode?.(provider, model) ?? false,
    responseMetadata: event => compatible.responseMetadata?.(event) ?? local.responseMetadata?.(event),
  } satisfies ModelRuntime & Pick<typeof compatible, 'listProviders' | 'listModels'>
}
