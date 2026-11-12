import { hash } from './files.js'
import type { Point, TopicState } from './schema.js'

export const memberContentHash = (point: Point): string => hash(JSON.stringify([point.text, point.section, point.evidence.map(item => item.quote)]))
// 父主题的排除决定也约束其后续拆出的子主题。
export function excludedMember(state: TopicState, topicId: string, pointId: string): boolean {
  const excluded = state.excluded_members
  if (!excluded) return false
  // 原判定只可能命中自身或连字符前缀；只查可枚举自有键，保持 Object.entries 的表边界。
  for (let id = topicId; ; id = id.slice(0, id.lastIndexOf('-'))) {
    if (Object.prototype.propertyIsEnumerable.call(excluded, id) && excluded[id]![pointId]) return true
    if (!id.includes('-')) return false
  }
}
