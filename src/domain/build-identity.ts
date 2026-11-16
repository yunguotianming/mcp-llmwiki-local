import type { LibraryRegistration } from './config.js'
import type { LibraryPolicy } from './policy.js'
import { signature } from '../storage/files.js'

/** 作业身份只记录内容策略；实际调用路由与运行限额可以在续做时调整。 */
export function buildRegistrationKey(library: LibraryRegistration): string {
  const { models: _models, queryUnderstanding: _queryUnderstanding, layered, groupId: _group, pinned: _pinned, order: _order, summary: _summary,
    publishedVersion: _published, summaryStatus: _summaryStatus, summaryGeneration: _summaryGeneration, ...registration } = library
  const { embeddingConcurrency: _embeddingConcurrency, embeddingTimeoutMs: _timeout, embeddingBatchSize: _batch, embeddingBatchBytes: _bytes,
    queryEmbeddingTimeoutMs: _queryTimeout, queryEmbeddingColdTimeoutMs: _queryColdTimeout, searchRelevanceThreshold: _relevance,
    maxBuildCalls: _calls, maxBuildTokens: _tokens, writerTakeoverToken: _writer, ...content } = layered ?? {}
  return JSON.stringify({ ...registration, layered: content })
}
export function buildPolicyKey(policy: LibraryPolicy): string {
  return signature(JSON.stringify([policy.extractionGranularity, policy.customEntityLimit, policy.customConceptLimit, policy.customPointLimit,
    policy.tagVocabularyMode, policy.customEntityTags, policy.customConceptTags]))
}
