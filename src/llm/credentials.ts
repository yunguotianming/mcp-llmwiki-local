import { createHash } from 'node:crypto'
import type { EmbeddingServiceConfig } from '../domain/route-schema.js'

/** 凭据仅在本机内存中解析，异常不携带原输入或环境变量值。 */
export function resolveCredential(config: { apiKey?: string | undefined; apiKeyEnv?: string | undefined }, env: NodeJS.ProcessEnv = process.env): string {
  const key = (config.apiKey ?? (config.apiKeyEnv ? env[config.apiKeyEnv] : '') ?? '').trim()
  if (config.apiKeyEnv && !key || key && !/^[\x21-\x7e]+$/.test(key)) throw new Error('模型密钥未设置或格式无效。')
  return key
}

function secretRedactor(secrets: readonly string[], replacement: string) {
  // JSON 每次编码都会增加引号和反斜杠前的转义；统一匹配转义串，不枚举编码层数。
  const patterns = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length).map(key => new RegExp(Array.from(key, char =>
    char === '\\' ? String.raw`\\+` : char === '"' ? String.raw`\\*"` : char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join(''), 'g'))
  const text = (value: string): string => {
    try {
      const parsed: unknown = JSON.parse(value)
      if (parsed !== null && typeof parsed === 'object' || typeof parsed === 'string') {
        const safe = walk(parsed, true)
        return JSON.stringify(safe) === JSON.stringify(parsed) ? value : JSON.stringify(safe)
      }
    } catch { /* 自由文本直接遮蔽；不是 JSON 的正文不按结构改写。 */ }
    for (const pattern of patterns) value = value.replace(pattern, replacement)
    return value
  }
  const walk = (value: unknown, redactKeys = false): unknown => {
    if (typeof value === 'string') return text(value)
    if (Array.isArray(value)) return value.map(item => walk(item, redactKeys))
    // 字符串内的 JSON 是不可信文本，键名也须遮蔽；真实协议对象保留字段名。
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactKeys ? text(key) : key, walk(item, redactKeys)]))
    return value
  }
  return { text, walk }
}
export function redactSecrets(text: string, secrets: readonly string[], replacement = '[已脱敏]'): string {
  return secretRedactor(secrets, replacement).text(text)
}
/** 只遮蔽数据中的字符串，保留协议字段名、数字与布尔类型。 */
export function redactValue<T>(value: T, secrets: readonly string[], replacement = '[已脱敏]'): T {
  return secretRedactor(secrets, replacement).walk(value) as T
}

// 向量仍沿用原凭据引用、身份、缓存与重试，只增加本机引用解析。
const embeddingKeys = new Map<string, string>()
const embeddingEndpoints = new Map<string, string>()
const embeddingEndpointKey = (url: string, model: string) => JSON.stringify([url.replace(/\/+$/, ''), model])
export function bindEmbeddingCredential(config: EmbeddingServiceConfig, env?: NodeJS.ProcessEnv): string {
  const ref = 'LLMWIKI_EMBEDDING_' + createHash('sha256').update(JSON.stringify([config.baseUrl, config.model])).digest('hex').slice(0, 24).toUpperCase()
  embeddingKeys.set(ref, resolveCredential(config, env))
  embeddingEndpoints.set(embeddingEndpointKey(config.baseUrl, config.model), ref)
  return ref
}
export function embeddingCredential(ref: string, url?: string, model?: string): string | undefined {
  const bound = url && model ? embeddingEndpoints.get(embeddingEndpointKey(url, model)) : undefined
  return embeddingKeys.get(bound ?? ref) ?? process.env[ref]
}
