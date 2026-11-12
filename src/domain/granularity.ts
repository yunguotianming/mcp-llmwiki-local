// 部分改编自 obsidian-llm-wiki（Apache-2.0），已修改。来源及版权见 THIRD_PARTY_NOTICES.md。
import type { LayeredSettings } from './config.js'
import type { LibraryPolicy } from './policy.js'

export type Granularity = 'fine' | 'detailed' | 'standard' | 'balanced' | 'coarse' | 'minimal' | 'custom'
const basic = { sourcePackRatio: 0, sourceChapterMinPoints: 0, sourceLongChapterChars: 0, extractionReview: 'off', topicReview: false, contradictionReview: false } as const
// 相对成本按要点量与提取、核对调用量估算，标准为 1；实测后可替换。
export const granularityTiers = [
  { name: 'fine', value: 100, label: '精细', cost: 2.4, description: '单篇深度分析（100～400 个要点，随篇幅扩额）', selectivity: '提取全部，包括次要与旁及的内容', defaults: { ...basic, sourcePackRatio: 0.25, sourceChapterMinPoints: 1, sourceLongChapterChars: 10000, extractionReview: 'all', topicReview: true, contradictionReview: true } },
  // 细致与精细同用全量核对；适中与标准同用关键核对。数值档之间按篇幅同一公式扩额。
  { name: 'detailed', value: 75, label: '细致', cost: 1.8, description: '扩展分析（75～300 个要点，随篇幅扩额）', selectivity: '提取重要内容与主要细节，次要旁及内容可略', defaults: { ...basic, sourcePackRatio: 0.25, sourceChapterMinPoints: 1, sourceLongChapterChars: 10000, extractionReview: 'all', topicReview: true, contradictionReview: true } },
  { name: 'standard', value: 50, label: '标准', cost: 1, description: '日常资料（50～200 个要点，随篇幅扩额）', selectivity: '提取重要与较重要的内容，忽略次要细节', defaults: { ...basic, sourcePackRatio: 0.5, sourceChapterMinPoints: 1, extractionReview: 'key', topicReview: true } },
  { name: 'balanced', value: 25, label: '适中', cost: 0.5, description: '重点梳理（25～100 个要点，随篇幅扩额）', selectivity: '提取重要内容，略去一般细节', defaults: { ...basic, sourcePackRatio: 0.5, sourceChapterMinPoints: 1, extractionReview: 'key', topicReview: true } },
  { name: 'coarse', value: 10, label: '粗放', cost: 0.2, description: '快速概览（10～40 个要点，随篇幅扩额）', selectivity: '只提取最核心的内容', defaults: basic },
  { name: 'minimal', value: 5, label: '极简', cost: 0.1, description: '批量 100+ 文件（5～20 个要点，随篇幅扩额）', selectivity: '只提取最关键的内容', defaults: basic },
  { name: 'custom', value: 0, label: '自定义', cost: 1, description: '自行设定上限（1–500）', selectivity: '', defaults: basic },
] as const satisfies readonly { name: Granularity; value: number; label: string; cost: number; description: string; selectivity: string; defaults: Partial<LayeredSettings> }[]
export const granularityDescription = '控制每篇资料提取的要点数量。越高 = 页面内容越多，模型消耗越大。批量处理大量文件时，建议使用极简或粗放以节省时间和成本。'
export function linkedGranularity(limit: number) {
  return granularityTiers.find(tier => tier.name !== 'custom' && tier.value <= limit) ?? granularityTiers.find(tier => tier.name === 'minimal')!
}
export function granularityTier(policy: Pick<LibraryPolicy, 'extractionGranularity' | 'customEntityLimit' | 'customConceptLimit' | 'customPointLimit'>) {
  const name = policy.extractionGranularity
  if (name !== 'custom') return granularityTiers.find(tier => tier.name === name) ?? granularityTiers.find(tier => tier.name === 'standard')!
  // 旧自定义配置保留两项之和；新写入的单项上限须为 1～500。
  const value = policy.customPointLimit ?? policy.customEntityLimit + policy.customConceptLimit
  if (!Number.isSafeInteger(value) || value < 1 || policy.customPointLimit !== undefined && value > 500) throw new Error('自定义要点上限必须为 1～500 的整数。')
  const linked = linkedGranularity(value)
  return { ...granularityTiers.find(tier => tier.name === 'custom')!, value, cost: Number((linked.cost * value / linked.value).toFixed(2)), selectivity: '最多 ' + value + ' 个要点', defaults: linked.defaults }
}
export function extractionSelectivity(tier: number, name?: Granularity): string {
  return name === 'custom' ? '最多 ' + tier + ' 个要点' : (granularityTiers.find(item => item.name !== 'custom' && item.value === tier)?.selectivity ?? '最多 ' + tier + ' 个要点')
}
export function ordinaryPointLimit(chars: number, tier: number, name?: Granularity,
  expansion: Pick<LayeredSettings, 'sourcePointBaseChars' | 'sourcePointMaxMultiplier'> = { sourcePointBaseChars: 25000, sourcePointMaxMultiplier: 4 }): number {
  // 自定义按用户填值；其余档位（含未带名称的旧调用）先按篇幅扩额，确定篇级硬上限。
  const expanded = name !== 'custom'
  return expanded ? tier * Math.min(expansion.sourcePointMaxMultiplier, Math.max(1, Math.ceil(chars / expansion.sourcePointBaseChars))) : tier
}

// 先每章一条，再按正文由长到短补底线，最后用最大余数法按正文比例分余量。
export function allocateChapterQuotas(lengths: number[], floors: number[], limit: number): number[] {
  const quotas = lengths.map(() => 0)
  const order = lengths.map((length, index) => ({ length, index })).filter(item => item.length > 0)
    .sort((a, b) => b.length - a.length || a.index - b.index)
  let remaining = limit
  for (const item of order) { if (!remaining) break; quotas[item.index] = 1; remaining-- }
  for (const item of order) {
    const extra = Math.min(remaining, Math.max(0, floors[item.index]! - quotas[item.index]!))
    quotas[item.index]! += extra; remaining -= extra
  }
  const total = order.reduce((sum, item) => sum + item.length, 0), extra = remaining
  if (!total) return quotas
  for (const item of order) {
    const share = Math.floor(extra * item.length / total)
    quotas[item.index]! += share; remaining -= share
  }
  order.sort((a, b) => (extra * b.length / total) % 1 - (extra * a.length / total) % 1 || a.index - b.index)
  for (const item of order.slice(0, remaining)) quotas[item.index]!++
  return quotas
}
// 旧调用方的单包请求上限；分层章节名额由 allocateChapterQuotas 按篇级硬上限分配。
export function packPointLimit(chars: number, tier: number, name?: Granularity): number {
  // 短文按字数降低单包请求；适中及以上档都适用，粗放、极简原本就小，自定义按用户填值。
  return chars < 20000 && name !== 'custom' && tier >= 25 ? Math.min(tier, Math.max(5, Math.ceil(chars / 600))) : tier
}
