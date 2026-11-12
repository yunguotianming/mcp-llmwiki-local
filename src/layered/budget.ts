import { appendLog } from './files.js'

// 最大余数法：先保证有额度的组至少一条，再按正文长度分配剩余额度。
export function allocatePointQuotas(lengths: number[], limit: number): number[] {
  const quotas = lengths.map(() => 0)
  const selected = lengths.map((length, index) => ({ length, index })).sort((a, b) => b.length - a.length || a.index - b.index).slice(0, limit)
  const total = selected.reduce((sum, item) => sum + item.length, 0), remaining = limit - selected.length
  for (const item of selected) quotas[item.index] = 1 + Math.floor(remaining * item.length / Math.max(1, total))
  const residual = limit - quotas.reduce((sum, value) => sum + value, 0)
  selected.sort((a, b) => (remaining * b.length / Math.max(1, total)) % 1 - (remaining * a.length / Math.max(1, total)) % 1 || a.index - b.index)
  for (const item of selected.slice(0, residual)) quotas[item.index]!++
  return quotas
}

export interface EstimateInput {
  sources: number; leafSegments: number; tier: number; topicLeaves: number; topicParents: number
  termSections?: number; termSourceCounts?: number[]; termThreshold?: number; termMaxSources?: number
  revokedPages?: number; lintPages?: number; reclusterCalls?: number
  averageTokensPerCall?: number
}
export interface EstimateStage { calls: number; tokens: number }
export interface LayeredEstimate {
  sources: number; total: EstimateStage; '提取': EstimateStage; '主题': EstimateStage; '父页': EstimateStage
  '术语': EstimateStage; '撤权重建': EstimateStage; lint: EstimateStage; '全量重聚类': EstimateStage
}
export function estimateLayeredBuild(input: EstimateInput): LayeredEstimate {
  const average = input.averageTokensPerCall ?? 1200
  const threshold = input.tier < 50 ? Infinity : input.termThreshold ?? (input.tier === 50 ? 5 : input.tier === 75 ? 3 : 2)
  const termSections = input.tier < 50 ? 0 : input.termSections
    ?? (input.termSourceCounts ?? []).filter(count => count >= threshold).reduce((sum, count) => sum + Math.ceil(count / (input.termMaxSources ?? 20)), 0)
  const stages: Record<string, EstimateStage> = {
    '提取': { calls: input.leafSegments, tokens: Math.ceil(input.leafSegments * average * Math.max(1, input.tier / 50)) },
    '主题': { calls: input.topicLeaves, tokens: input.topicLeaves * average },
    '父页': { calls: input.topicParents, tokens: input.topicParents * average },
    '术语': { calls: termSections, tokens: termSections * average },
    '撤权重建': { calls: input.revokedPages ?? 0, tokens: (input.revokedPages ?? 0) * average },
    'lint': { calls: input.lintPages ?? 0, tokens: (input.lintPages ?? 0) * average },
    '全量重聚类': { calls: input.reclusterCalls ?? 0, tokens: (input.reclusterCalls ?? 0) * average },
  }
  return { sources: input.sources, total: Object.entries(stages).filter(([name]) => name !== '全量重聚类').reduce((sum, [, stage]) => ({ calls: sum.calls + stage.calls, tokens: sum.tokens + stage.tokens }), { calls: 0, tokens: 0 }),
    '提取': stages['提取']!, '主题': stages['主题']!, '父页': stages['父页']!, '术语': stages['术语']!, '撤权重建': stages['撤权重建']!,
    lint: stages.lint!, '全量重聚类': stages['全量重聚类']! }
}
export interface FairInput { source_id: string; text: string; weight?: number }
export function truncateFairly<T extends FairInput>(items: T[], maxBytes: number): { items: T[]; truncated: string[] } {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new Error('公平输入预算必须为非负整数。')
  const weights = new Map<string, number>()
  for (const item of items) weights.set(item.source_id, Math.max(weights.get(item.source_id) ?? 1, item.weight ?? 1))
  const totalWeight = [...weights.values()].reduce((sum, value) => sum + value, 0)
  const used = new Map<string, number>(), truncated = new Set<string>()
  const output = items.map(item => {
    const allowance = Math.floor(maxBytes * (weights.get(item.source_id) ?? 1) / Math.max(1, totalWeight))
    const remaining = Math.max(0, allowance - (used.get(item.source_id) ?? 0)), text = Array.from(item.text)
    let low = 0, high = text.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (Buffer.byteLength(JSON.stringify(text.slice(0, middle).join(''))) - 2 <= remaining) low = middle
      else high = middle - 1
    }
    const value = text.slice(0, low).join(''), bytes = Buffer.byteLength(JSON.stringify(value)) - 2
    used.set(item.source_id, (used.get(item.source_id) ?? 0) + bytes)
    if (value !== item.text) truncated.add(item.source_id)
    return { ...item, text: value }
  })
  return { items: output, truncated: [...truncated] }
}
export async function logFairTruncation(root: string, page: string, sources: string[], setting: string): Promise<void> {
  await appendLog(root, `\n### 输入预算截断\n- 页面：${page}\n- 来源：${sources.join('、')}\n- 请调整设置：${setting}\n`)
}
