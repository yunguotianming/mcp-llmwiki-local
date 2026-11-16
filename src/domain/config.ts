import { linkedGranularity } from './granularity.js'
import { embeddingStandardName, isLibraryDirectoryName } from './embedding-name.js'
import { queryUnderstandingSettings } from './query-settings.js'
import type { QueryUnderstandingSettings } from './query-settings.js'
import { compatibleProvidersSchema, embeddingServiceSchema, modelExecutionSchema, upgradeSchema } from './route-schema.js'
import type { CompatibleProviders, EmbeddingServiceConfig, ModelExecution, StageId, UpgradeLimits } from './route-schema.js'
import { libraryOrganizationSchema, registryOrganizationSchema } from './registry-schema.js'
import type { LibraryOrganization, RegistryOrganization } from './registry-schema.js'
export const NAMESPACE = 'llmwiki'
export const TASKS = ['ingest', 'query', 'lint', 'vision'] as const
export type Task = typeof TASKS[number]
export type LibraryKind = 'local' | 'siyuan' | 'obsidian' | 'whalefall'
export interface SiyuanSettings {
  whalefallUrl: string; credentialRef: string; workspaceId: string; workspacePath: string; notebookIds: string[]
  excludeAttribute?: string | undefined; admissionTimeoutMs?: number | undefined; pollWaitMs?: number | undefined; pollIntervalMs?: number | undefined
}
export function siyuanSettings(value: SiyuanSettings) {
  const settings = { ...value, excludeAttribute: value.excludeAttribute ?? 'llmwiki', admissionTimeoutMs: value.admissionTimeoutMs ?? 3000,
    pollWaitMs: value.pollWaitMs ?? 25000, pollIntervalMs: value.pollIntervalMs ?? 1000 }
  let url: URL
  try { url = new URL(settings.whalefallUrl) } catch { throw new Error('whalefall 地址无效。') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('whalefall 地址不能包含凭据、查询参数或片段。')
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(settings.credentialRef) || !/^[A-Za-z0-9_-]{1,128}$/.test(settings.workspaceId)
    || !/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(settings.workspacePath) || !Array.isArray(settings.notebookIds)
    || settings.notebookIds.length > 1000 || settings.notebookIds.some(id => !/^[A-Za-z0-9_-]{1,128}$/.test(id))
    || !/^[A-Za-z][A-Za-z0-9_-]{0,99}$/.test(settings.excludeAttribute)) throw new Error('思源工作空间、凭据引用或收录配置无效。')
  for (const key of ['admissionTimeoutMs', 'pollWaitMs', 'pollIntervalMs'] as const) if (!Number.isSafeInteger(settings[key]) || settings[key] < 1) throw new Error('思源超时和轮询间隔必须是正整数。')
  if (settings.pollWaitMs > 25000) throw new Error('思源长轮询等待不能超过 25000 毫秒。')
  return settings
}
export type AccessMode = 'readonly' | 'managed' | 'shared'
export interface ModelRef { provider: string; model: string }
export type LayeredModelTask = StageId
export interface ProviderProfile {
  concurrency: number; requestsPerMinute?: number | undefined; tokensPerMinute?: number | undefined
  retryLimit: number; backoffMs: number; cacheMode: 'automatic-prefix' | 'none'
}
export interface LayeredModelRoute { route?: ModelRef | undefined; reasoningEffort?: string | undefined }
export const defaultProviderProfile: ProviderProfile = { concurrency: 50, retryLimit: 2, backoffMs: 2000, cacheMode: 'automatic-prefix' }
export interface LayeredSettings {
  sourceMatchThreshold: number
  embeddingMode: 'auto' | 'ollama' | 'cloud' | 'none'
  pointLabelsOnBuild: boolean
  embeddingUnavailable: 'pause' | 'continue'
  embeddingChangeToken?: string | undefined
  sourcePackRatio: number; sourceLongChapterChars: number
  extractionReview: 'off' | 'key' | 'all'; topicReview: boolean; contradictionReview: boolean
  sourceOverviewChineseChars: number; sourceOverviewEnglishWords: number
  searchRelevanceThreshold: number
  tagLimit: number; tagVocabularyOnly: boolean
  extractMaxInputBytes: number
  extractMaxSplitDepth: number; extractTargetRatio: number; extractCeilingRatio: number
  sourceSummaryFanout: number; sourceSummaryMaxPoints: number
  sourcePointBaseChars: number; sourcePointMaxMultiplier: number; sourceChapterMinPoints: number
  localEmbeddingUrl: string; localEmbeddingModel: string; topicSimilarityThreshold: number
  cloudEmbeddingUrl: string; cloudEmbeddingModel: string; cloudEmbeddingKeyEnv: string
  lexicalTopicSimilarityThreshold: number; lexicalTopicAttachThreshold: number
  topicAttachThreshold: number; topicMaxPoints: number; topicClusterBlockSize: number; topicNeighborCount: number
  embeddingConcurrency: number; embeddingBatchSize: number; embeddingBatchBytes: number; embeddingTimeoutMs: number
  queryEmbeddingTimeoutMs: number; queryEmbeddingColdTimeoutMs: number
  vectorPrecision: 'float32' | 'float16'; writerTakeoverToken?: string | undefined
  leafInputBudget: number; topicReviewInputBudget: number; topicMaxChars: number; topicMaxSources: number
  parentInputBudget: number; topicMaxChildren: number; topicMaxDepth: number; topicMergeMinSources: number; topicRewriteAfter: number
  termInputBudget: number; termMaxSources: number; termMaxChars: number; termSectionQuota: number; termSimilarityThreshold: number
  termIndexMaxPages: number; termIndexPageSize: number
  termThreshold50: number; termThreshold75: number; termThreshold100: number
  maxBuildCalls?: number; maxBuildTokens?: number; maxBatchItems: number
  extractionCorrectionRatio: number; topicCorrectionRatio: number; correctionMinCalls: number
}
// renderTopic 最短本地正文：单字标题、摘要、要点和来源名，单来源、单引用。
// 含固定小节、导航、S-0001、71 字符 sha256 版本、L1-L1、13 字符块 ID 及换行；不含 YAML。
export const MIN_TOPIC_MAX_CHARS = 233
export const defaultLayeredSettings: LayeredSettings = {
  sourceMatchThreshold: 0.5,
  embeddingMode: 'auto', pointLabelsOnBuild: false, embeddingUnavailable: 'pause',
  sourcePackRatio: 0.5, sourceLongChapterChars: 0, extractionReview: 'key', topicReview: true, contradictionReview: false,
  sourceOverviewChineseChars: 240, sourceOverviewEnglishWords: 120,
  searchRelevanceThreshold: 0.2,
  tagLimit: 8, tagVocabularyOnly: false,
  extractMaxInputBytes: 98304,
  extractMaxSplitDepth: 3, extractTargetRatio: 0.85, extractCeilingRatio: 0.9,
  sourceSummaryFanout: 8, sourceSummaryMaxPoints: 8,
  sourcePointBaseChars: 25000, sourcePointMaxMultiplier: 4, sourceChapterMinPoints: 1,
  localEmbeddingUrl: 'http://127.0.0.1:11434', localEmbeddingModel: 'qwen3-embedding:0.6b',
  cloudEmbeddingUrl: 'https://api.openai.com/v1', cloudEmbeddingModel: 'text-embedding-3-small', cloudEmbeddingKeyEnv: 'LLMWIKI_EMBEDDING_API_KEY',
  embeddingConcurrency: 3, embeddingBatchSize: 32, embeddingBatchBytes: 32768, embeddingTimeoutMs: 120000,
  queryEmbeddingTimeoutMs: 2000, queryEmbeddingColdTimeoutMs: 10000,
  vectorPrecision: 'float32',
  topicSimilarityThreshold: 0.65, topicAttachThreshold: 0.60, topicMaxPoints: 40, topicClusterBlockSize: 2000, topicNeighborCount: 64,
  // r3 已发布库：2652 要点、无补标；0.01 网格最大 F1，成对合并 0.11、留一质心并入 0.22。
  lexicalTopicSimilarityThreshold: 0.11, lexicalTopicAttachThreshold: 0.22,
  leafInputBudget: 0, topicReviewInputBudget: 0, topicMaxChars: 12000, topicMaxSources: 20,
  parentInputBudget: 0, topicMaxChildren: 8, topicMaxDepth: 3, topicMergeMinSources: 3, topicRewriteAfter: 10,
  termInputBudget: 12000, termMaxSources: 20, termMaxChars: 6000, termSectionQuota: 16, termSimilarityThreshold: 0.9,
  // 类别不超过 50 个时一类一页；超过后按 200 个术语一页定量分页（194 篇护士库实测出现 1200 个类别）。
  termIndexMaxPages: 50, termIndexPageSize: 200,
  termThreshold50: 5, termThreshold75: 3, termThreshold100: 2,
  maxBatchItems: 8,
  extractionCorrectionRatio: 2, topicCorrectionRatio: 2, correctionMinCalls: 10,
}
export function normalizeCloudEmbeddingUrl(value: string): string {
  let url: URL
  try { url = new URL(value) } catch { throw new Error('云端向量服务地址无效。') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error('云端向量服务地址不能包含凭据、查询参数或片段。')
  return url.toString().replace(/\/+$/, '')
}
export function embeddingEndpoint(settings: LayeredSettings): { url: string; model: string } {
  return settings.embeddingMode === 'cloud' ? { url: settings.cloudEmbeddingUrl, model: settings.cloudEmbeddingModel }
    : { url: settings.localEmbeddingUrl, model: settings.localEmbeddingModel }
}
export function layeredSettings(value: Partial<LayeredSettings> = {}, tier = 50): LayeredSettings {
  const settings = { ...defaultLayeredSettings, ...linkedGranularity(tier).defaults, ...value }, url = new URL(settings.localEmbeddingUrl)
  if (!Number.isFinite(settings.sourceMatchThreshold) || settings.sourceMatchThreshold < 0 || settings.sourceMatchThreshold > 1) throw new Error('来源相似度阈值必须在 0～1 之间。')
  if (!['auto', 'ollama', 'cloud', 'none'].includes(settings.embeddingMode) || !['pause', 'continue'].includes(settings.embeddingUnavailable)) throw new Error('向量方式或离线处理选项无效。')
  settings.cloudEmbeddingUrl = normalizeCloudEmbeddingUrl(settings.cloudEmbeddingUrl ?? defaultLayeredSettings.cloudEmbeddingUrl)
  if (typeof settings.cloudEmbeddingModel !== 'string' || !settings.cloudEmbeddingModel.trim()) throw new Error('云端嵌入模型名不能为空。')
  settings.cloudEmbeddingModel = settings.cloudEmbeddingModel.trim()
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(settings.cloudEmbeddingKeyEnv)) throw new Error('云端密钥环境变量名无效，请填写变量名而非密钥。')
  if (typeof settings.pointLabelsOnBuild !== 'boolean') throw new Error('建库时补充要点标签必须为开关值。')
  if (settings.embeddingChangeToken !== undefined && !/^[a-f0-9-]{36}$/.test(settings.embeddingChangeToken)) throw new Error('向量身份切换标识无效。')
  for (const key of ['extractionCorrectionRatio', 'topicCorrectionRatio'] as const) if (!Number.isFinite(settings[key]) || settings[key] <= 0) throw new Error('阶段纠正率上限必须为正数。')
  if (!Number.isSafeInteger(settings.correctionMinCalls) || settings.correctionMinCalls < 1) throw new Error('纠正护栏最小调用基数必须为正整数。')
  for (const key of ['leafInputBudget', 'parentInputBudget', 'topicReviewInputBudget'] as const) if (!Number.isSafeInteger(settings[key]) || settings[key] < 0) throw new Error('主题输入预算必须为非负整数，0 表示跟随模型上下文。')
  if (settings.topicMaxChars < MIN_TOPIC_MAX_CHARS) throw new Error(`配置错误：topicMaxChars 至少为 ${MIN_TOPIC_MAX_CHARS}，否则最短合法主题正文超出长度上限，无法开始建库。`)
  if (!Number.isFinite(settings.searchRelevanceThreshold) || settings.searchRelevanceThreshold < 0 || settings.searchRelevanceThreshold > 1) throw new Error('查询可信匹配门槛必须在 0～1 之间。')
  if (!Number.isInteger(settings.tagLimit) || settings.tagLimit < 1 || settings.tagLimit > 8 || typeof settings.tagVocabularyOnly !== 'boolean') throw new Error('标签上限必须为 1～8 的整数，只用标签词表必须为开关值。')
  if (!['float32', 'float16'].includes(settings.vectorPrecision)) throw new Error('向量精度必须为 float32 或 float16。')
  if (settings.writerTakeoverToken !== undefined && !/^[a-f0-9-]{36}$/.test(settings.writerTakeoverToken)) throw new Error('接管建库设备的操作标识无效。')
  if (!Number.isSafeInteger(settings.extractMaxSplitDepth) || settings.extractMaxSplitDepth < 0 || settings.extractMaxSplitDepth > 10) throw new Error('提取缩段层数必须为 0～10 的整数。')
  if (![settings.extractTargetRatio, settings.extractCeilingRatio].every(ratio => Number.isFinite(ratio) && ratio >= 0.01 && ratio <= 1) || settings.extractTargetRatio > settings.extractCeilingRatio) throw new Error('切分目标和上限比例必须在 0.01～1 之间，目标不能大于上限。')
  for (const key of ['sourceSummaryFanout', 'sourceSummaryMaxPoints', 'sourcePointBaseChars', 'sourcePointMaxMultiplier'] as const)
    if (!Number.isSafeInteger(settings[key]) || settings[key] < 1) throw new Error('长文摘要和配额设置必须为正整数。')
  for (const key of ['sourceChapterMinPoints', 'sourceLongChapterChars', 'sourceOverviewChineseChars', 'sourceOverviewEnglishWords'] as const)
    if (!Number.isSafeInteger(settings[key]) || settings[key] < 0) throw new Error('章节底线与概览上限必须为非负整数。')
  if (!Number.isFinite(settings.sourcePackRatio) || settings.sourcePackRatio < 0 || settings.sourcePackRatio > 1) throw new Error('章节包阈值须为 0～1，0 表示关闭主动分包。')
  if (!['off', 'key', 'all'].includes(settings.extractionReview) || typeof settings.topicReview !== 'boolean' || typeof settings.contradictionReview !== 'boolean') throw new Error('核对设置无效。')
  if (settings.sourceSummaryFanout < 2 || settings.sourceSummaryFanout > 10) throw new Error('来源摘要合成路数必须在 2～10 之间。')
  if (!['http:', 'https:'].includes(url.protocol) || !settings.localEmbeddingModel.trim()) throw new Error('本地向量模型地址或模型名无效。')
  for (const key of ['embeddingBatchSize', 'embeddingBatchBytes', 'embeddingTimeoutMs'] as const) if (!Number.isSafeInteger(settings[key]) || settings[key] <= 0) throw new Error('嵌入批次上限和超时必须为正整数。')
  if (!Number.isInteger(settings.embeddingConcurrency) || settings.embeddingConcurrency < 1 || settings.embeddingConcurrency > 16) throw new Error('向量端点并发必须为 1～16 的整数。')
  if (settings.embeddingTimeoutMs > 2147483647) throw new Error('嵌入超时超出计时器范围。')
  for (const key of ['queryEmbeddingTimeoutMs', 'queryEmbeddingColdTimeoutMs'] as const)
    if (!Number.isSafeInteger(settings[key]) || settings[key] < 1 || settings[key] > 2147483647) throw new Error('查询向量时限必须为 1～2147483647 毫秒的整数。')
  if (settings.queryEmbeddingColdTimeoutMs < settings.queryEmbeddingTimeoutMs) throw new Error('查询向量冷态时限不能短于就绪时限。')
  if (!Number.isFinite(settings.topicSimilarityThreshold) || settings.topicSimilarityThreshold < 0 || settings.topicSimilarityThreshold > 1) throw new Error('主题相似度阈值必须在 0～1 之间。')
  for (const key of ['lexicalTopicSimilarityThreshold', 'lexicalTopicAttachThreshold'] as const) {
    if (!Number.isFinite(settings[key]) || settings[key] < 0 || settings[key] > 1) throw new Error('词项主题阈值必须在 0～1 之间。')
  }
  if (!Number.isFinite(settings.topicAttachThreshold) || settings.topicAttachThreshold < 0 || settings.topicAttachThreshold > 1) throw new Error('主题并入阈值必须在 0～1 之间。')
  for (const key of ['topicMaxPoints', 'topicClusterBlockSize', 'topicNeighborCount'] as const) if (!Number.isSafeInteger(settings[key]) || settings[key] < 1) throw new Error('主题要点、分块和近邻上限必须为正整数。')
  if (settings.topicClusterBlockSize > 2000) throw new Error('主题候选块不能超过 2000。')
  if (!Number.isFinite(settings.termSimilarityThreshold) || settings.termSimilarityThreshold < 0 || settings.termSimilarityThreshold > 1) throw new Error('术语相似度阈值必须在 0～1 之间。')
  for (const key of ['termIndexMaxPages', 'termIndexPageSize', 'extractMaxInputBytes', 'topicMaxChars', 'topicMaxSources', 'topicMaxChildren', 'topicMaxDepth', 'topicMergeMinSources', 'topicRewriteAfter', 'termInputBudget', 'termMaxSources', 'termMaxChars', 'termSectionQuota', 'termThreshold50', 'termThreshold75', 'termThreshold100', 'maxBatchItems'] as const) if (!Number.isSafeInteger(settings[key]) || settings[key] <= 0) throw new Error('分层预算和上限必须为正整数。')
  for (const key of ['maxBuildCalls', 'maxBuildTokens'] as const) if (settings[key] !== undefined && (!Number.isSafeInteger(settings[key]) || settings[key]! <= 0)) throw new Error('建库预算上限必须为正整数。')
  if (settings.topicMaxChildren < 2) throw new Error('子主题数上限至少为 2。')
  return settings
}
export interface ModelRoutes {
  unified: ModelRef
  perTask: boolean
  ingest: ModelRef
  query: ModelRef
  lint: ModelRef
  vision: ModelRef
  fallbacks: ModelRef[]
  providerProfiles: Record<string, ProviderProfile>
  layeredRoutes: Record<string, LayeredModelRoute | undefined>
}
export interface LibraryRegistration extends LibraryOrganization {
  id: string
  name: string
  description: string
  kind: LibraryKind
  mode: AccessMode
  enabled: boolean
  sourceRoots: string[]
  wikiPath: string
  vaultPath: string
  kbId: string
  catalogId: string
  location: string
  models: ModelRoutes
  layered?: Partial<LayeredSettings>
  queryUnderstanding?: Partial<QueryUnderstandingSettings>
  siyuan?: SiyuanSettings
}
export interface Registry extends RegistryOrganization {
  compatibleProviders?: CompatibleProviders | undefined
  embeddingService?: EmbeddingServiceConfig | undefined
  modelExecution?: ModelExecution | undefined
  upgrade?: UpgradeLimits | undefined
  language: 'zh' | 'en'
  activeLibraryId: string
  libraries: LibraryRegistration[]
  readMaxChars: number
}
export function emptyModels(): ModelRoutes {
  const empty = (): ModelRef => ({ provider: '', model: '' })
  return { unified: empty(), perTask: false, ingest: empty(), query: empty(), lint: empty(), vision: empty(), fallbacks: [], providerProfiles: {}, layeredRoutes: {} }
}
export function emptyRegistry(): Registry { return { language: 'zh', activeLibraryId: '', libraries: [], readMaxChars: 12000 } }
export function newLibrary(id: string): LibraryRegistration {
  return { id, name: '新 Wiki 数据库', description: '', kind: 'local', mode: 'managed', enabled: true,
    sourceRoots: [], wikiPath: '', vaultPath: '', kbId: '', catalogId: '', location: '', models: defaultLibraryModels() }
}
export function defaultLibraryModels(): ModelRoutes {
  return { ...emptyModels(), unified: { provider: 'codex-cli', model: 'gpt-6.1-terra' },
    layeredRoutes: Object.fromEntries(['extract', 'topic', 'parent', 'term', 'rewrite'].map(task => [task, { reasoningEffort: 'high' }])) }
}
/** 本地库未指定资料目录时使用库父目录；显式来源始终优先。 */
export function defaultSourceRoot(wikiPath: string): string {
  const normalized = wikiPath.trim().replaceAll('\\', '/').replace(/\/+$/, '')
  if (!/^(?:[a-zA-Z]:\/|\/)/.test(normalized) || normalized.split('/').some(part => part === '.' || part === '..')) return ''
  const split = normalized.lastIndexOf('/')
  if (!isLibraryDirectoryName(normalized.slice(split + 1))) return ''
  let parent = normalized.slice(0, split) || '/'
  if (normalized.startsWith('//') && parent.split('/').filter(Boolean).length < 2) return ''
  if (/^[a-zA-Z]:$/.test(parent)) parent += '/'
  return wikiPath.includes('\\') ? parent.replaceAll('/', '\\') : parent
}
export function effectiveSourceRoots(library: Pick<LibraryRegistration, 'kind' | 'wikiPath' | 'sourceRoots' | 'siyuan'>): string[] {
  if (library.sourceRoots.length || library.kind !== 'local' || library.siyuan) return library.sourceRoots
  const root = defaultSourceRoot(library.wikiPath)
  return root ? [root] : []
}
// 旧分层思源登记只改来源类型；本地空来源采用库父目录，不迁移随库状态。
export function migrateRegistry(registry: Registry): Registry {
  return { ...registry, libraries: registry.libraries.map(library => library.kind === 'local' && library.siyuan
    ? { ...library, kind: 'siyuan' } : { ...library, sourceRoots: effectiveSourceRoots(library) }) }
}
export function defaultWikiPath(sourceRoots:string[], embedding: Partial<LayeredSettings> = {}):string {
  if(sourceRoots.length!==1)return ''
  const source=sourceRoots[0]!.trim(),normalized=source.replaceAll('\\','/')
  if(!/^(?:[a-zA-Z]:\/|\/)/.test(normalized)||normalized.split('/').some(part=>part==='.'||part==='..'))return ''
  if(normalized.startsWith('//')&&normalized.split('/').filter(Boolean).length<2)return ''
  const settings = layeredSettings(embedding)
  return source.replace(/[\\/]+$/,'')+(source.includes('\\')?'\\':'/')+'.llmwiki-'+embeddingStandardName({ model: embeddingEndpoint(settings).model, embeddingMode: settings.embeddingMode })
}
export function isWritable(library: LibraryRegistration): boolean {
  return library.kind !== 'whalefall' && library.mode !== 'readonly'
}
export function resolveModel(routes: ModelRoutes, task: Task): ModelRef {
  // 识图使用明确选择的视觉路由，不能继承未经能力检查的文本模型。
  const override = routes[task]
  if ((routes.perTask || task === 'vision' || task === 'query') && override.provider && override.model) return { ...override }
  return { ...routes.unified }
}
export function resolveLayeredModel(routes: ModelRoutes, task: LayeredModelTask): ModelRef {
  const override = resolveLayeredRoute(routes, task)?.route
  return override?.provider && override.model ? { ...override } : { ...routes.unified }
}
export function resolveLayeredRoute(routes: ModelRoutes, task: LayeredModelTask): LayeredModelRoute | undefined {
  return routes.layeredRoutes?.[task] ?? (task === 'extractionReview' || task === 'topicReview' ? routes.layeredRoutes?.extract : undefined)
}
export function providerProfile(routes: ModelRoutes, provider: string): ProviderProfile {
  return { ...defaultProviderProfile, ...routes.providerProfiles?.[provider] }
}
export interface ConfigIssue { field: string; message: string }
// 宿主配置入口与本地表单共用跨字段校验，表单 Schema 单独传输纯数据约束。
export function parseRegistry(registry: Registry): Registry {
  registry = migrateRegistry(registry)
  const issues: ConfigIssue[] = []
  const check = (field: string, result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) => {
    if (!result.success) for (const issue of result.error!.issues) issues.push({ field: [field, ...issue.path].join('.'), message: issue.message })
  }
  if (registry.upgrade !== undefined) check('upgrade', upgradeSchema.safeParse(registry.upgrade))
  if (registry.compatibleProviders !== undefined) check('compatibleProviders', compatibleProvidersSchema.safeParse(registry.compatibleProviders))
  if (registry.embeddingService !== undefined) check('embeddingService', embeddingServiceSchema.safeParse(registry.embeddingService))
  if (registry.modelExecution !== undefined) check('modelExecution', modelExecutionSchema.safeParse(registry.modelExecution))
  const organization = registryOrganizationSchema.safeParse(Object.fromEntries(['groups', 'discovery'].filter(key => key in registry).map(key => [key, registry[key as keyof Registry]])))
  check('registry', organization)
  if (organization.success && organization.data.discovery) registry = { ...registry, discovery: organization.data.discovery }
  const groups = new Set<string>()
  for (const group of registry.groups ?? []) {
    if (groups.has(group.id)) issues.push({ field: 'groups', message: '分组标识不能重复。' })
    groups.add(group.id)
  }
  const ids = new Set<string>()
  const paths = new Set<string>()
  const remoteIds = new Set<string>()
  for (const library of registry.libraries) {
    const field = `libraries.${library.id}`
    check(field, libraryOrganizationSchema.safeParse(Object.fromEntries(Object.keys(libraryOrganizationSchema.shape).filter(key => key in library).map(key => [key, library[key as keyof LibraryRegistration]]))))
    if (library.groupId && !groups.has(library.groupId)) issues.push({ field: field + '.groupId', message: '库引用的分组不存在。' })
    if (library.kind === 'siyuan' || library.siyuan) {
      try {
        if (!library.siyuan) throw new Error('请填写思源导出设置。')
        const settings = siyuanSettings(library.siyuan)
        const normalize = (value: string) => value.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
        const workspace = normalize(settings.workspacePath), root = normalize(library.wikiPath)
        if (!/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(library.wikiPath) || root === workspace || root.startsWith(workspace + '/') || root.split('/').includes('..')) throw new Error('思源库目录必须在思源工作空间之外。')
        if (library.kind !== 'siyuan' || library.sourceRoots.length || library.mode === 'shared') throw new Error('思源导出库使用 siyuan 登记，不设置本地资料目录或共管模式。')
      } catch (error) { issues.push({ field: field + '.siyuan', message: (error as Error).message }) }
    }
    if (library.layered) try { layeredSettings(library.layered) } catch (error) { issues.push({ field: field + '.layered', message: (error as Error).message }) }
    if (library.queryUnderstanding) try { queryUnderstandingSettings(library.queryUnderstanding) } catch (error) { issues.push({ field: field + '.queryUnderstanding', message: (error as Error).message }) }
    if (!/^[a-zA-Z0-9_-]{1,100}$/.test(library.id) || ids.has(library.id)) issues.push({ field, message: '数据库标识无效或重复。' })
    ids.add(library.id)
    if (!library.name.trim()) issues.push({ field: field + '.name', message: '请填写数据库名称。' })
    if (library.kind === 'whalefall') {
      if (!library.kbId.trim()) issues.push({ field: field + '.kbId', message: '请通过选择器选择思源 Wiki。' })
      if (remoteIds.has(library.kbId)) issues.push({ field: field + '.kbId', message: '同一个思源 Wiki 不能重复登记。' })
      remoteIds.add(library.kbId)
      if (library.mode !== 'readonly' || library.wikiPath || library.sourceRoots.length) issues.push({ field, message: 'whalefall 只查询已有 Wiki，不设置本地输出或资料目录。' })
    } else {
      if (!library.wikiPath.trim()) issues.push({ field: field + '.wikiPath', message: '请填写 Wiki 的绝对路径。' })
      else if (!/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(library.wikiPath)) issues.push({ field: field + '.wikiPath', message: '请填写 Wiki 的绝对路径；路径前后不能有空格或不可见字符。' })
      if (library.sourceRoots.some(root => !/^(?:[a-zA-Z]:[\\/]|\\\\|\/)/.test(root))) issues.push({ field: field + '.sourceRoots', message: '原始资料目录须为绝对路径；路径前后不能有空格或不可见字符。' })
      const key = library.wikiPath.replaceAll('\\', '/').replace(/\/+$/, '').toLowerCase()
      if (paths.has(key)) issues.push({ field: field + '.wikiPath', message: '同一个 Wiki 目录不能重复登记。' })
      paths.add(key)
      if (library.kind === 'local' && library.mode === 'shared') issues.push({ field, message: '共管模式用于现有 Obsidian Wiki。' })
      if (library.kind === 'obsidian' && library.mode === 'managed') issues.push({ field, message: 'Obsidian Wiki 请选择只读或共同管理。' })
    }
    for (const task of ['unified', 'ingest', 'query', 'lint', 'vision'] as const) {
      const route = library.models[task]
      if (Boolean(route.provider.trim()) !== Boolean(route.model.trim())) issues.push({ field: field + '.models.' + task, message: '供应商与模型必须成对选择。' })
    }
    library.models.fallbacks.forEach((route, index) => {
      if (!route.provider.trim() || !route.model.trim()) issues.push({ field: field + '.models.fallbacks.' + index, message: '备用配置必须选择供应商和模型。' })
    })
    for (const [provider, profile] of Object.entries(library.models.providerProfiles ?? {})) {
      if (!provider.trim() || !Number.isInteger(profile.concurrency) || profile.concurrency < 1 || profile.concurrency > 1000
        || !Number.isInteger(profile.retryLimit) || profile.retryLimit < 0 || profile.retryLimit > 10
        || !Number.isInteger(profile.backoffMs) || profile.backoffMs < 0
        || profile.requestsPerMinute !== undefined && (!Number.isInteger(profile.requestsPerMinute) || profile.requestsPerMinute < 1)
        || profile.tokensPerMinute !== undefined && (!Number.isInteger(profile.tokensPerMinute) || profile.tokensPerMinute < 1)
        || !['automatic-prefix', 'none'].includes(profile.cacheMode)) issues.push({ field: field + '.models.providerProfiles.' + provider, message: '供应商档案无效。' })
    }
    for (const [task, route] of Object.entries(library.models.layeredRoutes ?? {})) {
      if (!route) continue
      if (route.route && (Boolean(route.route.provider.trim()) !== Boolean(route.route.model.trim()))) issues.push({ field: field + '.models.layeredRoutes.' + task, message: '阶段供应商与模型必须成对选择。' })
      if (route.reasoningEffort !== undefined && !route.reasoningEffort.trim()) issues.push({ field: field + '.models.layeredRoutes.' + task, message: '推理深度不能为空。' })
    }
  }
  if (registry.activeLibraryId && !ids.has(registry.activeLibraryId)) issues.push({ field: 'activeLibraryId', message: '当前数据库已不存在，请重新选择。' })
  if (!Number.isInteger(registry.readMaxChars) || registry.readMaxChars < 200 || registry.readMaxChars > 100000) issues.push({ field: 'readMaxChars', message: '读取上限应为 200～100000 的整数。' })
  if (issues.length) throw Object.assign(new Error(issues.map(issue => issue.message).join('\n')), { issues })
  return registry
}
export function validateRegistry(registry: Registry): ConfigIssue[] {
  try { parseRegistry(registry); return [] }
  catch (error) {
    if (error instanceof Error && 'issues' in error) return error.issues as ConfigIssue[]
    return [{ field: 'registry', message: '配置格式不正确。' }]
  }
}
