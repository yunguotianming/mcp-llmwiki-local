import type { ModelRef } from './config.js'

export interface QueryUnderstandingSettings { enabled: boolean; model: ModelRef; timeoutMs: number; inputTokens: number; outputTokens: number; maxVariants: number }
export const MAX_QUERY_OUTPUT_TOKENS = 64000
export const defaultQueryUnderstanding: QueryUnderstandingSettings = {
  enabled: true, model: { provider: 'deepseek-official', model: 'deepseek-flash' }, timeoutMs: 30000, inputTokens: 1500, outputTokens: 2000, maxVariants: 3,
}
export function queryUnderstandingSettings(value: Partial<QueryUnderstandingSettings> = {}): QueryUnderstandingSettings {
  const settings = { ...defaultQueryUnderstanding, ...value }
  if (typeof settings.enabled !== 'boolean' || !settings.model || typeof settings.model.provider !== 'string' || typeof settings.model.model !== 'string'
    || Boolean(settings.model.provider.trim()) !== Boolean(settings.model.model.trim())) throw new Error('查询理解模型的供应商与模型必须成对选择。')
  for (const [key, max] of [['timeoutMs', 30000], ['inputTokens', 1500], ['outputTokens', MAX_QUERY_OUTPUT_TOKENS], ['maxVariants', 3]] as const)
    if (!Number.isSafeInteger(settings[key]) || settings[key] < 1 || settings[key] > max) throw new Error(`查询理解 ${key} 必须是 1～${max} 的整数。`)
  return settings
}
