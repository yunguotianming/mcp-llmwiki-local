import type { ModelClient } from '../llm/client.js'
import type { LayeredSettings, ModelRef } from '../domain/config.js'
import type { SiyuanAdapter } from './siyuan.js'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'

export const formatVersion = 2
export function locatorRange(locator: string): [number, number] {
  const match = /^L([1-9]\d*)-L([1-9]\d*)$/.exec(locator)
  if (!match || Number(match[1]) > Number(match[2])) throw new Error('证据定位无效：' + locator)
  return [Number(match[1]), Number(match[2])]
}
export const topicPath = (id: string): string => {
  const parts = id.split('-'), ancestors: string[] = []
  for (let length = 2; length < parts.length; length++) ancestors.push(parts.slice(0, length).join('-'))
  return ['topics', ...ancestors, id + '.md'].join('/')
}
export const sections = ['主要发现', '对象与条件', '方法', '限制', '证据位置'] as const
export type Credibility = 'high' | 'medium' | 'low' | 'unknown'
export interface Processing { tier: number; granularity?: import('../domain/granularity.js').Granularity; prompt_version: string; prompt_hash?: string; model?: string; image_policy?: 'images' }
export interface Segment { locator: string; text_hash: string; start: number; end: number }
export interface SourceMetadata {
  title: string; source_type: string; credibility: Credibility; credibility_reason: string
  source_date: string; source_date_basis: '原文日期' | '文件时间'
}
export interface Evidence { source_id: string; source_version: string; locator: string; quote: string }
export interface Point {
  models?: ModelRef[]
  verification?: { status: 'verified' | 'unverified'; missing: string; fingerprint: string; retry_attempted?: boolean; models?: ModelRef[] }
  point_id: string; text_hash: string; locator: string; source_version: string; text: string
  evidence: Evidence[]; section: typeof sections[number]
}
export interface Term { models?: ModelRef[]; referent?: string | undefined; name: string; category: string; aliases: string[]; locator: string; note: string | null }
export interface ExtractionRejection { rule: string; expected: string; actual: string }
export interface ExtractionGap { kind: 'point' | 'term' | 'group' | 'summary' | 'unverified_claim'; retryable?: boolean; segment_hashes: string[]; item: unknown; reasons: ExtractionRejection[] }
export interface SourceChapter { id: string; title: string; depth: number; parent_id: string | null; paragraph_ids: number[]; quota: number }
export interface SourceSummary { models?: ModelRef[]; id: string; point_ids: string[]; missing: string[]; level: number; children: string[]; fingerprint: string }
export interface TagStatus { message?: '标签不足'; count: number; minimum: number; personal_information_removed: number }
export interface Extraction {
  models?: ModelRef[]
  correction_attempts?: Record<string, { structure?: number; semantic?: number }>
  correction_batches?: { structure?: number; semantic?: number }
  review_policy?: string
  overview_limits?: { chinese: number; english: number }
  tag_version?: number; tags?: string[]
  tag_candidates?: string[]; tag_status?: TagStatus
  format_version: number; source_id: string; source_hash: string; processing: Processing
  metadata: SourceMetadata; calls: { input_bytes: number; input_limit: number }[]
  in_progress?: boolean; completed_chunks?: string[]; actual_model?: string
  chunk_results?: Record<string, {
    raw: string; quota: number; completed_items: string[]; correction_batches?: number; coverage_outputs?: Record<string, string>
    models?: ModelRef[]; initial_models?: ModelRef[]; item_models?: Record<string, ModelRef[]>; coverage_models?: Record<string, ModelRef[]>
  }>
  chunk_plan?: { paragraph_id: number; locator: string; text_hash: string; text: string }[][]
  pending_chunk_plan?: NonNullable<Extraction['chunk_plan']>
  plan_config_fingerprint?: string
  plan_book?: boolean; plan_longdoc?: boolean; plan_hard_limit?: number; plan_quotas?: number[]
  grouping_fingerprint?: string
  chunk_calls?: Record<string, Extraction['calls']>
  chunk_quotas?: Record<string, number>
  chunk_splits?: Record<string, string[]>
  truncations?: { chunk: string; count: number }[]
  gaps?: ExtractionGap[]
  point_limit?: number; chapters?: SourceChapter[]
  group_cache?: Record<string, {
    parts: NonNullable<Extraction['chunk_plan']>[number]; raw: string; quota: number; selected_quota?: number
    gaps?: ExtractionGap[]; missing_summary?: boolean; point_indices?: number[]
    models?: ModelRef[]; summary_models?: ModelRef[]; item_models?: Record<string, ModelRef[]>
  }>
  group_summaries?: Record<string, SourceSummary>
  summary_nodes?: Record<string, SourceSummary>; summary?: SourceSummary
  summary_calls?: Extraction['calls']; summary_pending?: string[]
  segments: (Segment & { resource_hashes: string[]; processing_fingerprint: string; points: Point[]; terms: Term[] })[]
}
export interface SourceEntry {
  models?: ModelRef[]
  pending_topic_points?: string[]
  created_at?: string; tags?: string[]
  tag_status?: TagStatus
  logical_source_id?: string
  source_id: string; origin_type: 'local' | 'siyuan'; current_path: string; alias_paths?: string[]; previous_paths: string[]
  content_hash: string; source_version: string; resource_version: string[]; segments: Segment[]
  metadata: SourceMetadata; files: { source: string; assets: { original_path: string; hash: string; path: string }[] }
  extract: { path: string; processing: Processing; processing_fingerprint: string }
  revocation_generation: number; updated_at: string
  siyuan?: { updated: string; raw_hash: string; references_hash: string; input: string; objects: { path: string; hash: string }[]; workspace_id: string; dependencies: string[]
    source_refs: { locator: string; target: { backend: 'siyuan'; workspace_id: string; document_id: string; block_id: string }; revision?: unknown }[] }
}
export interface TagMerges { models?: ModelRef[]; checked: string[]; groups: { canonical: string; tags: string[] }[] }
export interface SnapshotManifest {
  build_configuration?: string
  vector_state?: LibraryVectorState
  point_labels?: Record<string, PointLabels>
  point_label_gaps?: { source_id: string; point_ids: string[]; message: string }[]
  tag_merge_gap?: { tags: string[]; message: string }
  tag_merges?: TagMerges
  anchor_format?: 'obsidian-block-v1'
  page_created?: Record<string, string>
  tag_policy?: { limit: number; only: boolean; vocabulary: string[] }
  format_version: number; version: string | null; next_source_number: number
  revocation_generation: number; sources: SourceEntry[]
  next_term_number?: number
  topic_sequence?: { root: number; children: Record<string, number> }
  gaps?: { source_id: string; status: string; message: string }[]
  topic_gaps?: { topic_id: string; point_ids: string[]; message: string; reasons?: TopicCorrectionReason[] }[]
  term_gaps?: { term_id: string; section_id: string; message: string }[]
  pages?: Record<string, string>
  deps?: Dependencies
  aliases?: Record<string, string>
  topics?: TopicState
  card?: LibraryCard
  log?: string
  cost_report?: string
  rebuild_pages?: string[]
}
export interface LibraryCard {
  name: string; domain: string; origin_type: 'local' | 'siyuan'; source_type: string
  default_credibility: Credibility; source_count: number; updated_at: string; format_version: number
}
export interface CurrentVersion { version: string; revocation_generation: number; history?: string[] }
// queuedAt 供观测包装器区分闸门排队与模型执行，普通嵌入实现可以忽略。
export interface EmbeddingClient { embed(input: string[], signal?: AbortSignal, queuedAt?: number): Promise<number[][]>; identity?(signal?: AbortSignal): Promise<string> }
export interface EmbeddingIdentity {
  provider: 'ollama' | 'cloud' | 'lexical'; service_url?: string; model: string; revision: string; dimensions: number; precision: 'float32' | 'float16'
  document_preprocessing: string; query_preprocessing: string
}
export interface LibraryVectorState {
  mode: 'ollama' | 'cloud' | 'none' | 'unresolved' | 'unselected'; identity?: EmbeddingIdentity; generation: number
  selection: { mode: LayeredSettings['embeddingMode']; model: string; service_url?: string; precision: LayeredSettings['vectorPrecision']; token?: string }
  coverage: { embedded: string[]; missing: string[] }; pending_points: string[]
  page_vectors?: Record<string, { vectors: { vector_id: string; input_hash: string }[] }>
  message?: string
}
export interface PointLabels {
  fingerprint: string; labels: string[]; keywords: string[]; model: string
  keyword_truncation?: { received: number; retained: number }
}
export interface PointDependency { point_id: string; text_hash: string }
export interface TopicCorrectionReason { sentence_id: string; text: string; reason: '证据不完整' | '改变原主张' }
export interface PageDependencies {
  models?: ModelRef[]
  review?: { fingerprint: string; removed: string[]; reasons?: TopicCorrectionReason[]; models?: ModelRef[]; aliases?: string[]; metadata_members?: string[] }
  sources: string[]; points: PointDependency[]; children?: { page: string; version: string }[]
  calls?: { input_bytes: number; input_limit: number; kind?: 'member-block' | 'member-merge' | 'parent-block' | 'parent-merge' }[]; revisions?: number
  terms?: TermRecord[]
}
export interface Dependencies {
  pages: Record<string, PageDependencies>; reverse: Record<string, string[]>; reverse_sources?: Record<string, string[]>
}
export interface Topic {
  models?: ModelRef[]
  aliases?: string[]
  id: string; parent_id: string | null; path: string; title: string; summary: string
  centroid: number[]; sources: string[]; point_ids: string[]; revisions: number
  archived?: boolean; direct_point_ids?: string[]
}
export interface TopicState {
  excluded_members?: Record<string, Record<string, { content_hash: string; reason: string }>>
  format_version: number; version: string | null; next_topic_number: number
  embedding: { url: string; model: string; precision?: 'float32' | 'float16'; identity?: EmbeddingIdentity }; topics: Topic[]
  vectors: Record<string, { input_hash: string; vector: number[]; vector_id?: string }>
  next_children?: Record<string, number>
  candidates?: string[][]
  logical_sources?: Record<string, string>
  clustering_fingerprint?: string
}
export interface TopicBuild {
  fingerprint: string; state: TopicState; pages: Record<string, { content: string; dependencies: PageDependencies; input_fingerprint?: string }>
  configuration_fingerprint?: string; point_hashes?: Record<string, string>
  split_identity?: { root: number; children: Record<string, number>; points: string[] }
  gaps?: NonNullable<SnapshotManifest['topic_gaps']>
  retry_topics?: Topic[]
  rewritten: string[]; model_calls: number
  aliases?: Record<string, string>
}
export interface TermContribution {
  models?: ModelRef[]
  referent?: string | undefined
  logical_source_id?: string
  key: string; source_id: string; source_version: string; text_hash: string; locator: string
  note: string | null; name: string; category: string; aliases: string[]; point_ids: string[]; vector: number[]
  embedding?: string
  vector_id?: string
}
export interface TermSection {
  models?: ModelRef[]
  id: string; topic_id: string; keys: string[]; fingerprint: string; content: string; queued: boolean
  calls: { input_bytes: number; input_limit: number }[]
}
export interface TermRecord { models?: ModelRef[]; id: string; name: string; category: string; aliases: string[]; contributions: TermContribution[]; sections: TermSection[]; split: boolean }
export interface TermBuild {
  gaps?: NonNullable<SnapshotManifest['term_gaps']>
  fingerprint: string; records: TermRecord[]; pages: Record<string, { content: string; dependencies: PageDependencies }>
  section_dependencies: Record<string, PageDependencies>; rewritten: string[]; model_calls: number
}
export interface Revocation { source_id: string; current_path: string; alias_paths?: string[]; reason: string; revoked_at: string; generation: number; deleted?: boolean }
export interface Revocations { generation: number; sources: Revocation[] }
export interface PendingBuild {
  deleted_sources?: string[]
  preview_context?: { registrationKey: string; policyRevision: string }
  format_version: number; base_version: string | null; version: string | null
  manifest: SnapshotManifest; card: LibraryCard; added: string[]; model_calls: number; started_at: string
  topics?: TopicBuild
  terms?: TermBuild
  costs?: CostReport
  paused?: { reason: 'budget' | 'embedding'; message: string; at: string }
  budget_estimated_tokens?: number
  changes?: Record<string, string[]>
  source_ids?: Record<string, string>
}
export interface StageCost {
  initial_calls?: number
  queue_ms?: number; execution_ms?: number; max_sync_ms?: number
  wall_ms?: number; peak_concurrency?: number; corrections?: number; correction_reasons?: Record<string, number>
  logical_tasks: number; actual_calls: number; input_tokens: number; cache_tokens: number; output_tokens: number
  duration_ms: number; unreported_calls: number
}
export interface CostReport {
  correction_rates?: Record<string, { calls: number; corrections: number; rate: number; limit: number; minimum_calls: number }>
  started_at: string; stages: Record<string, StageCost>; tasks: string[]
  first_extractions?: Record<string, { source_id: string; status: 'pending' | 'passed' | 'failed' }>
}
export interface BuildLayeredOptions {
  /** 调用方传入模型路由及生成参数；只参与任务回执摘要，不改变已发布提取的身份。 */
  taskModelIdentity?: unknown
  /** 明确选择同一资料根下的模型库；省略时兼容旧库，否则按模型生成目录名。 */
  wikiPath?: string
  reextract?: 'all' | string[] | undefined
  /** 用户显式重试已发布的提取与补标缺口；传输错误产生的组级缺口在普通建库及续跑时也会自动重试。 */
  retryGaps?: boolean
  /** 已在本次写入探针核对的身份；不参与来源提取指纹。 */
  vectorIdentity?: EmbeddingIdentity
  vectorDeferred?: boolean
  vocabulary?: { tags: string[]; terms: Pick<Term, 'name' | 'aliases' | 'referent'>[] }
  tagVocabulary?: string[]
  /** 本地预览只封存版本；确认后再激活。 */
  publish?: boolean
  previewContext?: { registrationKey: string; policyRevision: string }
  legacyLibraryAction?: 'backup'
  siyuan?: SiyuanAdapter
  knowledgeRoot: string; client: Pick<ModelClient, 'call' | 'info'> & Partial<Pick<ModelClient, 'inputBudget' | 'attempts' | 'concurrency'>>
  name?: string; domain?: string; sourceType?: string; defaultCredibility?: Credibility
  tier?: number; granularity?: import('../domain/granularity.js').Granularity; promptVersion?: string; maxInputBytes?: number; signal?: AbortSignal
  topics?: false | Partial<LayeredSettings>; embeddingClient?: EmbeddingClient
  imagePolicy?: 'text-only' | 'images'
  loadImage?: (bytes: Buffer, name: string, signal?: AbortSignal) => Promise<ImageBlock>
}
