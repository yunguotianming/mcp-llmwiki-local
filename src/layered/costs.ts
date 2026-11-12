import type { ModelAttempt } from '../llm/client.js'
import { atomicWrite, hash, writeJson } from './files.js'
import { readOptional } from '../storage/files.js'
import { safePath } from '../storage/paths.js'
import type { BuildLayeredOptions, CostReport, PendingBuild, StageCost } from './schema.js'
import { layeredSettings } from '../domain/config.js'
import { jsonProtocol, runtimeSchemaRegistry } from '../llm/protocol.js'
import { parseModelJson } from '../llm/json.js'
import type { ModelCallOptions } from '../llm/client.js'

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
      const schema = args[5]?.structuredSchema?.schema
      const firstKey = stage === '提取' && !correction && schema ? hash(args[1] + args[2]) : undefined
      const first: NonNullable<CostReport['first_extractions']>[string] | undefined = firstKey && !(costs.first_extractions ??= {})[firstKey]
        ? costs.first_extractions[firstKey] = { source_id: String(sourceId), status: 'pending' } : undefined
      // 先保存首提身份和实时纠正计数；后续恢复只补结果，不用重试覆盖首次观测。
      if (first || correction) await writeJson(root, 'work/pending.json', pending)
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
          if (first) {
            const validate = runtimeSchemaRegistry().find(item => item.internalSchema === schema)?.validate
            try { first.status = validate?.(parseModelJson(raw, schema)) ? 'passed' : 'failed' }
            catch { first.status = 'failed' }
          }
          return raw
        } catch (error) {
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
        }
      }, recent, logicalKeys, args[3])
    },
  }, ...(options.embeddingClient ? { embeddingClient: {
    ...(options.embeddingClient.identity ? { identity: options.embeddingClient.identity.bind(options.embeddingClient) } : {}),
    embed: async (input, signal, queuedAt) => measure('嵌入', JSON.stringify(input), () => options.embeddingClient!.embed(input, signal), undefined, undefined, signal, queuedAt) } } : {}) }
}
export async function saveCosts(root: string, pending: PendingBuild, version: string): Promise<void> {
  const reports = await readOptional<Record<string, CostReport>>(await safePath(root, 'logs/costs.json')) ?? {}
  reports[version] = pending.costs ?? costReport(pending.started_at)
  for (const key of Object.keys(reports).slice(0, -2)) delete reports[key]
  await writeJson(root, 'logs/costs.json', reports)
  await atomicWrite(root, 'logs/cost-report.md', '# 建库成本\n\n' + Object.entries(reports).map(([id, report]) => `## ${id} · ${report.started_at}\n\n${costMarkdown(report)}`).join('\n'))
}
