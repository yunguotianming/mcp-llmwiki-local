import { topicInputBudget } from '../llm/context.js'
import type { BuildLayeredOptions, Point } from './schema.js'
import { jsonProtocol } from '../llm/protocol.js'
import { StagePolicyError } from '../domain/stage-policy.js'
import type { CandidateDescriptor, StagePlan } from '../domain/stage-policy.js'
import type { StageId } from '../domain/route-schema.js'

export interface StageInput {
  system: string; input: string; structuredSchema?: unknown
  /** 图片费用由具备能力资料的宿主估算；不能把图片字节当作 token。 */
  imageCount?: number; imageTokens?: number
}
export interface StageBudget { candidateId: string; inputLimitBytes: number; estimatedInputTokens: number; maxOutputTokens: number; capabilityRevision: string }
export const stageInputEstimationMethod = 'utf8-byte-upper-bound-v1+declared-image-tokens'
export function candidateInputBudget(stage: StageId, candidate: CandidateDescriptor, request: StageInput,
  index = 0, maxInputBytes?: number): StageBudget {
  const fail = (code: string, message: string): never => { throw new StagePolicyError(code, stage, index,
    `${candidate.lineId}/${candidate.requestedModel} ${candidate.candidateId}`, message) }
  const { capabilities, parameters } = candidate
  if (!Number.isSafeInteger(capabilities.contextWindowTokens) || capabilities.contextWindowTokens <= 0
    || !Number.isSafeInteger(capabilities.maxOutputTokens) || capabilities.maxOutputTokens <= 0) fail('CAPABILITY_UNKNOWN', '上下文或输出能力无效。')
  if (!capabilities.inputModalities.includes('text')) fail('MODALITY_UNSUPPORTED', '候选不接受文本。')
  const imageCount = request.imageCount ?? 0, imageTokens = request.imageTokens ?? 0
  if (!Number.isSafeInteger(imageCount) || imageCount < 0 || !Number.isSafeInteger(imageTokens) || imageTokens < 0)
    fail('CAPABILITY_UNKNOWN', '图片数量和 token 费用必须为非负整数。')
  if (imageCount && !capabilities.inputModalities.includes('image')) fail('MODALITY_UNSUPPORTED', '候选不接受图片。')
  if (imageCount && !imageTokens) fail('CAPABILITY_UNKNOWN', '图片输入缺少可用的 token 成本估算。')
  const maxOutputTokens = parameters.maxOutputTokens === 'runtime-default' ? capabilities.maxOutputTokens : parameters.maxOutputTokens
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0 || maxOutputTokens > capabilities.maxOutputTokens)
    fail('OUTPUT_LIMIT', '输出预留超过候选能力。')
  const context = capabilities.contextWindowTokens
  const available = ['topic', 'parent', 'topicReview'].includes(stage) ? topicInputBudget(context, maxOutputTokens) : context - maxOutputTokens
  if (maxInputBytes !== undefined && (!Number.isSafeInteger(maxInputBytes) || maxInputBytes <= 0)) fail('INPUT_LIMIT', '阶段字节上限必须为正整数。')
  const inputLimitBytes = Math.min(available - imageTokens, maxInputBytes ?? Infinity)
  const system = request.structuredSchema === undefined ? request.system : jsonProtocol(request.system, request.structuredSchema)
  const bytes = Buffer.byteLength(system + request.input, 'utf8'), estimatedInputTokens = bytes + imageTokens
  if (inputLimitBytes <= 0 || bytes > inputLimitBytes) fail('CONTEXT_LIMIT', `完整输入需要 ${estimatedInputTokens} token，文本预算为 ${inputLimitBytes} 字节；保留证据并暂停。`)
  return { candidateId: candidate.candidateId, inputLimitBytes, estimatedInputTokens, maxOutputTokens, capabilityRevision: candidate.capabilityRevision }
}

/** B1 制包与 B4 派发前复核共用；返回顺序保持候选优先级。 */
export function stageInputBudgets(plan: StagePlan, request: StageInput, maxInputBytes?: number): StageBudget[] {
  const budgets: StageBudget[] = [], errors: StagePolicyError[] = []
  for (const [index, candidate] of plan.candidates.entries()) {
    try { budgets.push(candidateInputBudget(plan.stage, candidate, request, index, maxInputBytes)) }
    catch (error) { if (!(error instanceof StagePolicyError)) throw error; errors.push(error) }
  }
  if (!budgets.length) throw Object.assign(new StagePolicyError('NO_COMPATIBLE_CANDIDATE', plan.stage, 0,
    plan.candidates.map(candidate => candidate.lineId + '/' + candidate.requestedModel).join(', ') || '空列表',
    '没有候选容纳完整输入，已暂停。' + errors.map(error => error.message).join('；')), { causes: errors })
  return budgets
}

export function semanticStageSettings(settings: object, stage: 'topic' | 'term'): Record<string, unknown> {
  // 阶段仅由自身内容规则失效；提取、显示、路由及向量设置不使综合正文失效。
  const keys = stage === 'topic'
    ? ['topicMaxChars', 'topicMaxSources', 'topicMaxPoints', 'topicMaxChildren', 'topicMaxDepth', 'topicMergeMinSources', 'topicRewriteAfter']
    : ['termSimilarityThreshold', 'termMaxSources', 'termMaxChars', 'termThreshold50', 'termThreshold75', 'termThreshold100']
  return Object.fromEntries(Object.entries(settings).filter(([key]) => keys.includes(key))
    .sort(([left], [right]) => left.localeCompare(right)))
}

export async function topicBudget(options: BuildLayeredOptions, operation: StageId, override = 0): Promise<number> {
  let model: number | undefined
  if (options.client.inputBudget) model = await options.client.inputBudget('ingest', options.signal, operation, operation === 'term' ? 0 : 0.1)
  else {
    const info = await options.client.info('ingest', options.signal, undefined, operation)
    if (info.context?.contextWindow !== undefined) model = operation === 'term'
      ? info.context.contextWindow - (info.defaultMaxTokens || 4096)
      : topicInputBudget(info.context.contextWindow, info.defaultMaxTokens || 4096)
  }
  if (model === undefined || !Number.isFinite(model) || model <= 0) throw new Error('主题模型未声明可用上下文或输出预留耗尽上下文。')
  const limit = Math.min(model, override || Infinity, options.maxInputBytes ?? Infinity)
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('阶段输入预算必须为正数。')
  return limit
}

// 保持来源与原文章节相邻；每个成员（含全部引文）是不可裁剪的原子。
export function orderedMembers(members: Point[]): Point[] {
  return [...members].sort((a, b) => a.point_id.split(':')[0]!.localeCompare(b.point_id.split(':')[0]!)
    || a.locator.localeCompare(b.locator, undefined, { numeric: true }) || a.point_id.localeCompare(b.point_id))
}

export function completeInputBlocks<T>(items: T[], fits: (items: T[]) => boolean): T[][] {
  const blocks: T[][] = []
  let block: T[] = []
  for (const item of items) {
    if (!fits([...block, item])) {
      if (block.length) blocks.push(block)
      block = []
      if (!fits([item])) throw new Error('单个完整成员及证据超过输入预算，保留来源层并登记缺口；不截断事实或引文。')
    }
    block.push(item)
  }
  if (block.length) blocks.push(block)
  return blocks
}
