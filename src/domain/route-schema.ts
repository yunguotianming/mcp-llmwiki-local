import { z } from 'zod'
const ref=z.strictObject({provider:z.string().trim(),model:z.string().trim()}).refine(value=>!!value.provider===!!value.model,'供应商与模型必须成对选择。')
const profile=z.strictObject({concurrency:z.number().int().min(1).max(1000),requestsPerMinute:z.number().int().positive().optional(),tokensPerMinute:z.number().int().positive().optional(),
  retryLimit:z.number().int().min(0).max(10),backoffMs:z.number().int().min(0),cacheMode:z.enum(['automatic-prefix','none'])})
const layeredRoute=z.strictObject({route:ref.optional(),reasoningEffort:z.string().optional()})
export const routesSchema=z.strictObject({unified:ref,perTask:z.boolean(),ingest:ref,query:ref,lint:ref,vision:ref,
  fallbacks:z.array(ref.refine(value=>!!value.provider&&!!value.model,'备用配置需要供应商与模型。')),
  providerProfiles:z.record(z.string(),profile).default({}),
  layeredRoutes:z.object({extract:layeredRoute.optional(),topic:layeredRoute.optional(),parent:layeredRoute.optional(),term:layeredRoute.optional(),rewrite:layeredRoute.optional()}).default({})})
