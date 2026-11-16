import { readFile } from 'node:fs/promises'
import type { LibraryStore } from '../storage/libraries.js'
import { safePath } from '../storage/paths.js'
import { readCurrent, readVersion } from '../layered/objects.js'
import { isProductionFormat, legacyProvenance, readProvenance } from '../layered/models.js'
import { readUpgradeStatus } from '../layered/upgrade.js'
import { findLayeredLibrary } from '../wiki/query.js'
import { readRevocations } from '../layered/revocations.js'
import { topicGapDiagnostics } from '../layered/topic-recovery.js'
import { readOptional } from '../storage/files.js'
import type { PendingBuild } from '../layered/schema.js'

/** 状态读取不触发升级，保留版本也按当前撤权表过滤。 */
export async function libraryProductionStatus(store: LibraryStore, id: string, version?: string) {
  const library = store.registration(id), layered = await findLayeredLibrary(await store.root(id))
  if (!layered) return { libraryId: id, version: null, format: 'uninitialized', upgrade: null, artifacts: [], topicGaps: [] }
  const root = layered.root, current = await readCurrent(root), selected = version ?? current?.version
  const upgraded = await isProductionFormat(root), upgrade = await readUpgradeStatus(root)
  if (!selected) return { libraryId: id, version: null, format: upgraded ? '0.3.0' : '0.2.x', upgrade: upgrade ?? null, artifacts: [], topicGaps: [] }
  if (!/^v\d{6,}$/.test(selected)) throw new Error('版本号无效。')
  const manifest = await readVersion(root, selected)
  if (!manifest) throw new Error('所选发布版本不存在。')
  const envelope = JSON.parse(await readFile(await safePath(root, `versions/${selected}.json`), 'utf8')) as { checksum: string }
  const provenance = upgraded ? await readProvenance(root, selected, envelope.checksum) : await legacyProvenance(root, manifest, envelope.checksum)
  const revoked = new Set((await readRevocations(root)).sources.map(source => source.source_id))
  const pending = selected === current?.version ? await readOptional<PendingBuild>(await safePath(root, 'work/pending.json')) : undefined
  store.assertUnchanged(library)
  return { libraryId: id, version: selected, format: upgraded ? '0.3.0' : '0.2.x', upgrade: upgrade ?? null,
    topicGaps: topicGapDiagnostics(manifest, pending?.topics).filter(gap => !gap.point_ids.some(point => revoked.has(point.split(':')[0]!))),
    artifacts: Object.entries(provenance.artifacts).filter(([, item]) => !item.sourceRefs.some(ref => revoked.has(ref.sourceId))).map(([artifactId, item]) => ({
      artifactId, path: item.pagePath ?? item.objectPath, kind: item.kind, status: item.status,
      model: item.status === 'unknown' ? '未知' : item.status === 'local-derived' ? '本地派生' : null,
      reason: item.reason ?? null, productions: item.productionIds.map(id => provenance.records[id]!), inheritedFrom: item.inheritedFrom,
    })) }
}
