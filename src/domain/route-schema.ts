import { z } from 'zod'
export const buildStages = ['extract', 'extractionReview', 'topic', 'parent', 'topicReview', 'term', 'rewrite'] as const
export type StageId = typeof buildStages[number]
const positive = z.number().int().positive()
const nonempty = z.string().min(1).refine(value => Boolean(value.trim()), '不能为空白字符串。')
// 连接凭据只存在宿主登记；随库候选仍只保存线路和模型引用。
const endpoint = z.string().refine(value => {
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash }
  catch { return false }
}, '接口地址须为不含凭据、查询参数和片段的 HTTP(S) 地址。')
const credential = { apiKey: z.string().min(1).optional(), apiKeyEnv: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional() }
export const compatibleProviderSchema = z.strictObject({ baseUrl: endpoint, model: nonempty,
  api: z.enum(['openai-completions', 'openai-responses']), ...credential,
  contextWindowTokens: positive.optional(), maxOutputTokens: positive.optional(),
  inputModalities: z.array(z.enum(['text', 'image'])).min(1).optional(), reasoningEfforts: z.array(nonempty).optional(),
}).refine(value => !(value.apiKey && value.apiKeyEnv), '明文密钥与环境变量名只能选择一种。')
export const compatibleProvidersSchema = z.record(z.string().regex(/^compatible:[a-zA-Z0-9_-]+$/), compatibleProviderSchema)
export type CompatibleProviders = z.infer<typeof compatibleProvidersSchema>
export const embeddingServiceSchema = z.strictObject({ baseUrl: endpoint, model: nonempty, ...credential })
  .refine(value => !(value.apiKey && value.apiKeyEnv), '明文密钥与环境变量名只能选择一种。')
export type EmbeddingServiceConfig = z.infer<typeof embeddingServiceSchema>
export const buildParametersSchema = z.strictObject({ reasoningEffort: nonempty.optional(), temperature: z.number().nonnegative().optional(), maxOutputTokens: positive.optional() })
const stageSelection = z.strictObject({ selection: z.enum(['priority-spillover', 'failover']), candidates: z.array(z.strictObject({
  line: nonempty, model: nonempty, parameters: buildParametersSchema.optional(),
})).min(1) }).superRefine((value, ctx) => {
  const lines = new Set<string>()
  value.candidates.forEach((candidate, index) => {
    if (lines.has(candidate.line)) ctx.addIssue({ code: 'custom', path: ['candidates', index, 'line'], message: '同阶段候选线路不能重复。' })
    lines.add(candidate.line)
  })
})
export const buildModelsSchema = z.strictObject({
  version: z.literal(1),
  stages: z.strictObject({ extract: stageSelection, extractionReview: stageSelection, topic: stageSelection, parent: stageSelection,
    topicReview: stageSelection, term: stageSelection, rewrite: stageSelection }),
  retry: z.strictObject({ maxAttempts: positive, maxAttemptsPerLine: positive, deadlineMs: positive }).refine(value => value.maxAttemptsPerLine <= value.maxAttempts, '每线尝试上限不能超过总上限。'),
  reuseAccepted: z.literal(true),
})
export type BuildModels = z.infer<typeof buildModelsSchema>
export const upgradeSchema = z.strictObject({ maxCalls: z.number().int().nonnegative().optional(), maxTokens: z.number().int().nonnegative().optional() })
export type UpgradeLimits = z.infer<typeof upgradeSchema>
const adaptiveSchema = z.strictObject({ enabled: z.boolean().default(false), healthWindowMs: positive.optional(), minSuccesses: positive.optional(),
  consecutiveFailureLimit: positive.optional(), failureRateWindow: positive.optional(), failureRateThreshold: z.number().gt(0).max(1).optional(),
  cooldownMs: positive.optional(), maxCooldownMs: positive.optional() }).superRefine((value, ctx) => {
  if (value.enabled) for (const key of ['healthWindowMs', 'minSuccesses', 'consecutiveFailureLimit', 'failureRateWindow', 'failureRateThreshold', 'cooldownMs', 'maxCooldownMs'] as const) {
    if (value[key] === undefined) ctx.addIssue({ code: 'custom', path: [key], message: '启用自适应时必须显式填写。' })
  }
  if (value.maxCooldownMs !== undefined && value.cooldownMs !== undefined && value.maxCooldownMs < value.cooldownMs)
    ctx.addIssue({ code: 'custom', path: ['maxCooldownMs'], message: '最大冷却时间不能小于初始冷却时间。' })
})
export const modelExecutionSchema = z.strictObject({
  globalMaxInFlight: positive.max(1000),
  lineBindings: z.record(nonempty, z.strictObject({ provider: nonempty, quotaGroupId: nonempty, maxConcurrency: positive,
    initialConcurrency: positive.optional(), minConcurrency: positive.optional(), adaptive: adaptiveSchema.optional(),
  }).superRefine((value, ctx) => {
    const initial = value.initialConcurrency ?? value.maxConcurrency, min = value.minConcurrency ?? 1
    if (min > initial || initial > value.maxConcurrency) ctx.addIssue({ code: 'custom', message: '并发必须满足 min ≤ initial ≤ max。' })
    if (value.adaptive?.enabled && (value.initialConcurrency === undefined || value.minConcurrency === undefined))
      ctx.addIssue({ code: 'custom', message: '自适应线路必须显式填写初始和最小并发。' })
  })),
  quotaGroups: z.record(nonempty, z.strictObject({ maxConcurrency: positive, rpm: positive.optional(), tpm: positive.optional() })),
})
export type ModelExecution = z.infer<typeof modelExecutionSchema>
const ref=z.strictObject({provider:z.string().trim(),model:z.string().trim()}).refine(value=>!!value.provider===!!value.model,'供应商与模型必须成对选择。')
const profile=z.strictObject({concurrency:z.number().int().min(1).max(1000),requestsPerMinute:z.number().int().positive().optional(),tokensPerMinute:z.number().int().positive().optional(),
  retryLimit:z.number().int().min(0).max(10),backoffMs:z.number().int().min(0),cacheMode:z.enum(['automatic-prefix','none'])})
const layeredRoute=z.strictObject({route:ref.optional(),reasoningEffort:z.string().optional()})
export const routesSchema=z.strictObject({unified:ref,perTask:z.boolean(),ingest:ref,query:ref,lint:ref,vision:ref,
  fallbacks:z.array(ref.refine(value=>!!value.provider&&!!value.model,'备用配置需要供应商与模型。')),
  providerProfiles:z.record(z.string(),profile).default({}),
  layeredRoutes:z.object({extract:layeredRoute.optional(),extractionReview:layeredRoute.optional(),topic:layeredRoute.optional(),parent:layeredRoute.optional(),topicReview:layeredRoute.optional(),term:layeredRoute.optional(),rewrite:layeredRoute.optional()}).default({})})
