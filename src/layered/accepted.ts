import { AsyncLocalStorage } from 'node:async_hooks'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { atomicWrite, hash, immutableWrite, withRevocationLock, writeJson } from './files.js'
import { safePath } from '../storage/paths.js'
import { readOptional } from '../storage/files.js'
import type { BuildLayeredOptions, PendingBuild } from './schema.js'
import type { ModelCallOptions } from '../llm/client.js'

import type { StageId as RecoveryStage } from '../domain/route-schema.js'
import type { SourceRef, TaskIdentity, AcceptedRef, ProductionRecord, AcceptedRecord, AcceptanceRequest, AcceptanceSnapshot, ExecutionHooks } from './schema.js'
import type { DetailedExecution, CallDetailedResult, DetailedAttempt } from '../llm/execution.js'
export type { RecoveryStage, SourceRef, TaskIdentity, AcceptedRef, ProductionRecord, AcceptedRecord, AcceptanceRequest, AcceptanceSnapshot }
export type AcceptanceHooks = Pick<ExecutionHooks, 'prepareAccepted' | 'readAcceptance' | 'onAccepted' | 'onValidation'>
export type ResponseAttempt = Pick<DetailedAttempt, 'provider' | 'model' | 'startedAt' | 'durationMs' | 'localExitStatus' | 'status' | 'usage' | 'errorCategory'>
export type DetailedResponse = Omit<CallDetailedResult, 'attempts'> & { attempts: readonly Readonly<ResponseAttempt>[] }
export interface RecoveryBindings {
  libraryId: string
  hooks: AcceptanceHooks
  validateAcceptedRecord(record: Omit<AcceptedRecord, 'acceptedDigest'>): void
  productionId(record: ProductionRecord): string
  /** 宿主解析 B2 阶段快照并绑定 B3/B4 钩子，缓存命中时不调用。 */
  resolveExecution(identity: TaskIdentity, runId: string, retryScopeId: string, route?: { stage: RecoveryStage; operation: string }): Promise<DetailedExecution>
  startRun?(runId: string): Promise<void>
  /** IF-49 六参数调用；具体执行类型由 B4 属主提供。 */
  callDetailed(task: Parameters<BuildLayeredOptions['client']['call']>[0], system: string, input: string,
    signal: AbortSignal | undefined, images: NonNullable<Parameters<BuildLayeredOptions['client']['call']>[4]>,
    options: ModelCallOptions & { execution: Awaited<ReturnType<RecoveryBindings['resolveExecution']>> }): Promise<DetailedResponse>
  /** 宿主把 B2 stageInputBudgets 绑定到本轮 StagePlan；B1 不复制窗口算法。 */
  stageInputBudgets(stage: RecoveryStage, request: { system: string; input: string; structuredSchema?: unknown }, maxInputBytes?: number): Promise<{ inputLimitBytes: number; estimatedInputTokens?: number; maxOutputTokens?: number }[]>
}
/** 旧路由复用原客户端执行；接受端只要求真实响应与尝试关联，不伪造新阶段策略。 */
export type LegacyRecoveryBindings = Pick<RecoveryBindings, 'libraryId' | 'hooks' | 'validateAcceptedRecord' | 'productionId' | 'startRun' | 'stageInputBudgets'> & {
  execute(identity: TaskIdentity, runId: string, retryScopeId: string, operation: string,
    args: Parameters<BuildLayeredOptions['client']['call']>): Promise<DetailedResponse>
}
export type AcceptanceBindings = RecoveryBindings | LegacyRecoveryBindings
export interface RecoveryBuildOptions extends BuildLayeredOptions {
  recovery?: AcceptanceBindings
  replayOnly?: boolean
  /** 自动恢复沿用已持久化的 runId；用户发起的建库/续跑默认签发新 runId。 */
  automaticRecovery?: boolean
  upgradeOptions?: import('./upgrade.js').UpgradeOptions
}
export interface RecoveryPending extends PendingBuild {
  acceptedProtocol?: 1; runId?: string
  reextractGenerations?: Record<string, number>
  acceptedRefs?: Record<string, AcceptedRef>
  stagePause?: { stage: RecoveryStage; code: string; message: string }
}
export interface AcceptedTaskSpec {
  unitId: string; sourceRefs: SourceRef[]; operation: string
  input: unknown; prompt: unknown; schema: unknown; validatorVersion: string; semanticVersion: string
  groupPlan?: unknown
  dependencies?: AcceptedRef[]
}
interface RecoveryContext {
  root: string; pending: RecoveryPending; bindings: AcceptanceBindings; replayOnly: boolean; persist: boolean
  failure?: unknown
}
interface TaskContext {
  identity: TaskIdentity; taskId: string; productions: Record<string, ProductionRecord>
  dependencies: AcceptedRecord['dependencies']; responses: { id: string; record: ProductionRecord; parents: string[]; inherited: string[]; unitId: string; aliases: string[] }[]
}
const contexts = new AsyncLocalStorage<RecoveryContext>()
const tasks = new AsyncLocalStorage<TaskContext>()
const calls = new AsyncLocalStorage<{ unitId: string; operation?: string; dependencyTaskIds?: string[] }>()
// 同一接受任务内的并行组各自保留因果关系，纠正只关联实际消费的原稿。
export const withAcceptedCall = <T>(context: NonNullable<ReturnType<typeof calls.getStore>>, work: () => Promise<T>) => calls.run(context, work)
export function aliasAcceptedResponse(original: string, transformed: string): void {
  const response = tasks.getStore()?.responses.findLast(response => response.record.outputDigest === hash(original))
  if (response) response.aliases.push(hash(transformed))
}
export const recoveryContext = () => contexts.getStore()
export const recoveryError = (code: string, message: string) => Object.assign(new Error(message), { code, storageFailure: true })
export const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + Array.from(value, canonicalJson).join(',') + ']'
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype)
    return '{' + Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}'
  throw new Error('任务规范 JSON 不接受 undefined、非有限数或非 JSON 对象。')
}
export const identityDigest = (value: unknown): string => hash(canonicalJson(value))
// 现行业务对象使用 JSON 可选字段；只在组装身份时转为明确的 JSON 数据。
export const businessValue = (value: unknown): unknown => JSON.parse(JSON.stringify(value))
export const taskIdFor = (identity: TaskIdentity): string => 't:' + identityDigest(identity).slice(7)
const taskPath = (taskId: string): string => {
  if (!/^t:[a-f0-9]{64}$/.test(taskId)) throw recoveryError('ACCEPTED_CORRUPT', '接受任务身份无效。')
  return 'work/accepted/tasks/' + taskId.slice(2) + '.json'
}
const sortedRefs = (refs: SourceRef[]) => [...new Map(refs.map(ref => [canonicalJson(ref), ref])).entries()]
  .sort(([a], [b]) => Buffer.compare(Buffer.from(a), Buffer.from(b))).map(([, ref]) => ref)
const refFor = (record: AcceptedRecord): AcceptedRef => ({ taskId: record.taskId, path: taskPath(record.taskId), digest: record.acceptedDigest })

export async function withRecovery<T>(root: string, pending: RecoveryPending, options: RecoveryBuildOptions, work: (options: BuildLayeredOptions) => Promise<T>, persist = true): Promise<T> {
  if (!options.recovery) {
    if (pending.acceptedProtocol || options.replayOnly) throw recoveryError('ACCEPTANCE_BINDING_REQUIRED', '接受协议恢复需要 B3 持久化与 B4 执行接点。')
    return work(options)
  }
  if (pending.runId) (pending.runIds ??= []).push(pending.runId)
  if (!options.automaticRecovery || !pending.runId) pending.runId = randomUUID()
  pending.runIds = [...new Set([...(pending.runIds ?? []), pending.runId])]
  await options.recovery.startRun?.(pending.runId)
  pending.acceptedProtocol = 1
  delete pending.stagePause
  if (persist) await writeJson(root, 'work/pending.json', pending)
  const context: RecoveryContext = { root, pending, bindings: options.recovery, replayOnly: options.replayOnly ?? false, persist }
  const original = options.client
  const client = new Proxy(original, { get(target, property) {
    if (property === 'call') return (...args: Parameters<typeof detailedCall>) => {
      if (context.replayOnly) throw recoveryError('ACCEPTED_MISSING', '离线回放缺少接受结果，禁止模型派发。')
      return tasks.getStore() ? detailedCall(...args) : original.call(...args)
    }
    if (property === 'info' || property === 'inputBudget') return (...args: unknown[]) => {
      if (context.replayOnly) throw recoveryError('ACCEPTED_MISSING', '离线回放缺少接受结果，禁止解析模型目录。')
      const method = Reflect.get(target, property, target) as ((...args: unknown[]) => unknown) | undefined
      return method?.apply(target, args)
    }
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  } })
  try { return await contexts.run(context, async () => {
    const value = await work({ ...options, client })
    if (context.failure) throw context.failure
    return value
  }) }
  catch (error) {
    if (error && typeof error === 'object' && ('stagePause' in error || 'budgetPause' in error && error.budgetPause === true)) {
      const value = error as { stage?: RecoveryStage; code?: string; message?: string }
      pending.stagePause = { stage: value.stage ?? tasks.getStore()?.identity.stage ?? 'extract', code: value.code ?? 'NO_COMPATIBLE_CANDIDATE', message: value.message ?? String(error) }
      if (persist) await writeJson(root, 'work/pending.json', pending)
    }
    throw error
  }
}

const detailedCall: BuildLayeredOptions['client']['call'] = async (task, system, input, signal, images, options) => {
  const context = contexts.getStore()!, scope = tasks.getStore()
  if (context.replayOnly) throw recoveryError('ACCEPTED_MISSING', '离线回放缺少接受结果，禁止模型派发。')
  if (!scope) throw recoveryError('ACCEPTANCE_TASK_REQUIRED', '模型调用缺少业务接受任务身份。')
  const { beforeAttempt: _before, onAttempt, ...callOptions } = options ?? {}
  const correction = options?.structuredSchemaKind === 'correction' || /"(?:validationFeedback|correction_stage)"\s*:/.test(input)
  const callContext = calls.getStore(), unitId = callContext?.unitId ?? scope.identity.scope.unitId
  const parents = correction ? scope.responses.filter(response => response.unitId === unitId).map(response => response.id) : []
  const inherited = Object.keys(scope.productions).filter(id => !callContext?.dependencyTaskIds
    || callContext.dependencyTaskIds.includes(scope.productions[id]!.taskId)).sort()
  const retryScopeId = correction ? scope.responses.find(response => response.unitId === unitId)?.record.taskId ?? scope.taskId : scope.taskId
  const stage = options?.operation ?? scope.identity.stage
  const operation = correction ? stage.endsWith('Review') ? 'correctSemantic' : 'correctStructure' : stage.endsWith('Review') ? 'review' : callContext?.operation ?? scope.identity.operation
  const reportAttempts = (attempts: readonly Readonly<ResponseAttempt>[]) => {
    for (const attempt of attempts) onAttempt?.({ route: { provider: attempt.provider, model: attempt.model },
      startedAt: new Date(attempt.startedAt).toISOString(), durationMs: attempt.durationMs,
      finish: attempt.localExitStatus === 'completed' ? 'stop' : attempt.status ?? 'unknown',
      ...(attempt.usage ? { usage: attempt.usage } : {}), ...(attempt.errorCategory ? { error: attempt.errorCategory } : {}) })
  }
  let result: DetailedResponse
  try {
    if ('execute' in context.bindings) result = await context.bindings.execute(scope.identity, context.pending.runId!, retryScopeId, operation,
      [task, system, input, signal, images ?? [], callOptions])
    else {
      const execution = await context.bindings.resolveExecution(scope.identity, context.pending.runId!, retryScopeId, { stage, operation })
      if (execution.taskId !== scope.taskId || execution.runId !== context.pending.runId || execution.retryScopeId !== retryScopeId)
        throw recoveryError('EXECUTION_IDENTITY_MISMATCH', '执行快照与业务任务身份不符。')
      result = await context.bindings.callDetailed(task, system, input, signal, images ?? [], { ...callOptions, execution })
    }
  } catch (error) {
    if (error && typeof error === 'object' && 'attempts' in error && Array.isArray(error.attempts)) reportAttempts(error.attempts)
    if (error && typeof error === 'object' && ('stagePause' in error || 'storageFailure' in error || 'budgetPause' in error && error.budgetPause === true)) context.failure = error
    throw error
  }
  const record: ProductionRecord = { ...result.actual, parameters: { ...result.actual.parameters }, taskId: scope.taskId, stage, operation,
    role: correction ? 'correct' : stage.endsWith('Review') ? 'review' : 'generate', outputDigest: hash(result.text), parentProductionIds: [] }
  scope.responses.push({ id: result.responseAttemptId, record, parents, inherited, unitId, aliases: [] })
  // 兼容 models 展示与旧统计；不调用旧预算钩子，实际预留只由 execution.hooks 完成。
  if (result.attempts.length) reportAttempts(result.attempts)
  else onAttempt?.({ route: { provider: result.actual.provider, model: result.actual.requestedModel }, startedAt: new Date().toISOString(), durationMs: 0, finish: 'stop' })
  return result.text
}

// 业务明确丢弃的响应留在尝试账本，不进入最终生产者表；部分沿用的响应仍保留。
export async function rejectAcceptedResponse(raw: string, status: 'rejected' | 'superseded' = 'rejected', reasonCode = 'BUSINESS_VALIDATION'): Promise<void> {
  const context = contexts.getStore(), scope = tasks.getStore()
  if (!context || !scope) return
  const digest = hash(raw)
  const removed = scope.responses.filter(response => (response.record.outputDigest === digest || response.aliases.includes(digest))
    && (!calls.getStore() || response.unitId === calls.getStore()!.unitId))
  scope.responses = scope.responses.filter(response => !removed.includes(response))
  for (const response of removed) await acceptanceIO(() => context.bindings.hooks.onValidation({ attemptId: response.id, taskId: response.record.taskId, status, reasonCode }))
}

async function acceptanceIO<T>(work: () => Promise<T>): Promise<T> {
  try { return await work() }
  catch (error) {
    const failure = error instanceof Error ? error : new Error(String(error))
    Object.assign(failure, { storageFailure: true })
    const context = contexts.getStore()
    if (context) context.failure = failure
    throw failure
  }
}

export async function recoveryBudget(stage: RecoveryStage, fallback: () => Promise<number>, maxInputBytes?: number): Promise<number> {
  const context = contexts.getStore()
  if (!context) return fallback()
  if (context.replayOnly) throw recoveryError('ACCEPTED_MISSING', '离线回放缺少完整业务检查点。')
  const budgets = await context.bindings.stageInputBudgets(stage, { system: '', input: '' }, maxInputBytes && Number.isFinite(maxInputBytes) ? maxInputBytes : undefined)
  const limit = budgets[0]?.inputLimitBytes
  if (!limit || !Number.isSafeInteger(limit) || limit <= 0) throw recoveryError('STAGE_BUDGET_INVALID', '阶段输入预算无效。')
  return limit
}

export async function makeTaskIdentity(stage: RecoveryStage, spec: AcceptedTaskSpec,
  context: { root: string; pending: Pick<RecoveryPending, 'reextractGenerations'>; bindings: Pick<AcceptanceBindings, 'libraryId'> } | undefined = contexts.getStore()): Promise<TaskIdentity> {
  if (!context) throw new Error('接受任务缺少恢复上下文。')
  const generation = (await readOptional<{ generation: number }>(await safePath(context.root, 'state/revocations.json')))?.generation ?? 0
  const dependencies = await Promise.all((spec.dependencies ?? []).map(async ref => {
    const record = await readRecord(context.root, ref.taskId)
    if (!record) throw recoveryError('ACCEPTED_MISSING', '上游接受结果缺失。')
    if (ref.path !== taskPath(ref.taskId) || ref.digest !== record.acceptedDigest) throw recoveryError('ACCEPTED_CORRUPT', '上游接受引用不符。')
    return { taskId: ref.taskId, outputDigest: record.output.digest }
  }))
  return { version: 1, scope: { libraryId: context.bindings.libraryId, unitId: spec.unitId, sourceRefs: sortedRefs(spec.sourceRefs) },
    stage, operation: spec.operation, inputDigest: identityDigest({ input: spec.input, dependencies }), promptDigest: identityDigest(spec.prompt), schemaDigest: identityDigest(spec.schema),
    validatorVersion: spec.validatorVersion, semanticVersion: spec.semanticVersion, groupPlanDigest: spec.groupPlan === undefined ? null : identityDigest(spec.groupPlan),
    revocationGeneration: generation, reextractGeneration: Math.max(0, ...spec.sourceRefs.map(ref => context.pending.reextractGenerations?.[ref.sourceId] ?? 0)) }
}

async function readRecord(root: string, taskId: string): Promise<AcceptedRecord | undefined> {
  const file = taskPath(taskId)
  const text = await readFile(await safePath(root, file), 'utf8').catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
  if (text === undefined) return
  try {
    const value = JSON.parse(text) as AcceptedRecord
    if (canonicalJson(value) + '\n' !== text) throw new Error('非规范编码')
    return value
  } catch { throw recoveryError('ACCEPTED_CORRUPT', '接受记录编码损坏：' + file) }
}
type AcceptedReader = Pick<AcceptanceBindings, 'libraryId' | 'validateAcceptedRecord'> & { hooks: Pick<AcceptanceHooks, 'readAcceptance'> }
async function checkRecord(record: AcceptedRecord, expected?: TaskIdentity, ancestors = new Set<string>(),
  context: { root: string; bindings: Pick<AcceptedReader, 'libraryId' | 'validateAcceptedRecord'> } = contexts.getStore()!): Promise<unknown> {
  const { acceptedDigest, ...body } = record
  try {
    context.bindings.validateAcceptedRecord(body)
    if (identityDigest(body) !== acceptedDigest || taskIdFor(record.identity) !== record.taskId
      || record.identity.scope.libraryId !== context.bindings.libraryId || expected && canonicalJson(expected) !== canonicalJson(record.identity)) throw new Error('身份或摘要不符')
  } catch { throw recoveryError('ACCEPTED_CORRUPT', '接受记录身份、验证规则或生产链不符：' + record.taskId) }
  const revocations = await readOptional<{ generation: number; sources: { source_id: string; generation: number }[] }>(await safePath(context.root, 'state/revocations.json'))
  if (record.identity.revocationGeneration !== (revocations?.generation ?? 0)
    || revocations?.sources.some(revoked => record.identity.scope.sourceRefs.some(ref => ref.sourceId === revoked.source_id) && revoked.generation > record.identity.revocationGeneration))
    throw recoveryError('ACCEPTED_REVOKED', '接受结果的撤权代次已失效：' + record.taskId)
  if (ancestors.has(record.taskId)) throw recoveryError('ACCEPTED_CORRUPT', '接受依赖存在循环。')
  const next = new Set(ancestors).add(record.taskId)
  for (const dep of record.dependencies) {
    const parent = await readRecord(context.root, dep.taskId)
    if (!parent) throw recoveryError('ACCEPTED_MISSING', '接受依赖缺失：' + dep.taskId)
    if (parent.acceptedDigest !== dep.acceptedDigest || canonicalJson(parent.identity.scope.sourceRefs) !== canonicalJson(dep.sourceRefs)) throw recoveryError('ACCEPTED_CORRUPT', '接受依赖摘要或来源版本不符。')
    await checkRecord(parent, undefined, next, context)
  }
  const bytes = await readFile(await safePath(context.root, record.output.path)).catch(error => {
    if (error.code === 'ENOENT') throw recoveryError('ACCEPTED_MISSING', '接受输出缺失：' + record.output.path)
    throw error
  })
  if (bytes.length !== record.output.bytes || hash(bytes) !== record.output.digest) throw recoveryError('ACCEPTED_CORRUPT', '接受输出原字节摘要不符：' + record.output.path)
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return record.output.encoding === 'utf8-text' ? text : JSON.parse(text)
  } catch { throw recoveryError('ACCEPTED_CORRUPT', '接受输出编码无效。') }
}
function attach(record: AcceptedRecord): void {
  const scope = tasks.getStore()
  if (scope && scope.taskId !== record.taskId) {
    Object.assign(scope.productions, record.productions)
    if (!scope.dependencies.some(dep => dep.taskId === record.taskId)) scope.dependencies.push({ taskId: record.taskId, acceptedDigest: record.acceptedDigest, sourceRefs: record.identity.scope.sourceRefs })
  }
}
/** 只读校验已提交或已准备的接受结果；不提交任务文件、不绑定准备快照。 */
export async function readAccepted<T>(root: string, bindings: AcceptedReader, identity: TaskIdentity, valid: (value: T) => boolean) {
  const context = { root, bindings }, taskId = taskIdFor(identity)
  // 接受记录必须先校验，不能用准备快照掩盖损坏的提交。
  let record = await readRecord(context.root, taskId), value: unknown
  if (record) value = await checkRecord(record, identity, undefined, context)
  const snapshot = await acceptanceIO(() => bindings.hooks.readAcceptance(taskId))
  if (record && snapshot.status === 'missing') throw recoveryError('ACCEPT_PREPARE_MISSING', '已提交接受记录缺少准备快照。')
  if (snapshot.status === 'missing') return undefined
  const prepared = { ...snapshot.record, acceptedDigest: identityDigest(snapshot.record) }
  if (snapshot.taskId !== taskId || snapshot.prepareId !== identityDigest({ taskId, outputDigest: prepared.output.digest })
    || snapshot.acceptedDigest !== null && snapshot.acceptedDigest !== prepared.acceptedDigest
    || record && canonicalJson(record) !== canonicalJson(prepared)) throw recoveryError('ACCEPT_CONFLICT', '接受记录与准备快照不一致。')
  if (!record) { record = prepared; value = await checkRecord(record, identity, undefined, context) }
  if (!valid(value as T)) throw recoveryError('ACCEPTED_CORRUPT', '接受输出未通过当前业务校验。')
  return { value: value as T, record, snapshot }
}
export async function recoverAccepted<T>(identity: TaskIdentity, valid: (value: T) => boolean): Promise<{ value: T; reused: true; acceptedRef: AcceptedRef } | undefined> {
  const context = contexts.getStore()!, taskId = taskIdFor(identity)
  const saved = await readAccepted(context.root, context.bindings, identity, valid)
  if (!saved) return
  const { record, snapshot, value } = saved
  await withRevocationLock(context.root, async () => {
    await checkRecord(record!, identity)
    const existing = await readRecord(context.root, taskId)
    if (existing && canonicalJson(existing) !== canonicalJson(record)) throw recoveryError('ACCEPT_CONFLICT', '同一任务已有不同的接受结果。')
    if (!existing) await atomicWrite(context.root, taskPath(taskId), canonicalJson(record) + '\n')
    await acceptanceIO(() => context.bindings.hooks.onAccepted({ taskId, prepareId: snapshot.prepareId, acceptedDigest: record!.acceptedDigest }))
  })
  attach(record)
  return { value: value as T, reused: true, acceptedRef: refFor(record) }
}

export async function executeAccepted<T>(identity: TaskIdentity, work: () => Promise<T>, valid: (value: T) => boolean, dependencies: AcceptedRef[] = []): Promise<{ value: T; reused: boolean; acceptedRef?: AcceptedRef }> {
  const context = contexts.getStore()!, taskId = taskIdFor(identity)
  const parent = tasks.getStore()
  if (context.replayOnly) throw recoveryError('ACCEPTED_MISSING', '离线回放缺少接受任务：' + taskId)
  const scope: TaskContext = { identity, taskId, productions: {}, dependencies: [], responses: [] }
  for (const ref of dependencies) {
    const record = await readRecord(context.root, ref.taskId)
    if (!record) throw recoveryError('ACCEPTED_MISSING', '上游接受结果缺失。')
    if (ref.path !== taskPath(ref.taskId) || record.acceptedDigest !== ref.digest) throw recoveryError('ACCEPTED_CORRUPT', '上游接受引用不符。')
    await checkRecord(record)
    Object.assign(scope.productions, record.productions)
    scope.dependencies.push({ taskId: record.taskId, acceptedDigest: record.acceptedDigest, sourceRefs: record.identity.scope.sourceRefs })
  }
  let value: T
  try { value = await tasks.run(scope, work) }
  catch (error) {
    for (const response of scope.responses) await acceptanceIO(() => context.bindings.hooks.onValidation({ attemptId: response.id, taskId: response.record.taskId, status: 'rejected', reasonCode: 'BUSINESS_EXECUTION_FAILED' }))
    throw error
  }
  if (context.failure) throw context.failure
  if (!valid(value)) {
    if (parent) {
      parent.responses.push(...scope.responses)
      Object.assign(parent.productions, scope.productions)
      for (const dep of scope.dependencies) if (!parent.dependencies.some(item => item.taskId === dep.taskId)) parent.dependencies.push(dep)
    } else for (const response of scope.responses) await acceptanceIO(() => context.bindings.hooks.onValidation({ attemptId: response.id, taskId: response.record.taskId, status: 'rejected', reasonCode: 'BUSINESS_VALIDATION' }))
    return { value, reused: false }
  }
  const produced = new Map<string, string>()
  // 并行分块互为兄弟，不把响应完成顺序写成因果链。
  for (const response of scope.responses) {
    response.record.parentProductionIds = [...new Set([...response.inherited, ...response.parents.flatMap(id => produced.get(id) ?? [])])].sort()
    const productionId = context.bindings.productionId(response.record)
    scope.productions[productionId] = response.record
    produced.set(response.id, productionId)
  }
  // 纯本地派生与旧成果沿用原业务检查点，不能伪造模型生产者。
  if (!Object.keys(scope.productions).length) return { value, reused: false }
  const output = Buffer.from(JSON.stringify(value, null, 2) + '\n'), digest = hash(output)
  const file = 'work/accepted/objects/' + digest.slice(7) + '.bin'
  await immutableWrite(context.root, file, output)
  const record: Omit<AcceptedRecord, 'acceptedDigest'> = { schema: 'llmwiki-accepted-v1', taskId, identity,
    output: { path: file, digest, bytes: output.length, encoding: 'utf8-json' },
    validation: { validatorVersion: identity.validatorVersion, schemaDigest: identity.schemaDigest, status: 'accepted' }, productions: scope.productions,
    dependencies: scope.dependencies.sort((a, b) => a.taskId.localeCompare(b.taskId)) }
  const prepared = await acceptanceIO(() => context.bindings.hooks.prepareAccepted({ taskId, record,
    responseAttemptId: scope.responses.at(-1)?.id ?? null, acceptedAttemptIds: scope.responses.map(response => response.id).sort() }))
  const accepted: AcceptedRecord = { ...record, acceptedDigest: identityDigest(record) }
  await withRevocationLock(context.root, async () => {
    await checkRecord(accepted, identity)
    const existing = await readRecord(context.root, taskId)
    if (existing && canonicalJson(existing) !== canonicalJson(accepted)) throw recoveryError('ACCEPT_CONFLICT', '同一任务输出冲突，保留原接受记录。')
    if (!existing) await atomicWrite(context.root, taskPath(taskId), canonicalJson(accepted) + '\n')
    await acceptanceIO(() => context.bindings.hooks.onAccepted({ taskId, prepareId: prepared.prepareId, acceptedDigest: accepted.acceptedDigest }))
  })
  attach(accepted)
  return { value, reused: false, acceptedRef: refFor(accepted) }
}

// 版本成果由内嵌生产表继承；只有本次 pending 登记的接受引用依赖 work。
export function activeAcceptedRefs(refs: AcceptedRef[]): AcceptedRef[] {
  const context = contexts.getStore()
  if (!context) return []
  const active = new Set(Object.values(context.pending.acceptedRefs ?? {}).map(ref => ref.taskId))
  return refs.filter(ref => active.has(ref.taskId))
}

export async function verifyAcceptedRefs(value: unknown, activeOnly = false): Promise<void> {
  const context = contexts.getStore()
  if (!context || !value || typeof value !== 'object') return
  const checked = new Set<string>()
  const visit = async (node: unknown): Promise<void> => {
    if (!node || typeof node !== 'object') return
    for (const [key, child] of Object.entries(node)) {
      if (key === 'acceptedRef' && child) {
        const ref = child as AcceptedRef
        if (activeOnly && !activeAcceptedRefs([ref]).length) continue
        if (ref.path !== taskPath(ref.taskId)) throw recoveryError('ACCEPTED_CORRUPT', '业务检查点接受路径不符。')
        const record = await readRecord(context.root, ref.taskId)
        if (!record) throw recoveryError('ACCEPTED_MISSING', '业务检查点引用的接受记录缺失。')
        if (record.acceptedDigest !== ref.digest) throw recoveryError('ACCEPTED_CORRUPT', '业务检查点接受摘要不符。')
        if (!checked.has(ref.taskId)) { await recoverAccepted(record.identity, () => true); checked.add(ref.taskId) }
      } else await visit(child)
    }
  }
  await visit(value)
}
