import { hash } from './files.js'
import { cachedPointVectors } from './embedding.js'
import type { BuildLayeredOptions, PendingBuild, Point, SnapshotManifest, SourceGapRetry } from './schema.js'
import type { LocalSource } from './snapshot.js'

export function sourceRetryRequest(options: Pick<BuildLayeredOptions, 'retrySources' | 'retryTopics' | 'retryGaps' | 'reextract' | 'legacyLibraryAction'>): SourceGapRetry | undefined {
  const request = options.retrySources
  if (request === undefined) return undefined
  if (options.retryTopics !== undefined || options.retryGaps || options.reextract !== undefined || options.legacyLibraryAction) throw new Error('来源补缺不能与主题重试、强制重提或旧库备份组合。')
  if (!request || !Array.isArray(request.sourceIds) || !request.sourceIds.length || request.sourceIds.some(id => typeof id !== 'string' || !id.trim())
    || !Array.isArray(request.kinds) || !request.kinds.length || request.kinds.some(kind => kind !== 'summary' && kind !== 'review')) throw new Error('来源补缺必须指定非空 sourceIds 和 summary/review 种类。')
  if (new Set(request.sourceIds).size !== request.sourceIds.length || new Set(request.kinds).size !== request.kinds.length) throw new Error('来源补缺范围和种类不得重复。')
  return { sourceIds: [...request.sourceIds].sort(), kinds: [...request.kinds].sort() }
}

export function sourceRecoveryInput(manifest: SnapshotManifest): string {
  return hash(JSON.stringify([manifest.revocation_generation, manifest.sources.map(source =>
    [source.source_id, source.source_version, source.content_hash, source.current_path, source.alias_paths ?? []]).sort()]))
}

export function checkSourceRecovery(manifest: SnapshotManifest, saved: PendingBuild | undefined, options: BuildLayeredOptions): SourceGapRetry | undefined {
  const request = sourceRetryRequest(options), scope = saved?.source_scope
  if (!request && !scope) return undefined
  if (scope && (options.retryTopics !== undefined || options.retryGaps || options.reextract !== undefined || options.legacyLibraryAction)) throw new Error('未完成来源补缺不能改为主题重试、强制重提或旧库备份。')
  if (request && saved && !scope) throw new Error('已有其他未完成作业，不能改为来源补缺。')
  if (request && scope && JSON.stringify(request) !== JSON.stringify(scope.request)) throw new Error('未完成来源补缺的范围或种类已变化，请先完成原请求。')
  const selected = request ?? scope!.request
  if (selected.sourceIds.some(id => !manifest.sources.some(source => source.source_id === id))) throw new Error('来源补缺包含未发布的来源编号。')
  if (scope && scope.source_input !== sourceRecoveryInput(manifest)) throw new Error('来源补缺的已发布输入已变化，请先完成普通增量。')
  return selected
}

/** 在改名、删除及来源分配前检查完整输入集合，范围外变化不能顺带发布。 */
export function checkSourceRecoveryFiles(manifest: SnapshotManifest, sources: LocalSource[], relativePath: (source: LocalSource) => string): void {
  const key = (value: string) => process.platform === 'win32' ? value.toLowerCase() : value
  const expected = new Map(manifest.sources.flatMap(source => [source.current_path, ...(source.alias_paths ?? [])].map(file => [key(file), source.content_hash] as const)))
  if (sources.length !== expected.size || sources.some(source => expected.get(key(relativePath(source))) !== source.contentHash))
    throw Object.assign(new Error('来源补缺范围内外的资料存在新增、修改、删除或改名；请先完成普通增量。'), { stagePause: true, stage: 'extract', code: 'SOURCE_SCOPE_INPUT_CHANGED' })
}

/** 只更新本轮核对改变的点；新可用但未归属/未嵌入的点保留待办，不启动旧待办池。 */
export async function recoveredPointCoverage(root: string, pending: PendingBuild, points: Point[]): Promise<void> {
  const state = pending.manifest.vector_state
  if (!state || !points.length) return
  const cached = state.identity ? await cachedPointVectors(root, points, state.identity, pending.manifest.topics?.embedding.url) : {}
  const assigned = new Set((pending.topics?.state.topics ?? pending.manifest.topics?.topics ?? []).filter(topic => !topic.archived).flatMap(topic => topic.point_ids))
  const embedded = new Set(state.coverage.embedded), missing = new Set(state.coverage.missing), waiting = new Set(state.pending_points)
  for (const point of points) {
    embedded.delete(point.point_id); missing.delete(point.point_id)
    if (cached[point.point_id]) embedded.add(point.point_id)
    else missing.add(point.point_id)
    if (point.verification?.status !== 'unverified' && !assigned.has(point.point_id)) waiting.add(point.point_id)
    else waiting.delete(point.point_id)
  }
  state.coverage = { embedded: [...embedded].sort(), missing: [...missing].sort() }
  state.pending_points = [...waiting].sort()
}
