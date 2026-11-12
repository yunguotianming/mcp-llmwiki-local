/** 来源身份先按整篇内容分组，再在未匹配集合中判断同路径修改。 */
export interface IdentityDocument { path: string; hash: string; segments: readonly string[] }
export interface IdentityRecord extends IdentityDocument { id: string; aliases?: readonly string[] | undefined }
export const sourcePathKey = (file: string): string => process.platform === 'win32' ? file.toLowerCase() : file

/** 去重段哈希的交集除以较大的段数；空文档不能凭空集合判定为修改。 */
export function sourceSimilarity(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left), b = new Set(right)
  return Math.max(a.size, b.size) ? [...a].filter(item => b.has(item)).length / Math.max(a.size, b.size) : 0
}

export function matchSourceIdentities<D extends IdentityDocument, R extends IdentityRecord>(documents: readonly D[], records: readonly R[], threshold = 0.5): {
  groups: { documents: D[]; previous?: R }[]; deleted: R[]
} {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error('来源相似度阈值应为 0～1。')
  const byHash = new Map<string, D[]>()
  for (const document of documents) {
    const group = byHash.get(document.hash) ?? []
    group.push(document); byHash.set(document.hash, group)
  }
  const groups: { documents: D[]; previous?: R }[] = [...byHash.values()].map(group => ({ documents: group.sort((a, b) => sourcePathKey(a.path).localeCompare(sourcePathKey(b.path))) }))
    .sort((a, b) => sourcePathKey(a.documents[0]!.path).localeCompare(sourcePathKey(b.documents[0]!.path)))
  const ordered = [...records].sort((a, b) => a.id.localeCompare(b.id, undefined, { numeric: true }))
  const used = new Set<R>()
  // 必须先完成全批内容匹配；否则循环重编号中的旧路径会抢走另一篇文档的身份。
  for (const group of groups) {
    const previous = ordered.find(record => record.hash === group.documents[0]!.hash && !used.has(record))
    if (previous) { group.previous = previous; used.add(previous) }
  }
  for (const group of groups) {
    if (!group.previous) {
      const paths = new Set(group.documents.map(document => sourcePathKey(document.path)))
      const candidates = ordered.filter(record => !used.has(record) && [record.path, ...(record.aliases ?? [])].some(file => paths.has(sourcePathKey(file))))
        .map(record => ({ record, similarity: sourceSimilarity(record.segments, group.documents[0]!.segments) }))
        .filter(item => item.similarity >= threshold).sort((a, b) => b.similarity - a.similarity || a.record.id.localeCompare(b.record.id, undefined, { numeric: true }))
      if (candidates[0]) { group.previous = candidates[0].record; used.add(candidates[0].record) }
    }
    // 原主路径还在时保持它；删除原件后再将排序最前的副本提升为主路径。
    const retained = group.previous && group.documents.findIndex(document => sourcePathKey(document.path) === sourcePathKey(group.previous!.path))
    if (retained !== undefined && retained >= 0) group.documents.unshift(...group.documents.splice(retained, 1))
  }
  return { groups, deleted: ordered.filter(record => !used.has(record)) }
}
