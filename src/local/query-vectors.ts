import type { LibraryStore } from '../storage/libraries.js'
import { findLayeredLibrary } from '../wiki/query.js'
import { copyEmbeddingRequestSchema, copyWithEmbedding } from '../layered/query-vectors.js'
import { SiyuanAdapter, validateSiyuanRoot, WikiExportClient } from '../layered/siyuan.js'
import type { RegistryWriter } from './config.js'
import { parseRegistry } from '../domain/config.js'
import path from 'node:path'

export async function copyLibraryWithEmbedding(store: LibraryStore, input: unknown, signal?: AbortSignal, writeRegistry?: RegistryWriter) {
  if (!writeRegistry) throw new Error('本地配置写入服务尚未连接，无法登记副本。')
  const { libraryId, target, confirm } = copyEmbeddingRequestSchema.parse(input)
  const library = store.registration(libraryId), root = await store.root(libraryId), layered = await findLayeredLibrary(root)
  if (!layered) throw new Error('复制并切换向量模型只适用于已发布的分层库。')
  if (layered.card.origin_type === 'siyuan') {
    if (!library.siyuan) throw new Error('思源库缺少准入设置。')
    await validateSiyuanRoot(layered.root, library.siyuan)
    await new SiyuanAdapter(new WikiExportClient(libraryId, library.siyuan)).checkAdmission(layered.root, signal)
  }
  store.assertUnchanged(library)
  const expected = store.snapshot()
  const result = await copyWithEmbedding(layered.root, target, confirm, { signal, settings: library.layered, register: async copy => {
    store.assertUnchanged(library)
    const next = structuredClone(expected), item = { ...library, id: copy.libraryId, name: copy.name, wikiPath: copy.path, sourceRoots: [path.dirname(copy.path)], layered: copy.settings, mode: 'managed' as const }
    next.libraries.push(item); next.activeLibraryId = item.id
    await writeRegistry(parseRegistry(next), expected)
  } })
  return { sourceLibraryId: libraryId, ...result, identity: { ...result.identity } }
}
