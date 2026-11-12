export interface RankedNode { path: string; references: string[]; links: string[] }
const normalize = (value: string) => {
  try { value = decodeURIComponent(value) } catch {}
  return value.normalize('NFKC').replaceAll('\\', '/').replace(/\.md$/i, '').toLowerCase()
}
// 带重启的定向图传播；循环与多跳均有固定迭代上限，同名引用不任选一页。
export function rankGraph<T extends RankedNode>(nodes: T[], seeds: ReadonlyMap<T, number>): Map<T, number> {
  const total = [...seeds.values()].reduce((sum, score) => sum + score, 0)
  if (!total) return new Map()
  const references = new Map<string, Set<T>>()
  for (const node of nodes) for (const ref of node.references) {
    const key = normalize(ref), matches = references.get(key) ?? new Set<T>(); matches.add(node); references.set(key, matches)
  }
  const edges = new Map<T, T[]>()
  for (const node of nodes) {
    const targets = new Set<T>()
    for (const link of node.links) {
      const matches = references.get(normalize(link))
      if (matches?.size === 1) for (const target of matches) if (target !== node) targets.add(target)
    }
    edges.set(node, [...targets])
  }
  const teleport = new Map(nodes.map(node => [node, (seeds.get(node) ?? 0) / total]))
  let ranks = new Map(teleport)
  const damping = 0.65
  for (let iteration = 0; iteration < 40; iteration++) {
    const next = new Map(nodes.map(node => [node, (1 - damping) * teleport.get(node)!]))
    let dangling = 0
    for (const node of nodes) {
      const targets = edges.get(node)!, value = damping * ranks.get(node)!
      if (!targets.length) dangling += value
      else for (const target of targets) next.set(target, next.get(target)! + value / targets.length)
    }
    let difference = 0
    for (const node of nodes) { next.set(node, next.get(node)! + dangling * teleport.get(node)!); difference += Math.abs(next.get(node)! - ranks.get(node)!) }
    ranks = next
    if (difference < 1e-8) break
  }
  const result = new Map<T, number>()
  for (const node of nodes) if (ranks.get(node)! > 1e-10) result.set(node, (seeds.get(node) ?? 0) + ranks.get(node)! * total * 0.15)
  return result
}
