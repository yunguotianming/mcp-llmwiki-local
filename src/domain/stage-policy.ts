import { createHash } from 'node:crypto'
import { z } from 'zod'
import { resolveLayeredRoute } from './config.js'
import type { LibraryRegistration, ModelRef } from './config.js'
import type { LibraryPolicy } from './policy.js'
import { buildModelsSchema, buildStages, modelExecutionSchema } from './route-schema.js'
import type { BuildModels, ModelExecution, StageId } from './route-schema.js'

/** 新执行身份使用 UTF-8 键序；旧成果和旧指纹继续使用原算法。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + Array.from(value, item => canonicalJson(item)).join(',') + ']'
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))
      .map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}'
  }
  throw new Error('规范 JSON 不接受 undefined、非有限数或非 JSON 对象。')
}
export const executionDigest = (value: unknown): string => 'sha256:' + createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex')

export class StagePolicyError extends Error {
  readonly stagePause = true
  constructor(readonly code: string, readonly stage: StageId, readonly candidateIndex: number, readonly candidate: string, message: string) {
    super(`${code}：阶段 ${stage}，候选 ${candidateIndex + 1}（${candidate}）：${message}`)
  }
}
const positive = z.number().int().positive(), nonempty = z.string().min(1)
export const capabilitiesSchema = z.strictObject({
  contextWindowTokens: positive, maxOutputTokens: positive, inputModalities: z.array(nonempty).min(1), reasoningEfforts: z.array(nonempty),
  structuredOutput: z.enum(['native', 'prompt-validated']), streaming: z.boolean(), source: nonempty, validationRevision: nonempty,
  temperature: z.strictObject({ min: z.number().nonnegative(), max: z.number().nonnegative() }).optional(),
}).refine(value => !value.temperature || value.temperature.min <= value.temperature.max, '温度能力范围无效。')
export type ModelCapabilities = z.infer<typeof capabilitiesSchema>
export interface ResolvedParameters { reasoningEffort: string; temperature: number | 'runtime-default'; maxOutputTokens: number | 'runtime-default' }
export interface QualityEvidence { stage: StageId; model: string; parameters: ResolvedParameters; reference: string }
export interface CandidateModel {
  resolvedModel: string
  endpointRevision: string
  /** 非敏感修订标识；不得传入密钥或密钥摘要。 */
  credentialRevision: string
  capabilities: ModelCapabilities
  defaultsRevision: string
  defaults: { [K in keyof ResolvedParameters]?: ResolvedParameters[K] | undefined }
  priceSnapshot: { currency: string; unit: number; input: number; cacheRead: number; cacheWrite: number; output: number; priceRevision: string } | null
  qualityEvidence: QualityEvidence[]
}
const resolvedParametersSchema = z.strictObject({ reasoningEffort: nonempty, temperature: z.union([z.number().nonnegative(), z.literal('runtime-default')]),
  maxOutputTokens: z.union([positive, z.literal('runtime-default')]) })
const candidateModelSchema = z.strictObject({ resolvedModel: nonempty, endpointRevision: nonempty, credentialRevision: nonempty,
  capabilities: capabilitiesSchema, defaultsRevision: nonempty, defaults: resolvedParametersSchema.partial(),
  priceSnapshot: z.strictObject({ currency: nonempty, unit: positive, input: z.number().nonnegative(), cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(), output: z.number().nonnegative(), priceRevision: nonempty }).nullable(),
  qualityEvidence: z.array(z.strictObject({ stage: z.enum(buildStages), model: nonempty, parameters: resolvedParametersSchema, reference: nonempty })),
})
export interface CandidateDescriptor {
  candidateId: string; lineId: string; provider: string; requestedModel: string
  bindingRevision: string; capabilityRevision: string; parameters: ResolvedParameters; capabilities: ModelCapabilities
  limits: { quotaGroupId: string; maxConcurrency: number; initialConcurrency: number; minConcurrency: number; rpm?: number; tpm?: number }
  priceSnapshot: CandidateModel['priceSnapshot']; qualityEvidence: QualityEvidence[]
}
export interface StagePlan { stage: StageId; selection: 'priority-spillover' | 'failover'; candidates: CandidateDescriptor[]; executionRevision: string }
export type ResolveCandidateModel = (provider: string, model: string, lineId: string, signal?: AbortSignal) => Promise<CandidateModel>

/** 新策略存在时不读取旧备用池；旧策略的两类核对继承 extract。 */
export function buildStageSelection(library: LibraryRegistration, policy: LibraryPolicy, stage: StageId):
  { source: 'policy.buildModels'; stage: StageId; selection: BuildModels['stages'][StageId]; retry: BuildModels['retry'] }
  | { source: 'models'; stage: StageId; routes: ModelRef[]; reasoningEffort?: string } {
  if (policy.buildModels !== undefined) {
    const models = buildModelsSchema.parse(policy.buildModels)
    return { source: 'policy.buildModels', stage, selection: models.stages[stage], retry: models.retry }
  }
  const route = resolveLayeredRoute(library.models, stage), primary = route?.route?.provider && route.route.model ? route.route : library.models.unified
  const routes = [primary, ...library.models.fallbacks].filter((item, index, all) => item.provider && item.model
    && all.findIndex(other => other.provider === item.provider && other.model === item.model) === index).map(item => ({ ...item }))
  return { source: 'models', stage, routes, ...(route?.reasoningEffort ? { reasoningEffort: route.reasoningEffort } : {}) }
}

export async function resolveStagePlan(policy: BuildModels, stage: StageId, execution: ModelExecution, libraryMaxConcurrency: number,
  resolve: ResolveCandidateModel, options: { signal?: AbortSignal; evaluationOnly?: boolean } = {}): Promise<StagePlan> {
  const models = buildModelsSchema.parse(policy), host = modelExecutionSchema.parse(execution), selected = models.stages[stage]
  positive.parse(libraryMaxConcurrency)
  const candidates: CandidateDescriptor[] = []
  for (const [index, choice] of selected.candidates.entries()) {
    options.signal?.throwIfAborted()
    const identity = choice.line + '/' + choice.model
    const fail = (code: string, message: string): never => { throw new StagePolicyError(code, stage, index, identity, message) }
    const binding = host.lineBindings[choice.line]
    if (!binding) fail('LINE_UNBOUND', '线路尚未绑定。')
    const group = host.quotaGroups[binding!.quotaGroupId]
    if (!group) fail('QUOTA_GROUP_UNKNOWN', '线路引用的共享额度组不存在。')
    let model: CandidateModel
    try { model = await resolve(binding!.provider, choice.model, choice.line, options.signal) }
    catch (error) { options.signal?.throwIfAborted(); return fail('CAPABILITY_UNKNOWN', error instanceof Error ? error.message : '模型能力不可读。') }
    options.signal?.throwIfAborted()
    const parsed = candidateModelSchema.safeParse(model)
    if (!parsed.success) fail('CAPABILITY_UNKNOWN', '模型能力、默认参数或非敏感修订不完整。')
    model = parsed.success ? parsed.data : model
    try { canonicalJson(model) } catch { fail('CAPABILITY_UNKNOWN', '能力快照不能包含 undefined 或非 JSON 值。') }
    const capabilities = model.capabilities
    const parameters: ResolvedParameters = {
      reasoningEffort: choice.parameters?.reasoningEffort ?? model.defaults.reasoningEffort ?? 'runtime-default',
      temperature: choice.parameters?.temperature ?? model.defaults.temperature ?? 'runtime-default',
      maxOutputTokens: choice.parameters?.maxOutputTokens ?? model.defaults.maxOutputTokens ?? 'runtime-default',
    }
    if (parameters.reasoningEffort !== 'runtime-default' && !capabilities.reasoningEfforts.includes(parameters.reasoningEffort))
      fail('PARAMETER_UNSUPPORTED', '模型未声明所选推理强度。')
    if (parameters.temperature !== 'runtime-default' && (!Number.isFinite(parameters.temperature) || !capabilities.temperature
      || parameters.temperature < capabilities.temperature.min || parameters.temperature > capabilities.temperature.max))
      fail('PARAMETER_UNSUPPORTED', '模型未声明可用的温度范围。')
    if (parameters.maxOutputTokens !== 'runtime-default' && (!Number.isSafeInteger(parameters.maxOutputTokens) || parameters.maxOutputTokens <= 0
      || parameters.maxOutputTokens > capabilities.maxOutputTokens)) fail('OUTPUT_LIMIT', '输出预留超过候选能力。')
    const qualityEvidence = model.qualityEvidence.filter(evidence => evidence.stage === stage && evidence.model === choice.model
      && evidence.reference.trim() && canonicalJson(evidence.parameters) === canonicalJson(parameters))
    // D-61：未验收不再阻止正式建库；保留精确匹配的证据，实际选择由生产记录保存。
    // evaluationOnly 继续表示隔离评测调用，不再承担放开质量准入的职责。
    candidates.push({
      candidateId: executionDigest({ lineId: choice.line, requestedModel: choice.model, parameters }), lineId: choice.line,
      provider: binding!.provider, requestedModel: choice.model, parameters, capabilities,
      bindingRevision: executionDigest({ provider: binding!.provider, resolvedModel: model.resolvedModel, endpointRevision: model.endpointRevision, credentialRevision: model.credentialRevision }),
      capabilityRevision: executionDigest({ capabilities, defaults: model.defaults, defaultsRevision: model.defaultsRevision }),
      limits: { quotaGroupId: binding!.quotaGroupId, maxConcurrency: binding!.maxConcurrency,
        initialConcurrency: binding!.initialConcurrency ?? binding!.maxConcurrency, minConcurrency: binding!.minConcurrency ?? 1,
        ...(group!.rpm === undefined ? {} : { rpm: group!.rpm }), ...(group!.tpm === undefined ? {} : { tpm: group!.tpm }) },
      priceSnapshot: model.priceSnapshot, qualityEvidence,
    })
  }
  return structuredClone({ stage, selection: selected.selection, candidates, executionRevision: executionDigest({
    stage, selection: selected.selection, candidates, retry: models.retry, host, libraryMaxConcurrency,
  }) })
}
