export interface LibraryPolicy {
  version: 1
  wikiLanguage: string
  useCustomWikiLanguage: boolean
  concurrencyLimit: number
  pageGenerationConcurrency: number
  analysisConcurrency: number
  batchDelayMs: number
  ingestRequestTimeoutSeconds: number
  maxTokensPerCall: number
  contextWindowTokens: number
  advancedSettingsMode: 'default' | 'custom'
  disableThinking: boolean
  extractionTemperature: number | null
  chatTemperature: number | null
  reasoningEffort: string
  extractionGranularity: 'minimal' | 'coarse' | 'balanced' | 'standard' | 'detailed' | 'fine' | 'custom'
  customPointLimit?: number | undefined
  customEntityLimit: number
  customConceptLimit: number
  tagVocabularyMode: 'auto' | 'custom'
  customEntityTags: string[]
  customConceptTags: string[]
  startupCheckNoticeLevel: 'off' | 'errors' | 'all'
  autoWatchSources: boolean
  autoWatchMode: 'notify' | 'auto'
  autoWatchDebounceMs: number
  periodicLint: 'off' | 'daily' | 'weekly'
  autoSmartFix: boolean
  automaticOperations: ('ingest' | 'update' | 'repair')[]
  showAdvancedSettings: boolean
  maxConversationHistory: number
  queryInstructions: string
  slugCase: 'lower' | 'preserve'
  minAliasLength: number
  createWelcomeNote: boolean
  skipMentionOnlyCandidates: boolean
  createStubsForUnresolvableLinks: boolean
  lintJaccardLinkThreshold: number
  lintJaccardBodyGate: number
  lintBigramThreshold: number
  lintDedupIncludeSources: boolean
  imageStrategy: 'on-demand' | 'all' | 'text-only'
}
export function defaultPolicy(): LibraryPolicy {
  return { version: 1, wikiLanguage: 'zh-CN', useCustomWikiLanguage: false, concurrencyLimit: 50, pageGenerationConcurrency: 3,
    analysisConcurrency: 1, batchDelayMs: 500, ingestRequestTimeoutSeconds: 600, maxTokensPerCall: 0, contextWindowTokens: 0,
    advancedSettingsMode: 'default', disableThinking: false, extractionTemperature: null, chatTemperature: null,
    reasoningEffort: '', extractionGranularity: 'standard', customEntityLimit: 5, customConceptLimit: 5,
    tagVocabularyMode: 'auto', customEntityTags: [], customConceptTags: [], startupCheckNoticeLevel: 'all',
    autoWatchSources: false, autoWatchMode: 'notify', autoWatchDebounceMs: 5000, periodicLint: 'off',
    autoSmartFix: false, automaticOperations: [], showAdvancedSettings: false, maxConversationHistory: 30, queryInstructions: '', slugCase: 'lower', minAliasLength: 2,
    createWelcomeNote: true, skipMentionOnlyCandidates: false, createStubsForUnresolvableLinks: true,
    lintJaccardLinkThreshold: 0.4, lintJaccardBodyGate: 0.2, lintBigramThreshold: 0.4,
    lintDedupIncludeSources: true, imageStrategy: 'text-only' }
}
export function validatePolicy(policy: LibraryPolicy): string[] {
  const errors: string[] = []
  const integer = (key: keyof LibraryPolicy, min: number, max: number) => {
    const value = policy[key]
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) errors.push(`${key} 应为 ${min}～${max} 的整数。`)
  }
  integer('concurrencyLimit', 1, 1000)
  integer('analysisConcurrency', 1, 1000); integer('pageGenerationConcurrency', 1, 1000)
  for (const key of ['analysisConcurrency', 'pageGenerationConcurrency'] as const) if (policy[key] > policy.concurrencyLimit) errors.push(`${key} 不能超过并发上限 ${policy.concurrencyLimit}。`)
  integer('batchDelayMs', 0, 3600000); integer('ingestRequestTimeoutSeconds', 1, 86400)
  integer('maxTokensPerCall', 0, 1000000); integer('autoWatchDebounceMs', 100, 3600000)
  if (![0,64000,128000,256000,512000,1000000].includes(policy.contextWindowTokens)) errors.push('上下文上限请选择自动、64K、128K、256K、512K 或 1M。')
  integer('maxConversationHistory', 1, 1000); integer('minAliasLength', 2, 6)
  integer('customEntityLimit', 1, 1000); integer('customConceptLimit', 1, 1000)
  for (const key of ['extractionTemperature', 'chatTemperature'] as const) {
    const value = policy[key]
    if (value !== null && (!Number.isFinite(value) || value < 0 || value > 2)) errors.push(`${key} 应在 0～2 之间，或留空使用模型默认值。`)
  }
  for (const key of ['lintJaccardLinkThreshold', 'lintJaccardBodyGate', 'lintBigramThreshold'] as const) if (!Number.isFinite(policy[key]) || policy[key] < 0 || policy[key] > 1) errors.push(`${key} 应在 0～1 之间。`)
  if (!policy.wikiLanguage.trim()) errors.push('请填写输出语言。')
  return errors
}
export function resetAdvanced(policy: LibraryPolicy): LibraryPolicy {
  const defaults = defaultPolicy()
  return { ...policy, advancedSettingsMode: 'default', disableThinking: defaults.disableThinking,
    extractionTemperature: defaults.extractionTemperature, chatTemperature: defaults.chatTemperature, reasoningEffort: '' }
}
export function processingPolicy(policy:LibraryPolicy) {
  const {concurrencyLimit:_limit,analysisConcurrency:_sources,pageGenerationConcurrency:_calls,batchDelayMs:_delay,contextWindowTokens,...processing}=policy
  // 自动模式沿用旧处理签名，旧作业和提取缓存可继续核验。
  return contextWindowTokens ? {...processing,contextWindowTokens} : processing
}
export function closeAdvanced(policy:LibraryPolicy):LibraryPolicy {
  const defaults=defaultPolicy()
  return {...policy,showAdvancedSettings:false,slugCase:defaults.slugCase,skipMentionOnlyCandidates:defaults.skipMentionOnlyCandidates,
    lintJaccardLinkThreshold:defaults.lintJaccardLinkThreshold,lintJaccardBodyGate:defaults.lintJaccardBodyGate,lintBigramThreshold:defaults.lintBigramThreshold,lintDedupIncludeSources:defaults.lintDedupIncludeSources}
}
