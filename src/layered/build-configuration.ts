import type { LayeredSettings } from '../domain/config.js'
import { hash } from './files.js'

/** 已发布内容的复用依据不包含设备、服务地址、调度预算或模型路由。 */
export function buildConfiguration(settings: LayeredSettings): string {
  const runtime = new Set(['embeddingMode', 'embeddingUnavailable', 'embeddingChangeToken', 'localEmbeddingUrl', 'localEmbeddingModel',
    'cloudEmbeddingUrl', 'cloudEmbeddingModel', 'cloudEmbeddingKeyEnv', 'embeddingConcurrency', 'embeddingBatchSize', 'embeddingBatchBytes', 'embeddingTimeoutMs',
    'queryEmbeddingTimeoutMs', 'queryEmbeddingColdTimeoutMs',
    'vectorPrecision', 'writerTakeoverToken', 'maxBuildCalls', 'maxBuildTokens', 'maxBatchItems'])
  return hash(JSON.stringify(Object.entries(settings).filter(([key]) => !runtime.has(key)).sort(([a], [b]) => a.localeCompare(b))))
}
