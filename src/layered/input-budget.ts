import { topicInputBudget } from '../llm/context.js'
import type { BuildLayeredOptions, Point } from './schema.js'

export function semanticStageSettings(settings: object, stage: 'topic' | 'term'): Record<string, unknown> {
  // 阶段仅由自身内容规则失效；提取、显示、路由及向量设置不使综合正文失效。
  const keys = stage === 'topic'
    ? ['topicMaxChars', 'topicMaxSources', 'topicMaxPoints', 'topicMaxChildren', 'topicMaxDepth', 'topicMergeMinSources', 'topicRewriteAfter']
    : ['termSimilarityThreshold', 'termMaxSources', 'termMaxChars', 'termThreshold50', 'termThreshold75', 'termThreshold100']
  return Object.fromEntries(Object.entries(settings).filter(([key]) => keys.includes(key))
    .sort(([left], [right]) => left.localeCompare(right)))
}

export async function topicBudget(options: BuildLayeredOptions, operation: 'topic' | 'parent' | 'extract' | 'term', override = 0): Promise<number> {
  let model: number | undefined
  if (options.client.inputBudget) model = await options.client.inputBudget('ingest', options.signal, operation, operation === 'term' ? 0 : 0.1)
  else {
    const info = await options.client.info('ingest', options.signal, undefined, operation)
    if (info.context?.contextWindow !== undefined) model = operation === 'term'
      ? info.context.contextWindow - (info.defaultMaxTokens || 4096)
      : topicInputBudget(info.context.contextWindow, info.defaultMaxTokens || 4096)
  }
  if (model === undefined || !Number.isFinite(model) || model <= 0) throw new Error('主题模型未声明可用上下文或输出预留耗尽上下文。')
  const limit = Math.min(model, override || Infinity, options.maxInputBytes ?? Infinity)
  if (!Number.isFinite(limit) || limit <= 0) throw new Error('阶段输入预算必须为正数。')
  return limit
}

// 保持来源与原文章节相邻；每个成员（含全部引文）是不可裁剪的原子。
export function orderedMembers(members: Point[]): Point[] {
  return [...members].sort((a, b) => a.point_id.split(':')[0]!.localeCompare(b.point_id.split(':')[0]!)
    || a.locator.localeCompare(b.locator, undefined, { numeric: true }) || a.point_id.localeCompare(b.point_id))
}

export function completeInputBlocks<T>(items: T[], fits: (items: T[]) => boolean): T[][] {
  const blocks: T[][] = []
  let block: T[] = []
  for (const item of items) {
    if (!fits([...block, item])) {
      if (block.length) blocks.push(block)
      block = []
      if (!fits([item])) throw new Error('单个完整成员及证据超过输入预算，保留来源层并登记缺口；不截断事实或引文。')
    }
    block.push(item)
  }
  if (block.length) blocks.push(block)
  return blocks
}
