import type { ModelAttempt } from '../llm/client.js'
import { atomicWrite, hash, withRevocationLock, writeJson } from './files.js'
import { readFile, readdir, unlink } from 'node:fs/promises'
import { canonicalJson, protocolDigest, protocolError, readProtocol, writeProtocol, validateAcceptedRecord, sortedUnique, taskPattern, sidecarPath } from './models.js'
import type { AcceptanceRequest, AcceptanceSnapshot, AcceptedRecord, AttemptEntry, AttemptOutcome, AttemptRequest, ExecutionHooks, NormalizedUsage, PriceSnapshot } from './schema.js'
import { readOptional } from '../storage/files.js'
import { safePath } from '../storage/paths.js'
import type { BuildLayeredOptions, CostReport, PendingBuild, StageCost } from './schema.js'
import { layeredSettings } from '../domain/config.js'
import { jsonProtocol, runtimeSchemaRegistry } from '../llm/protocol.js'
import { parseModelJson } from '../llm/json.js'
import type { ModelCallOptions } from '../llm/client.js'
import { taskCallContext } from './extraction-cache.js'
import { topicPath } from './schema.js'
import type { ExecutionCheckpoint } from '../llm/execution.js'

export const emptyStage = (): StageCost => ({ logical_tasks: 0, actual_calls: 0, input_tokens: 0, cache_tokens: 0, output_tokens: 0, duration_ms: 0, unreported_calls: 0,
  wall_ms: 0, peak_concurrency: 0, corrections: 0, correction_reasons: {}, queue_ms: 0, execution_ms: 0 })
export function costReport(started = new Date().toISOString()): CostReport {
  return { started_at: started, stages: Object.fromEntries(['提取', '覆盖补提', '提取后核对', '主题', '主题后核对', '嵌入', '术语', 'lint'].map(stage => [stage, emptyStage()])), tasks: [] }
}
export function addAttempts(stage: StageCost, attempts: ModelAttempt[], elapsed: number, queueMs = 0): void {
  stage.actual_calls += attempts.length || 1
  stage.duration_ms += elapsed + queueMs
  stage.queue_ms = (stage.queue_ms ?? 0) + queueMs + attempts.reduce((sum, attempt) => sum + (attempt.queueMs ?? 0), 0)
  stage.execution_ms = (stage.execution_ms ?? 0) + (attempts.length
    ? attempts.reduce((sum, attempt) => sum + (attempt.executionMs ?? attempt.durationMs), 0) : elapsed)
  stage.unreported_calls += attempts.length ? attempts.filter(attempt => !attempt.usage).length : 1
  for (const { usage } of attempts) {
    stage.input_tokens += usage?.inputTokens ?? 0
    stage.cache_tokens += (usage?.cacheReadTokens ?? 0) + (usage?.cacheWriteTokens ?? 0)
    stage.output_tokens += usage?.outputTokens ?? 0
  }
}
export function costMarkdown(report: CostReport): string {
  const first = Object.values(report.first_extractions ?? {}), passed = first.filter(item => item.status === 'passed').length
  const completed = first.filter(item => item.status !== 'pending').length
  return `首次提取结构通过率：${passed}/${completed}${completed ? '（' + (100 * passed / completed).toFixed(1) + '%）' : '（尚无完整观测）'}；在途 ${first.length - completed}。\n\n`
    + Object.entries(report.correction_rates ?? {}).map(([phase, value]) => `${phase}阶段纠正率：${value.corrections}/${value.calls}（${(value.rate * 100).toFixed(1)}%，上限 ${value.limit} 倍；含阶段核对，非纠正调用基数最低 ${value.minimum_calls}）。\n\n`).join('')
    + '| 阶段 | 逻辑任务数 | 实际调用数 | 输入 Token | 缓存 Token | 输出 Token | 累计耗时 ms | 排队 ms | 执行 ms | 墙钟 ms | 并发峰值 | 纠正次数 | 纠正原因 | 未报告用量调用 |\n| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- | ---: |\n'
    + Object.entries(report.stages).map(([name, s]) => `| ${name} | ${s.logical_tasks} | ${s.actual_calls} | ${s.input_tokens} | ${s.cache_tokens} | ${s.output_tokens} | ${s.duration_ms} | ${s.queue_ms ?? 0} | ${s.execution_ms ?? 0} | ${s.wall_ms ?? 0} | ${s.peak_concurrency ?? 0} | ${s.corrections ?? 0} | ${JSON.stringify(s.correction_reasons ?? {})} | ${s.unreported_calls} |`).join('\n') + '\n'
}
// 尝试明细可以清理，汇总和逻辑任务身份随待更新清单跨中断保留。
export function meteredOptions(root: string, pending: PendingBuild, options: BuildLayeredOptions): BuildLayeredOptions {
  const costs = pending.costs ??= costReport(pending.started_at), client = options.client
  const settings = layeredSettings(options.topics === false ? {} : options.topics, options.tier)
  const phases = { 提取: ['提取', '覆盖补提', '提取后核对'], 主题: ['主题', '主题后核对'] }
  // 旧观测没有首轮计数，首次恢复时固定基数，不能被在途纠正反向扣减。
  for (const stage of Object.values(costs.stages)) stage.initial_calls ??= Math.max(0, stage.actual_calls - (stage.corrections ?? 0))
  const rates = () => {
    costs.correction_rates = Object.fromEntries(Object.entries(phases).map(([phase, names]) => {
      const stages = names.map(name => costs.stages[name] ?? emptyStage())
      const calls = stages.reduce((n, s) => n + (s.initial_calls ?? Math.max(0, s.actual_calls - (s.corrections ?? 0))), 0)
      const corrections = stages.reduce((n, s) => n + (s.corrections ?? 0), 0)
      return [phase, { calls, corrections, rate: corrections / Math.max(1, calls), limit: phase === '提取' ? settings.extractionCorrectionRatio : settings.topicCorrectionRatio, minimum_calls: settings.correctionMinCalls }]
    }))
  }
  rates()
  // 每次显式续跑获得一份运行额度；已完成成本持续累加，重试也必须先预留额度。
  const reservations: { estimate: number; attempt?: ModelAttempt }[] = []
  const counted = new WeakSet<ModelAttempt>(client.attempts ?? [])
  // 按供应商实际尝试区间统计，排队等待不冒充模型并发；续跑不计停机时间。
  const timing = new Map<string, { wall: number; peak: number; intervals: [number, number][] }>()
  const tokenCount = (attempt: ModelAttempt) => attempt.usage
    ? attempt.usage.inputTokens + (attempt.usage.cacheReadTokens ?? 0) + (attempt.usage.cacheWriteTokens ?? 0) + attempt.usage.outputTokens
    : attempt.estimatedInputTokens ?? 0
  const pause = (message: string): never => { throw Object.assign(new Error(message), { budgetPause: true }) }
  const measure = async <T>(stage: string, key: string, action: () => Promise<T>, attempts?: ModelAttempt[], logicalKeys: string[] = [key], signal = options.signal, queuedAt?: number): Promise<T> => {
    const value = costs.stages[stage] ??= emptyStage()
    for (const logicalKey of logicalKeys) {
      const identity = stage + ':' + hash(logicalKey)
      if (!costs.tasks.includes(identity)) { costs.tasks.push(identity); value.logical_tasks++ }
    }
    const start = Date.now()
    const queueMs = queuedAt === undefined ? 0 : Math.max(0, start - queuedAt)
    const clock = timing.get(stage) ?? { wall: value.wall_ms ?? 0, peak: value.peak_concurrency ?? 0, intervals: [] }
    timing.set(stage, clock)
    let budgetPaused = false
    try { return await action() }
    catch (error) {
      if (error && typeof error === 'object' && 'budgetPause' in error) {
        budgetPaused = true
        pending.paused = { reason: 'budget', message: (error as { message?: string }).message ?? '建库预算已到上限。', at: new Date().toISOString() }
      }
      throw error
    }
    finally {
      const recent = attempts ?? []
      if (recent.length || attempts === undefined || !budgetPaused && !signal?.aborted) {
        addAttempts(value, recent, Date.now() - start, queueMs)
        clock.intervals.push(...(recent.length ? recent.map(attempt => {
          const begin = Date.parse(attempt.startedAt)
          return [begin, begin + Math.max(1, attempt.durationMs)] as [number, number]
        }) : [[start, Math.max(start + 1, Date.now())] as [number, number]]))
        const events = clock.intervals.flatMap(([start, end]) => [[start, 1], [end, -1]] as [number, number][])
          .sort((a, b) => a[0] - b[0] || a[1] - b[1])
        let active = 0, last = events[0]?.[0] ?? 0, wall = 0, peak = 0
        for (const [at, delta] of events) { if (active) wall += at - last; active += delta; peak = Math.max(peak, active); last = at }
        value.wall_ms = clock.wall + wall; value.peak_concurrency = Math.max(clock.peak, peak)
      }
      pending.budget_estimated_tokens = (pending.budget_estimated_tokens ?? 0) + recent.filter(attempt => !attempt.usage).reduce((sum, attempt) => sum + (attempt.estimatedInputTokens ?? 0), 0)
      rates()
      await writeJson(root, 'work/pending.json', pending)
      if (budgetPaused) await saveCosts(root, pending, 'paused-' + pending.started_at)
    }
  }
  return { ...options, client: {
    info: client.info.bind(client), ...(client.inputBudget ? { inputBudget: client.inputBudget.bind(client) } : {}), ...(client.attempts ? { attempts: client.attempts } : {}),
    ...(client.concurrency ? { concurrency: client.concurrency.bind(client) } : {}),
    call: async (...args) => {
      if (args[5]?.structuredSchema) args[1] = jsonProtocol(args[1], args[5].structuredSchema.schema)
      const input = JSON.parse(args[2])
      const correction = Boolean(input.validationFeedback || input.correction_stage || input.review_stage?.endsWith('-correction'))
      const stage = input.review_stage?.startsWith('extraction') ? '提取后核对' : input.review_stage?.startsWith('topic') ? '主题后核对'
        : input.coverage ? '覆盖补提'
        : input.label_stage ? '要点补标' : input.new_tags ? '标签归并' : input.summary_id ? '来源摘要' : input.term_id ? '术语' : input.topic_id ? '主题' : '提取'
      if (correction) {
        rates()
        const phase = Object.entries(phases).find(([, names]) => names.includes(stage))?.[0]
        const rate = phase ? costs.correction_rates![phase]! : undefined
        if (rate && rate.corrections + 1 > Math.max(rate.minimum_calls, rate.calls) * rate.limit) {
          const message = `${phase}阶段纠正即将超过首轮调用的 ${rate.limit} 倍（纠正 ${rate.corrections}，首轮 ${rate.calls}，最小基数 ${rate.minimum_calls}，含该阶段核对）；进度已保存。`
          pending.paused = { reason: 'budget', message, at: new Date().toISOString() }
          await writeJson(root, 'work/pending.json', pending)
          pause(message)
        }
        const value = costs.stages[stage] ??= emptyStage()
        value.corrections = (value.corrections ?? 0) + 1
        const reasons = value.correction_reasons ??= {}
        const rules: string[] = input.review_stage ? ['semantic-support'] : input.validationFeedback?.reasons?.map((item: { rule: string }) => item.rule)
          ?? input.items?.flatMap((item: { validationFeedback: { reasons: { rule: string }[] } }) => item.validationFeedback.reasons.map(reason => reason.rule)) ?? ['topic-validation']
        for (const rule of new Set(rules)) reasons[rule] = (reasons[rule] ?? 0) + 1
      } else {
        const value = costs.stages[stage] ??= emptyStage()
        value.initial_calls = (value.initial_calls ?? Math.max(0, value.actual_calls - (value.corrections ?? 0))) + 1
      }
      rates()
      const key = input.term_id ? `${input.term_id}#${input.section_id}` : input.topic_id ?? args[1] + args[2]
      const operation = args[5]?.operation, sourceId = input.source_id ?? input.validationFeedback?.item?.source_id ?? 'extract'
      const logicalKeys = input.term_id ? [`term:${input.term_id}#${input.section_id}`] : input.topic_id ? [`${operation ?? 'topic'}:${input.topic_id}`]
        : input.correction_stage ? [] : (input.paragraphs as { paragraph_id: number }[] | undefined)?.map(item => `extract:${sourceId}:${item.paragraph_id}`) ?? [key]
      const recent: ModelAttempt[] = []
      const unit = input.topic_id ? topicPath(input.topic_id) : input.term_id ? `${input.term_id}/${input.section_id ?? ''}`
        : input.summary_id ? `${sourceId}/summary/${input.summary_id}`
        : input.paragraphs ? `${sourceId}/group/${hash(JSON.stringify(input.paragraphs.map((part: { paragraph_id: number; locator: string }) => [part.paragraph_id, part.locator])))}`
        : String(input.source_id ?? input.label_stage ?? (input.new_tags ? 'tags' : operation ?? 'extract'))
      const context = taskCallContext.getStore()
      const records = costs.calls ??= []
      const previousCall = records.findLast(call => call.unit_id === unit && call.stage === stage)
      const inputFingerprint = hash(JSON.stringify([args[1], args[2], args[5]?.structuredSchema?.schema]))
      const record: NonNullable<CostReport['calls']>[number] = { sequence: records.length + 1,
        logical_task_id: `${stage}:${unit}:${input.review_stage ?? input.synthesis_stage ?? input.correction_stage ?? 'initial'}`,
        unit_id: unit, stage, input_fingerprint: inputFingerprint, receipt_key: context?.receipt_key ?? null,
        invalidation_reason: context?.invalidation_reason ?? options.invalidationReason
          ?? (correction ? '校验纠正' : previousCall ? previousCall.input_fingerprint === inputFingerprint ? '未完成单元续做' : '输入变化' : '缺少成果'),
        status: 'pending', attempts: [] }
      records.push(record)
      const schema = args[5]?.structuredSchema?.schema
      const firstKey = stage === '提取' && !correction && schema ? hash(args[1] + args[2]) : undefined
      const first: NonNullable<CostReport['first_extractions']>[string] | undefined = firstKey && !(costs.first_extractions ??= {})[firstKey]
        ? costs.first_extractions[firstKey] = { source_id: String(sourceId), status: 'pending' } : undefined
      // 先保存首提身份和实时纠正计数；后续恢复只补结果，不用重试覆盖首次观测。
      await writeJson(root, 'work/pending.json', pending)
      return measure(stage, key, async () => {
        const estimate = Math.ceil(Buffer.byteLength(args[1] + args[2]) / 4)
        let reservation: { estimate: number; attempt?: ModelAttempt } | undefined
        const callOptions: ModelCallOptions = { ...args[5], beforeAttempt: () => {
          const tokens = reservations.reduce((sum, item) => sum + (item.attempt ? tokenCount(item.attempt) : item.estimate), 0)
          if (settings.maxBuildCalls !== undefined && reservations.length >= settings.maxBuildCalls) pause(`建库调用次数已达上限 ${settings.maxBuildCalls}，进度已保存，可再次运行续跑。`)
          if (settings.maxBuildTokens !== undefined && tokens + estimate > settings.maxBuildTokens) pause(`建库 Token 预算即将超出上限 ${settings.maxBuildTokens}，进度已保存，可再次运行续跑或调整预算。`)
          args[5]?.beforeAttempt?.()
          reservation = { estimate }; reservations.push(reservation)
        }, onAttempt: attempt => {
          counted.add(attempt)
          recent.push(attempt); if (reservation) reservation.attempt = attempt
          args[5]?.onAttempt?.(attempt)
        } }
        try {
          const raw = await client.call(args[0], args[1], args[2], args[3], args[4], callOptions)
          record.status = 'completed'
          if (first) {
            const validate = runtimeSchemaRegistry().find(item => item.internalSchema === schema)?.validate
            try { first.status = validate?.(parseModelJson(raw, schema)) ? 'passed' : 'failed' }
            catch { first.status = 'failed' }
          }
          return raw
        } catch (error) {
          record.status = 'failed'
          if (first) {
            // 未进入供应商调用的预算暂停或排队取消，不构成首提失败。
            if (!recent.length && error && typeof error === 'object' && ('budgetPause' in error || args[3]?.aborted)) delete costs.first_extractions![firstKey!]
            else first.status = 'failed'
          }
          throw error
        }
        finally {
          // 保持兼容只提供 attempts 的注入客户端。
          if (!recent.length) for (const attempt of client.attempts ?? []) {
            if (attempt.finish === 'pending' || counted.has(attempt)) continue
            counted.add(attempt); recent.push(attempt)
          }
          record.attempts = recent.map(({ route, startedAt, durationMs, finish, usage, error, status }) => ({ route, startedAt, durationMs, finish,
            ...(usage ? { usage } : {}), ...(error ? { error } : {}), ...(status !== undefined ? { status } : {}) }))
        }
      }, recent, logicalKeys, args[3])
    },
  }, ...(options.embeddingClient ? { embeddingClient: {
    get managesEndpoint() { return options.embeddingClient!.managesEndpoint },
    ...(options.embeddingClient.identity ? { identity: options.embeddingClient.identity.bind(options.embeddingClient) } : {}),
    embed: async (input, signal, queuedAt) => {
      const fingerprint = hash(JSON.stringify(input)), records = costs.calls ??= []
      const record: NonNullable<CostReport['calls']>[number] = { sequence: records.length + 1,
        logical_task_id: '嵌入:' + fingerprint, unit_id: 'embedding/' + fingerprint, stage: '嵌入',
        input_fingerprint: fingerprint, receipt_key: null, invalidation_reason: '缺少可复用向量', status: 'pending', attempts: [] }
      records.push(record)
      await writeJson(root, 'work/pending.json', pending)
      return measure('嵌入', JSON.stringify(input), async () => {
        try {
          const result = await options.embeddingClient!.embed(input, signal)
          record.status = 'completed'; return result
        } catch (error) { record.status = 'failed'; throw error }
      }, undefined, undefined, signal, queuedAt)
    } } } : {}) }
}
export async function saveCosts(root: string, pending: PendingBuild, version: string): Promise<void> {
  const reports = await readOptional<Record<string, CostReport>>(await safePath(root, 'logs/costs.json')) ?? {}
  reports[version] = pending.costs ?? costReport(pending.started_at)
  for (const key of Object.keys(reports).slice(0, -2)) delete reports[key]
  await writeJson(root, 'logs/costs.json', reports)
  await atomicWrite(root, 'logs/cost-report.md', '# 建库成本\n\n' + Object.entries(reports).map(([id, report]) => `## ${id} · ${report.started_at}\n\n${costMarkdown(report)}`).join('\n'))
}

export interface LedgerLimits { maxCalls?: number; maxTokens?: number; maxCost?: number; currency?: string; deadlineMs?: number }
interface RunHeader {
  runId: string; nextSequence: number; allocated?: number[]
  archived?: { ids: string[]; costs: RunCosts; scopes: Record<string, number>; perLine?: Record<string, Record<string, number>> }
  spent: { calls: number; tokens: number; costs: Record<string, number> }
  scopes: Record<string, { attempts: number; attemptsPerLine?: Record<string, number>; visitedLines: string[]; deadline: number | null }>
}
export interface CostTotals {
  calls: number; usage: NormalizedUsage; estimatedTokens: number; reservedTokens: number
  unknownUsage: number; unknownPrice: number; costs: Record<string, number>; estimatedCosts: Record<string, number>
}
export interface RunCosts {
  total: CostTotals; groups: { stage: string; lineId: string; model: string; totals: CostTotals }[]
  prices: Record<string, PriceSnapshot>
}
export interface VersionCosts {
  schema: 'llmwiki-costs-v1'; version: string; manifestChecksum: string
  runs: Record<string, RunCosts>; total: CostTotals; groups: RunCosts['groups']; prices: RunCosts['prices']
  legacy: { report: string | null; reason: 'legacy-library' } | null
}
const emptyUsage = (): NormalizedUsage => ({ inputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 })
const emptyTotals = (): CostTotals => ({ calls: 0, usage: emptyUsage(), estimatedTokens: 0, reservedTokens: 0, unknownUsage: 0, unknownPrice: 0, costs: {}, estimatedCosts: {} })
export const usageTokens = (usage: NormalizedUsage): number => Object.values(usage).reduce((sum, value) => sum + value, 0)
export function normalizeUsage(usage: Partial<NormalizedUsage> & { inputTokens: number; outputTokens: number }, inputIncludesCache = false): NormalizedUsage {
  const result = { inputTokens: usage.inputTokens, cacheReadTokens: usage.cacheReadTokens ?? 0, cacheWriteTokens: usage.cacheWriteTokens ?? 0, outputTokens: usage.outputTokens }
  if (inputIncludesCache) result.inputTokens -= result.cacheReadTokens + result.cacheWriteTokens
  if (Object.values(result).some(value => !Number.isSafeInteger(value) || value < 0)) throw new Error('供应商用量口径无效。')
  return result
}
function money(usage: NormalizedUsage, price: PriceSnapshot | null): number | null {
  if (!price) return null
  if (!price.currency || !price.priceRevision || !Number.isFinite(price.unit) || price.unit <= 0
    || [price.input, price.cacheRead, price.cacheWrite, price.output].some(value => !Number.isFinite(value) || value < 0)) throw new Error('价格快照无效。')
  return (usage.inputTokens * price.input + usage.cacheReadTokens * price.cacheRead + usage.cacheWriteTokens * price.cacheWrite + usage.outputTokens * price.output) / price.unit
}
const estimateUsage = (request: AttemptRequest): NormalizedUsage => ({ ...emptyUsage(), inputTokens: request.estimatedInputTokens, outputTokens: request.maxOutputTokens })
function attemptLocation(attemptId: string): { runId: string; sequence: number; file: string } {
  const match = /^a:([a-f0-9-]{36}):([1-9]\d*)$/i.exec(attemptId)
  if (!match || !Number.isSafeInteger(Number(match[2]))) throw new Error('尝试身份无效。')
  return { runId: match[1]!, sequence: Number(match[2]), file: `logs/model-runs/${match[1]}/attempts/${match[2]}.json` }
}
const acceptancePath = (taskId: string): string => {
  if (!taskPattern.test(taskId)) throw new Error('任务身份无效。')
  return `logs/model-accepts/${taskId.slice(2)}.json`
}
async function entries(root: string, runId: string): Promise<AttemptEntry[]> {
  attemptLocation(`a:${runId}:1`)
  const names = await readdir(await safePath(root, `logs/model-runs/${runId}/attempts`)).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  const values: AttemptEntry[] = []
  for (const name of names.filter(name => /^[1-9]\d*\.json$/.test(name)).sort((a, b) => parseInt(a) - parseInt(b))) {
    const value = await readProtocol<AttemptEntry>(root, `logs/model-runs/${runId}/attempts/${name}`, 'MODEL_LEDGER_CORRUPT')
    if (!value || attemptLocation(value.request.attemptId).file !== `logs/model-runs/${runId}/attempts/${name}`) throw protocolError('MODEL_LEDGER_CORRUPT', '尝试账本身份不符。')
    values.push(value)
  }
  return values
}
function addTotals(target: CostTotals, value: CostTotals): void {
  for (const key of ['calls', 'estimatedTokens', 'reservedTokens', 'unknownUsage', 'unknownPrice'] as const) target[key] += value[key]
  for (const key of Object.keys(target.usage) as (keyof NormalizedUsage)[]) target.usage[key] += value.usage[key]
  for (const key of ['costs', 'estimatedCosts'] as const) for (const [currency, amount] of Object.entries(value[key])) target[key][currency] = (target[key][currency] ?? 0) + amount
}
export function summarizeAttempts(values: AttemptEntry[]): RunCosts {
  const total = emptyTotals(), groups = new Map<string, RunCosts['groups'][number]>(), prices: RunCosts['prices'] = {}
  for (const entry of values) {
    if (!entry.dispatchedAt) continue
    const request = entry.request, usage = entry.outcome?.usage, price = request.priceSnapshot, value = emptyTotals()
    value.calls = 1; value.estimatedTokens = usageTokens(estimateUsage(request))
    if (usage) value.usage = normalizeUsage(usage)
    else { value.unknownUsage = 1; value.reservedTokens = value.estimatedTokens }
    if (!price) value.unknownPrice = 1
    else {
      prices[protocolDigest(price)] = price
      value.estimatedCosts[price.currency] = money(estimateUsage(request), price)!
      if (usage) value.costs[price.currency] = money(usage, price)!
    }
    const model = entry.outcome?.model ?? request.candidate.requestedModel
    const key = canonicalJson([request.stage, request.candidate.lineId, model])
    const group = groups.get(key) ?? { stage: request.stage, lineId: request.candidate.lineId, model, totals: emptyTotals() }
    groups.set(key, group); addTotals(group.totals, value); addTotals(total, value)
  }
  return { total, groups: [...groups.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, group]) => group), prices }
}
function combineRunCosts(left: RunCosts, right: RunCosts): RunCosts {
  const result = structuredClone(left)
  addTotals(result.total, right.total); Object.assign(result.prices, right.prices)
  for (const group of right.groups) {
    const prior = result.groups.find(g => g.stage === group.stage && g.lineId === group.lineId && g.model === group.model)
    if (prior) addTotals(prior.totals, group.totals)
    else result.groups.push(structuredClone(group))
  }
  return result
}
/** B4 只调用尝试钩子；B1 独占接受文件的写入。所有更改先落盘后返回。 */
export function createExecutionLedger(root: string, limits: LedgerLimits = {}): ExecutionHooks & ExecutionCheckpoint {
  for (const value of [limits.maxCalls, limits.maxTokens]) if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new Error('调用和 token 上限必须为非负整数。')
  if (limits.maxCost !== undefined && (!Number.isFinite(limits.maxCost) || limits.maxCost < 0)) throw new Error('费用上限无效。')
  const lock = <T>(action: () => Promise<T>) => withRevocationLock(root, action).catch(error => {
    throw Object.assign(error instanceof Error ? error : new Error(String(error)), { storageFailure: true })
  })
  const readAttempt = async (id: string): Promise<AttemptEntry> => {
    const value = await readProtocol<AttemptEntry>(root, attemptLocation(id).file, 'MODEL_LEDGER_CORRUPT')
    if (!value || value.request.attemptId !== id || value.reservationId !== id) throw protocolError('MODEL_LEDGER_MISSING', '尝试记录缺失：' + id)
    return value
  }
  const saveAttempt = async (entry: AttemptEntry) => {
    const { runId, file } = attemptLocation(entry.request.attemptId)
    entry.charge = { currency: entry.request.priceSnapshot?.currency ?? null, amount: entry.outcome?.usage ? money(entry.outcome.usage, entry.request.priceSnapshot) : null,
      estimatedAmount: money(estimateUsage(entry.request), entry.request.priceSnapshot) }
    await writeProtocol(root, file, entry)
    await saveHeader(runId)
  }
  const saveHeader = async (runId: string) => {
    const file = `logs/model-runs/${runId}/run.json`
    const header: RunHeader = await readProtocol<RunHeader>(root, file, 'MODEL_LEDGER_CORRUPT') ?? { runId, nextSequence: 1, spent: { calls: 0, tokens: 0, costs: {} }, scopes: {} }
    const values = await entries(root, runId), totals = (await readRunCosts(root, runId)).total
    header.nextSequence = Math.max(header.nextSequence, ...values.map(value => attemptLocation(value.request.attemptId).sequence + 1))
    header.spent = { calls: totals.calls, tokens: usageTokens(totals.usage) + totals.reservedTokens, costs: totals.costs }
    for (const value of values) {
      const scope = header.scopes[value.request.retryScopeId] ??= { attempts: 0, visitedLines: [], deadline: limits.deadlineMs === undefined ? null : Date.parse(value.reservedAt) + limits.deadlineMs }
      scope.attempts = (header.archived?.scopes[value.request.retryScopeId] ?? 0) + values.filter(v => v.request.retryScopeId === value.request.retryScopeId && v.dispatchedAt && !header.archived?.ids.includes(v.request.attemptId)).length
      scope.attemptsPerLine = { ...header.archived?.perLine?.[value.request.retryScopeId] }
      for (const dispatched of values.filter(v => v.request.retryScopeId === value.request.retryScopeId && v.dispatchedAt && !header.archived?.ids.includes(v.request.attemptId))) {
        const line = dispatched.request.candidate.lineId
        scope.attemptsPerLine[line] = (scope.attemptsPerLine[line] ?? 0) + 1
      }
      if (value.dispatchedAt && !scope.visitedLines.includes(value.request.candidate.lineId)) scope.visitedLines.push(value.request.candidate.lineId)
    }
    await writeProtocol(root, file, header)
  }
  const readAcceptance: ExecutionHooks['readAcceptance'] = async taskId => {
    const file = acceptancePath(taskId)
    const value = await readProtocol<AcceptanceSnapshot>(root, file, 'ACCEPT_PREPARE_CORRUPT')
    if (!value) return { status: 'missing' }
    try {
      validateAcceptedRecord(value.record)
      if (value.taskId !== taskId || value.record.taskId !== taskId || value.prepareId !== protocolDigest({ taskId, outputDigest: value.record.output.digest })
        || !['prepared', 'bound'].includes(value.status) || value.status === 'prepared' && value.acceptedDigest !== null
        || value.status === 'bound' && value.acceptedDigest !== protocolDigest(value.record)
        || !Array.isArray(value.acceptedAttemptIds) || value.responseAttemptId !== null && !value.acceptedAttemptIds.includes(value.responseAttemptId)) throw new Error('准备快照不一致')
    } catch { throw protocolError('ACCEPT_PREPARE_CORRUPT', '接受准备快照损坏：' + taskId) }
    return value
  }
  const hooks: ExecutionHooks & ExecutionCheckpoint = {
    openScope: (runId, retryScopeId, queuedAt, retry) => lock(async () => {
      await saveHeader(runId)
      const file = `logs/model-runs/${runId}/run.json`
      const header = (await readProtocol<RunHeader>(root, file, 'MODEL_LEDGER_CORRUPT'))!
      const scope = header.scopes[retryScopeId] ??= { attempts: 0, attemptsPerLine: {}, visitedLines: [], deadline: queuedAt + retry.deadlineMs }
      scope.deadline ??= queuedAt + retry.deadlineMs
      await writeProtocol(root, file, header)
      return { attempts: scope.attempts, attemptsPerLine: { ...scope.attemptsPerLine }, visitedLines: [...scope.visitedLines], deadlineAt: scope.deadline }
    }),
    allocateAttempt: runId => lock(async () => {
      await saveHeader(runId)
      const file = `logs/model-runs/${runId}/run.json`
      const header = (await readProtocol<RunHeader>(root, file, 'MODEL_LEDGER_CORRUPT'))!, sequence = header.nextSequence++
      ;(header.allocated ??= []).push(sequence)
      await writeProtocol(root, file, header)
      return { attemptId: `a:${runId}:${sequence}`, sequence }
    }),
    beforeAttempt: request => lock(async () => {
      const { runId, sequence, file } = attemptLocation(request.attemptId)
      if (runId !== request.runId || !taskPattern.test(request.taskId) || !request.retryScopeId
        || !Number.isSafeInteger(request.estimatedInputTokens) || request.estimatedInputTokens < 0
        || !Number.isSafeInteger(request.maxOutputTokens) || request.maxOutputTokens <= 0) throw new Error('尝试请求或 token 预算无效。')
      const old = await readProtocol<AttemptEntry>(root, file, 'MODEL_LEDGER_CORRUPT')
      if (old) {
        if (canonicalJson(old.request) !== canonicalJson(request)) throw protocolError('ATTEMPT_CONFLICT', '同一尝试的请求发生变化。')
        return { status: 'reserved', reservationId: old.reservationId }
      }
      const runPath = `logs/model-runs/${runId}/run.json`
      const header: RunHeader = await readProtocol<RunHeader>(root, runPath, 'MODEL_LEDGER_CORRUPT') ?? { runId, nextSequence: 1, spent: { calls: 0, tokens: 0, costs: {} }, scopes: {} }
      if (sequence < header.nextSequence && !header.allocated?.includes(sequence)) throw protocolError('ATTEMPT_CONFLICT', '已分配的尝试序号不能重用。')
      const values = (await entries(root, runId)).filter(value => value.state !== 'released' && !header.archived?.ids.includes(value.request.attemptId))
      const archived = header.archived?.costs.total
      const tokens = (archived ? usageTokens(archived.usage) + archived.reservedTokens : 0) + values.reduce((sum, v) => sum + usageTokens(v.outcome?.usage ?? estimateUsage(v.request)), 0)
      const estimate = estimateUsage(request), price = request.priceSnapshot
      money(estimate, price)
      if (limits.maxCalls !== undefined && (archived?.calls ?? 0) + values.length + 1 > limits.maxCalls) return { status: 'paused', reason: '调用次数达到上限。' }
      if (limits.maxTokens !== undefined && tokens + usageTokens(estimate) > limits.maxTokens) return { status: 'paused', reason: 'Token 预留超过上限。' }
      if (limits.maxCost !== undefined) {
        if (!price || limits.currency && price.currency !== limits.currency || archived?.unknownPrice || Object.keys(archived?.costs ?? {}).some(c => c !== price.currency) || values.some(v => !v.request.priceSnapshot || v.request.priceSnapshot.currency !== price.currency)) return { status: 'paused', reason: '费用上限缺少同币种价格快照。' }
        const spent = (archived?.costs[price.currency] ?? 0) + values.reduce((sum, v) => sum + money(v.outcome?.usage ?? estimateUsage(v.request), v.request.priceSnapshot)!, 0)
        if (spent + money(estimate, price)! > limits.maxCost) return { status: 'paused', reason: '费用预留超过上限。' }
      }
      // 序号先持久化，即使随后预留落盘失败也不能重用。
      header.nextSequence = Math.max(header.nextSequence, sequence + 1)
      header.allocated = (header.allocated ?? []).filter(value => value !== sequence)
      await writeProtocol(root, runPath, header)
      await saveAttempt({ request: structuredClone(request), reservationId: request.attemptId, state: 'reserved', reservedAt: new Date().toISOString(), dispatchedAt: null, finishedAt: null,
        outcome: null, releaseReason: null, validation: { status: 'pending', reasonCode: null }, accepts: [] })
      return { status: 'reserved', reservationId: request.attemptId }
    }),
    onDispatch: id => lock(async () => {
      const value = await readAttempt(id)
      if (value.dispatchedAt) return
      if (value.state !== 'reserved') throw protocolError('ATTEMPT_CONFLICT', '已释放预留不能派发。')
      value.state = 'dispatched'; value.dispatchedAt = new Date().toISOString()
      await saveAttempt(value)
    }),
    afterAttempt: outcome => lock(async () => {
      const value = await readAttempt(outcome.attemptId)
      if (outcome.reservationId !== value.reservationId || !value.dispatchedAt || !['finished', 'unknown'].includes(outcome.status)) throw protocolError('ATTEMPT_CONFLICT', '未派发请求不能结算。')
      if (outcome.usage) normalizeUsage(outcome.usage)
      if (value.outcome) {
        if (canonicalJson(value.outcome) === canonicalJson(outcome)) return
        const correction = value.outcome.status === 'unknown' && outcome.status === 'finished'
          || value.outcome.usage === null && outcome.usage !== null && canonicalJson({ ...value.outcome, usage: null }) === canonicalJson({ ...outcome, usage: null })
        if (!correction) throw protocolError('ATTEMPT_CONFLICT', '同一尝试只能补结算一次可靠用量。')
      }
      value.outcome = structuredClone(outcome); value.state = outcome.status; value.finishedAt ??= new Date().toISOString()
      await saveAttempt(value)
    }),
    releaseAttempt: (id, reason) => lock(async () => {
      const value = await readAttempt(id)
      if (value.dispatchedAt) throw protocolError('ATTEMPT_CONFLICT', '已派发请求不能释放预算。')
      if (value.state === 'released') return
      value.state = 'released'; value.releaseReason = reason
      await saveAttempt(value)
    }),
    onValidation: result => lock(async () => {
      const value = await readAttempt(result.attemptId)
      if (value.request.taskId !== result.taskId || value.accepts.length) throw protocolError('ATTEMPT_CONFLICT', '不能覆盖已绑定的业务接受。')
      if (value.validation.status === result.status && value.validation.reasonCode === result.reasonCode) return
      value.validation = { status: result.status, reasonCode: result.reasonCode }
      await saveAttempt(value)
    }),
    prepareAccepted: request => lock(async () => {
      validateAcceptedRecord(request.record)
      if (request.taskId !== request.record.taskId || request.responseAttemptId !== null && !request.acceptedAttemptIds.includes(request.responseAttemptId)) throw protocolError('ACCEPT_CONFLICT', '拟接受的任务或响应关联不一致。')
      const normalized: AcceptanceRequest = { ...structuredClone(request), acceptedAttemptIds: sortedUnique(request.acceptedAttemptIds) }
      const old = await readAcceptance(request.taskId)
      if (old.status !== 'missing') {
        if (canonicalJson({ taskId: old.taskId, record: old.record, responseAttemptId: old.responseAttemptId, acceptedAttemptIds: old.acceptedAttemptIds }) !== canonicalJson(normalized)) throw protocolError('ACCEPT_CONFLICT', '同一任务的拟接受记录发生变化。')
        return { status: old.status, prepareId: old.prepareId }
      }
      const bytes = await readFile(await safePath(root, request.record.output.path))
      if (bytes.length !== request.record.output.bytes || hash(bytes) !== request.record.output.digest) throw protocolError('ACCEPT_PREPARE_CORRUPT', '接受输出尚未落盘或摘要不符。')
      for (const id of normalized.acceptedAttemptIds) {
        const attempt = await readAttempt(id)
        if (attempt.outcome?.finish !== 'success' || attempt.state !== 'finished' || ['rejected', 'superseded'].includes(attempt.validation.status)) throw protocolError('ACCEPT_CONFLICT', '失败或被拒收的尝试不能成为生产者。')
        const candidate = attempt.request.candidate
        if (!Object.values(request.record.productions).some(p => p.taskId === attempt.request.taskId && p.lineId === candidate.lineId && p.provider === attempt.outcome!.provider
          && p.requestedModel === candidate.requestedModel && p.reportedModel === attempt.outcome!.reportedModel && canonicalJson(p.parameters) === canonicalJson(candidate.parameters)
          && p.bindingRevision === candidate.bindingRevision && p.capabilityRevision === candidate.capabilityRevision)) throw protocolError('ACCEPT_CONFLICT', '生产记录与实际响应线路不符。')
      }
      const prepareId = protocolDigest({ taskId: request.taskId, outputDigest: request.record.output.digest })
      await writeProtocol(root, acceptancePath(request.taskId), { ...normalized, prepareId, status: 'prepared', acceptedDigest: null } satisfies AcceptanceSnapshot)
      return { prepareId, status: 'prepared' }
    }),
    readAcceptance,
    onAccepted: binding => lock(async () => {
      const snapshot = await readAcceptance(binding.taskId)
      if (snapshot.status === 'missing') throw protocolError('ACCEPT_PREPARE_MISSING', '接受准备记录缺失。')
      if (snapshot.prepareId !== binding.prepareId || protocolDigest(snapshot.record) !== binding.acceptedDigest
        || snapshot.acceptedDigest !== null && snapshot.acceptedDigest !== binding.acceptedDigest) throw protocolError('ACCEPT_CONFLICT', '接受绑定摘要不一致。')
      const committed = await readProtocol<AcceptedRecord>(root, `work/accepted/tasks/${binding.taskId.slice(2)}.json`, 'ACCEPTED_CORRUPT')
      if (!committed || canonicalJson(committed) !== canonicalJson({ ...snapshot.record, acceptedDigest: binding.acceptedDigest })) throw protocolError('ACCEPT_CONFLICT', 'IF-50 接受记录尚未提交或与准备快照不符。')
      if (snapshot.status !== 'bound') {
        snapshot.status = 'bound'; snapshot.acceptedDigest = binding.acceptedDigest
        await writeProtocol(root, acceptancePath(binding.taskId), snapshot)
      }
      // bound 是首个持久提交点；逐项引用失败后重放此方法可补齐。
      for (const id of snapshot.acceptedAttemptIds) {
        const value = await readAttempt(id)
        if (!value.accepts.some(ref => ref.taskId === binding.taskId && ref.acceptedDigest === binding.acceptedDigest)) {
          value.accepts.push({ taskId: binding.taskId, acceptedDigest: binding.acceptedDigest }); value.validation = { status: 'accepted', reasonCode: null }
          await saveAttempt(value)
        }
      }
      return { status: 'bound', acceptedDigest: binding.acceptedDigest }
    }),
  }
  return hooks
}
export async function readRunCosts(root: string, runId: string): Promise<RunCosts> {
  const header = await readProtocol<RunHeader>(root, `logs/model-runs/${runId}/run.json`, 'MODEL_LEDGER_CORRUPT')
  const current = summarizeAttempts((await entries(root, runId)).filter(entry => !header?.archived?.ids.includes(entry.request.attemptId)))
  return header?.archived ? combineRunCosts(header.archived.costs, current) : current
}
/** 仅在确认旧执行者已经退出后调用；未知请求保留调用和 token 占用。 */
export async function recoverExecutionRun(root: string, runId: string): Promise<{ nextSequence: number; attempts: AttemptEntry[] }> {
  return withRevocationLock(root, async () => {
    const hooks = createExecutionLedger(root)
    for (const entry of await entries(root, runId)) {
      if (entry.state === 'reserved') await hooks.releaseAttempt(entry.reservationId, '旧执行者退出，尚未持久派发')
      else if (entry.state === 'dispatched') await hooks.afterAttempt({ attemptId: entry.request.attemptId, reservationId: entry.reservationId,
        status: 'unknown', finish: null, provider: entry.request.candidate.provider, model: entry.request.candidate.requestedModel, reportedModel: null,
        usage: null, requestId: null, errorCategory: 'process-interrupted', localExitStatus: null })
    }
    const header = await readProtocol<RunHeader>(root, `logs/model-runs/${runId}/run.json`, 'MODEL_LEDGER_CORRUPT')
    return { nextSequence: header?.nextSequence ?? 1, attempts: await entries(root, runId) }
  })
}
export async function writeVersionCosts(root: string, version: string, manifestChecksum: string, runs: string[], previous: VersionCosts | null = null, legacyReport: string | null = null): Promise<{ path: string; checksum: string }> {
  const saved = structuredClone(previous?.runs ?? {})
  for (const runId of sortedUnique(runs)) saved[runId] = await readRunCosts(root, runId)
  const costs: VersionCosts = { schema: 'llmwiki-costs-v1', version, manifestChecksum, runs: saved, total: emptyTotals(), groups: [], prices: {}, legacy: previous?.legacy ?? (legacyReport !== null ? { report: legacyReport, reason: 'legacy-library' } : null) }
  const groups = new Map<string, RunCosts['groups'][number]>()
  for (const run of Object.values(saved)) {
    addTotals(costs.total, run.total); Object.assign(costs.prices, run.prices)
    for (const group of run.groups) {
      const key = canonicalJson([group.stage, group.lineId, group.model]), value = groups.get(key) ?? { ...group, totals: emptyTotals() }
      addTotals(value.totals, group.totals); groups.set(key, value)
    }
  }
  costs.groups = [...groups.values()].sort((a, b) => canonicalJson(a).localeCompare(canonicalJson(b)))
  const file = sidecarPath(version, 'costs'), checksum = protocolDigest(costs)
  await writeProtocol(root, file, { checksum, costs }); return { path: file, checksum }
}
export async function readVersionCosts(root: string, version: string, manifestChecksum: string): Promise<VersionCosts> {
  const envelope = await readProtocol<{ checksum: string; costs: VersionCosts }>(root, sidecarPath(version, 'costs'), 'PROVENANCE_INCOMPLETE')
  if (!envelope || protocolDigest(envelope.costs) !== envelope.checksum || envelope.costs.schema !== 'llmwiki-costs-v1'
    || envelope.costs.version !== version || envelope.costs.manifestChecksum !== manifestChecksum
    || envelope.costs.groups.reduce((sum, group) => sum + group.totals.calls, 0) !== envelope.costs.total.calls) throw protocolError('PROVENANCE_INCOMPLETE', '版本成本附属记录不完整。')
  return envelope.costs
}

export async function modelRetentionRoots(root: string): Promise<{ outputs: string[]; attempts: Set<string>; tasks: Set<string> }> {
  const names = await readdir(await safePath(root, 'logs/model-accepts')).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  const outputs: string[] = [], attempts = new Set<string>(), tasks = new Set<string>()
  const hooks = createExecutionLedger(root)
  for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
    const value = await hooks.readAcceptance('t:' + name.slice(0, -5))
    if (value.status === 'missing') continue
    // 准备快照自身也是崩溃恢复依据，只有显式解除后才可清理。
    outputs.push(value.record.output.path); tasks.add(value.taskId)
    for (const id of value.acceptedAttemptIds) attempts.add(id)
  }
  return { outputs, attempts, tasks }
}
/** 保留活动恢复引用；累计成本已内嵌于版本，不依赖明细日志。 */
export async function pruneModelLogs(root: string, before: number): Promise<void> {
  await withRevocationLock(root, async () => {
    const pending = await readOptional(await safePath(root, 'work/pending.json'))
    const preview = await readOptional(await safePath(root, 'work/preview.json'))
    if (pending || preview) return
    const upgrade = await readProtocol<{ accepted: Record<string, { taskId: string }> }>(root, 'work/upgrade-0.3.0.json', 'UPGRADE_CHECKPOINT_CORRUPT')
    const upgradeTasks = new Set(Object.values(upgrade?.accepted ?? {}).map(ref => ref.taskId))
    const names = await readdir(await safePath(root, 'logs/model-accepts')).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    const hooks = createExecutionLedger(root)
    for (const name of names.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
      const snapshot = await hooks.readAcceptance('t:' + name.slice(0, -5))
      if (snapshot.status !== 'bound' || upgradeTasks.has(snapshot.taskId) || await readOptional(await safePath(root, `work/accepted/tasks/${name}`))) continue
      const related = await Promise.all(snapshot.acceptedAttemptIds.map(id => readProtocol<AttemptEntry>(root, attemptLocation(id).file, 'MODEL_LEDGER_CORRUPT')))
      if (related.some(a => !a?.finishedAt || Date.parse(a.finishedAt) >= before)) continue
      await unlink(await safePath(root, acceptancePath(snapshot.taskId)))
    }
    const retained = await modelRetentionRoots(root)
    const runs = await readdir(await safePath(root, 'logs/model-runs')).catch(error => { if (error.code === 'ENOENT') return []; throw error })
    for (const run of runs.filter(name => /^[a-f0-9-]{36}$/i.test(name))) {
      const header = await readProtocol<RunHeader>(root, `logs/model-runs/${run}/run.json`, 'MODEL_LEDGER_CORRUPT')
      if (!header) continue
      const expired = (await entries(root, run)).filter(entry => entry.outcome?.usage && entry.finishedAt && Date.parse(entry.finishedAt) < before && !retained.attempts.has(entry.request.attemptId))
      const fresh = expired.filter(entry => !header.archived?.ids.includes(entry.request.attemptId))
      const costs = summarizeAttempts(fresh)
      const scopes = { ...header.archived?.scopes }, perLine = structuredClone(header.archived?.perLine ?? {})
      for (const entry of fresh) {
        const scope = entry.request.retryScopeId, line = entry.request.candidate.lineId
        scopes[scope] = (scopes[scope] ?? 0) + 1
        ;(perLine[scope] ??= {})[line] = (perLine[scope]?.[line] ?? 0) + 1
      }
      header.archived = { ids: sortedUnique([...(header.archived?.ids ?? []), ...fresh.map(entry => entry.request.attemptId)]), costs: header.archived ? combineRunCosts(header.archived.costs, costs) : costs, scopes, perLine }
      // 先提交累计汇总与去重 ID，再清明细；中断重入不会重复累计。
      await writeProtocol(root, `logs/model-runs/${run}/run.json`, header)
      for (const entry of expired) await unlink(await safePath(root, attemptLocation(entry.request.attemptId).file))
    }
  })
}
