import { z } from 'zod'
import { sections } from './schema.js'
import type { Extraction } from './schema.js'
import { abortable } from '../llm/client.js'
import path from 'node:path'
import { hash, hashName, writeJson, withRevocationLock } from './files.js'
import { readOptional } from '../storage/files.js'
import { safePath } from '../storage/paths.js'
import { resolveLibraryRoot } from '../storage/library-root.js'
import type { BuildLayeredOptions } from './schema.js'
import type { LayeredModelTask } from '../domain/config.js'

const inFlight = new Map<string, { controller: AbortController; promise: Promise<unknown>; subscribers: number }>()
// 同键并发合并为一次；订阅者单独取消，最后一个离开才取消底层调用。
export async function shareExtraction<T>(key: string, signal: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
  signal?.throwIfAborted()
  let flight = inFlight.get(key)
  if (!flight) {
    const controller = new AbortController()
    flight = { controller, promise: Promise.resolve().then(() => work(controller.signal)), subscribers: 0 }
    inFlight.set(key, flight)
    const current = flight
    void flight.promise.finally(() => { if (inFlight.get(key) === current) inFlight.delete(key) }).catch(() => {})
  }
  flight.subscribers++
  const current = flight
  let released = false
  const release = () => {
    if (released) return
    released = true; current.subscribers--
    if (!current.subscribers && signal?.aborted) current.controller.abort(signal.reason)
  }
  signal?.addEventListener('abort', release, { once: true })
  try {
    const value = await (signal ? abortable(flight.promise, signal) : flight.promise)
    // 最后一个订阅者可取得原对象；其余订阅者已有副本，普通单调用不额外复制整篇缓存。
    return (current.subscribers === 1 ? value : structuredClone(value)) as T
  }
  finally {
    signal?.removeEventListener('abort', release); release()
    if (!flight.subscribers && flight.controller.signal.aborted) {
      // 在途写入和取消检查点结束后再交还建库锁。
      await flight.promise.catch(() => {})
    }
  }
}

export const taskReceiptProtocol = 'validated-tasks-v1'
// 回执只保存调用方已完成全部业务校验的结果；请求身份只落摘要，模型配置不会写入缓存。
export async function validatedTask<T>(options: BuildLayeredOptions, operation: LayeredModelTask, identity: unknown,
  work: (signal: AbortSignal) => Promise<T>, valid: (value: T) => boolean): Promise<{ value: T; reused: boolean }> {
  if (!path.isAbsolute(options.knowledgeRoot)) return { value: await work(options.signal ?? new AbortController().signal), reused: false }
  const root = options.siyuan ? options.knowledgeRoot : await resolveLibraryRoot(options.knowledgeRoot, options.wikiPath,
    options.topics === false ? { embeddingMode: 'none' } : options.topics ?? {})
  const generation = async () => (await readOptional<{ generation: number }>(await safePath(root, 'state/revocations.json')))?.generation ?? 0
  const epoch = await generation()
  const model = await options.client.info('ingest', options.signal, undefined, operation)
  const key = hash(JSON.stringify([taskReceiptProtocol, operation, model, options.taskModelIdentity, options.promptVersion,
    options.tier, options.topics, options.previewContext, epoch, identity]))
  const file = 'cache/tasks/' + hashName(key) + '.json'
  return shareExtraction(path.resolve(root) + '\0receipt\0' + key, options.signal, async signal => {
    type Receipt = { key: string; digest: string; value: T }
    let stored: Receipt | undefined
    try { stored = await readOptional<Receipt>(await safePath(root, file)) }
    catch (error) { if (!(error instanceof SyntaxError)) throw error }
    const checked = (value: T) => { try { return valid(value) } catch { return false } }
    if (stored?.key === key && hash(JSON.stringify(stored.value)) === stored.digest && checked(stored.value) && await generation() === epoch) return { value: stored.value, reused: true }
    signal.throwIfAborted()
    const result = await work(signal)
    signal.throwIfAborted()
    if (checked(result)) await withRevocationLock(root, async () => {
      signal.throwIfAborted()
      if (await generation() === epoch) await writeJson(root, file, { key, digest: hash(JSON.stringify(result)), value: result })
    })
    // 在途订阅者共享本轮执行的状态，不能把等待同一任务误判为磁盘回执复用。
    return { value: result, reused: false }
  })
}

const strings = z.array(z.string())
const count = z.number().int().nonnegative()
const models = z.array(z.object({ provider: z.string().min(1), model: z.string().min(1) }))
const call = z.object({ input_bytes: count, input_limit: count })
const part = z.object({ paragraph_id: count, locator: z.string(), text_hash: z.string(), text: z.string() })
const gap = z.object({ kind: z.enum(['point', 'term', 'group', 'summary', 'unverified_claim']), segment_hashes: strings, item: z.unknown(),
  reasons: z.array(z.object({ rule: z.string(), expected: z.string(), actual: z.string() })) })
const summary = z.object({ models: models.optional(), id: z.string(), point_ids: strings, missing: strings, level: count, children: strings, fingerprint: z.string() })
const record = <T extends z.ZodType>(schema: T) => z.record(z.string(), schema)
const status = z.object({ message: z.literal('标签不足').optional(), count, minimum: count, personal_information_removed: count })
const cacheSchema = z.object({
  models: models.optional(),
  correction_attempts: record(z.object({ structure: count.optional(), semantic: count.optional() })).optional(),
  review_policy: z.string().optional(), overview_limits: z.object({ chinese: count, english: count }).optional(),
  format_version: z.literal(1), tag_version: z.literal(1), tags: z.array(z.string().trim().min(1)).max(8),
  tag_candidates: strings.optional(), tag_status: status.optional(), source_id: z.string(), source_hash: z.string(),
  processing: z.object({ tier: z.number(), granularity: z.enum(['fine', 'standard', 'coarse', 'minimal', 'custom']).optional(), prompt_version: z.string(), prompt_hash: z.string().optional(), model: z.string().optional(), image_policy: z.literal('images').optional() }),
  metadata: z.object({ title: z.string(), source_type: z.string(), credibility: z.enum(['high', 'medium', 'low', 'unknown']),
    credibility_reason: z.string(), source_date: z.string(), source_date_basis: z.enum(['原文日期', '文件时间']) }),
  calls: z.array(call), in_progress: z.boolean().optional(), completed_chunks: strings.optional(), actual_model: z.string().optional(),
  chunk_results: record(z.object({ raw: z.string(), quota: count, completed_items: strings, correction_batches: count.max(2).optional(), coverage_outputs: record(z.string()).optional(),
    models: models.optional(), initial_models: models.optional(), item_models: record(models).optional(), coverage_models: record(models).optional() })).optional(),
  chunk_plan: z.array(z.array(part)).optional(), grouping_fingerprint: z.string().optional(),
  pending_chunk_plan: z.array(z.array(part)).optional(), plan_config_fingerprint: z.string().optional(),
  plan_book: z.boolean().optional(), plan_longdoc: z.boolean().optional(), plan_hard_limit: count.optional(), plan_quotas: z.array(count).optional(),
  chunk_calls: record(z.array(call)).optional(), chunk_quotas: record(count).optional(), chunk_splits: record(strings).optional(),
  truncations: z.array(z.object({ chunk: z.string(), count })).optional(), gaps: z.array(gap).optional(), point_limit: count.optional(),
  chapters: z.array(z.object({ id: z.string(), title: z.string(), depth: count, parent_id: z.string().nullable(), paragraph_ids: z.array(count), quota: count })).optional(),
  group_cache: record(z.object({ parts: z.array(part), raw: z.string(), quota: count, selected_quota: count.optional(),
    gaps: z.array(gap).optional(), missing_summary: z.boolean().optional(), point_indices: z.array(count).optional(),
    models: models.optional(), summary_models: models.optional(), item_models: record(models).optional() })).optional(),
  group_summaries: record(summary).optional(), summary_nodes: record(summary).optional(), summary: summary.optional(),
  summary_calls: z.array(call).optional(), summary_pending: strings.optional(),
  segments: z.array(z.object({ locator: z.string(), text_hash: z.string(), start: count, end: count, resource_hashes: strings,
    processing_fingerprint: z.string(),
    points: z.array(z.object({ models: models.optional(), verification: z.object({ status: z.enum(['verified', 'unverified']), missing: z.string(), fingerprint: z.string(), retry_attempted: z.boolean().optional(), models: models.optional() }).optional(), point_id: z.string(), text_hash: z.string(), locator: z.string(), source_version: z.string(),
      text: z.string().min(1), section: z.enum(sections), evidence: z.array(z.object({ source_id: z.string(), source_version: z.string(), locator: z.string(), quote: z.string().min(1) })).min(1) })),
    terms: z.array(z.object({ models: models.optional(), referent: z.string().trim().min(1).optional(), name: z.string(), category: z.string(), aliases: strings, locator: z.string(), note: z.string().nullable() })),
  })),
})

// 各复用入口共用完整结构校验；组内原始 JSON 由提取器的同一输出规则继续校验。
export function validExtractionCache(value: unknown, validRaw: (raw: string, complete: boolean) => boolean): value is Extraction {
  const parsed = cacheSchema.safeParse(value)
  if (!parsed.success) return false
  const result = parsed.data
  if (!result.tags.length && !result.in_progress && result.tag_status?.message !== '标签不足') return false
  return Object.values(result.group_cache ?? {}).every(item => validRaw(item.raw, true))
    && Object.values(result.chunk_results ?? {}).every(item => validRaw(item.raw, false)
      && Object.values(item.coverage_outputs ?? {}).every(raw => validRaw(raw, false)))
}
