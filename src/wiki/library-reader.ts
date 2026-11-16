import { readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { LibraryRegistration } from '../domain/config.js'
import { LibraryStore } from '../storage/libraries.js'
import { safePath, withStateLayout } from '../storage/paths.js'
import { readCurrent, readManifest } from '../layered/objects.js'
import { readRevocations } from '../layered/revocations.js'
import { SiyuanAdapter, validateSiyuanRoot, WikiExportClient } from '../layered/siyuan.js'
import { resolveSharedRegistration } from '../storage/manifest.js'
import { findLayeredLibrary, WikiQuery } from './query.js'
import type { ModelRuntime } from '../llm/client.js'
import type { EmbeddingClient } from '../layered/schema.js'
import type { SearchOptions } from './page-search.js'
import { discoveryError, LibraryDiscovery, registryRevision } from './library-discovery.js'
import type { LibraryMetadata, DiscoveryBackend } from './library-discovery.js'

/** 只读清单与目录名称，不读页对象、不建立检索索引、不升级旧库。 */
export async function readLibraryMetadata(registration: LibraryRegistration, signal?: AbortSignal): Promise<LibraryMetadata> {
  signal?.throwIfAborted()
  const library = await resolveSharedRegistration(registration)
  if (!library) throw discoveryError('FORBIDDEN', '库已不在共享清单中。')
  const layered = await findLayeredLibrary(library.wikiPath)
  if (!layered) {
    if (library.siyuan) throw discoveryError('FORBIDDEN', '思源库尚未发布。')
    if (!(await stat(library.wikiPath)).isDirectory()) throw discoveryError('INVALID_PATH', '库目录不可读。')
    const titleSamples: string[] = [], byType: Record<string, number> = {}
    for (const folder of ['entities', 'concepts', 'sources']) {
      const files = await readdir(await safePath(library.wikiPath, folder), { recursive: true, withFileTypes: true }).catch(error => { if (error.code === 'ENOENT') return []; throw error })
      const pages = files.filter(file => file.isFile() && file.name.endsWith('.md'))
      byType[folder] = pages.length
      titleSamples.push(...pages.slice(0, Math.max(0, 80 - titleSamples.length)).map(file => path.basename(file.name, '.md')))
    }
    return { publishedVersion: null, generation: 0, topTopics: [], titleSamples, byType, sourceRefs: [] }
  }
  return withStateLayout(layered.root, async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      signal?.throwIfAborted()
      if (layered.card.origin_type === 'siyuan') {
        if (!library.siyuan) throw discoveryError('FORBIDDEN', '思源库缺少准入配置。')
        await validateSiyuanRoot(layered.root, library.siyuan)
        await new SiyuanAdapter(new WikiExportClient(library.id, library.siyuan)).checkAdmission(layered.root, signal)
      }
      const current = await readCurrent(layered.root), revocations = await readRevocations(layered.root)
      const manifest = await readManifest(layered.root, current)
      const revoked = new Set(revocations.sources.filter(item =>
        (manifest.sources.find(source => source.source_id === item.source_id)?.revocation_generation ?? -1) < item.generation).map(item => item.source_id))
      const allowed = (page: string, sources: string[]) => Boolean(manifest.pages?.[page]) && !manifest.rebuild_pages?.includes(page)
        && !sources.some(id => revoked.has(id))
      const topics = (manifest.topics?.topics ?? []).filter(topic => !topic.archived && allowed(topic.path, topic.sources))
      const sources = manifest.sources.filter(source => !revoked.has(source.source_id))
      const termTitles = Object.entries(manifest.deps?.pages ?? {}).filter(([page, deps]) => allowed(page, deps.sources))
        .flatMap(([, deps]) => deps.terms ?? []).map(term => term.name)
      const lists = [topics.map(topic => topic.title), sources.map(source => source.metadata.title), [...new Set(termTitles)]]
      const titleSamples: string[] = []
      for (let i = 0; titleSamples.length < 80; i++) {
        const row = lists.flatMap(list => list[i] === undefined ? [] : [list[i]!])
        if (!row.length) break
        titleSamples.push(...row.slice(0, 80 - titleSamples.length))
      }
      if (JSON.stringify(current) !== JSON.stringify(await readCurrent(layered.root)) || revocations.generation !== (await readRevocations(layered.root)).generation) continue
      return { publishedVersion: current?.version ?? null, generation: revocations.generation,
        topTopics: topics.filter(topic => !topic.parent_id).slice(0, 20).map(topic => topic.title), titleSamples,
        byType: { topics: topics.length, sources: sources.length, terms: lists[2]!.length },
        sourceRefs: sources.map(source => ({ sourceId: source.source_id, sourceVersion: source.source_version })) }
    }
    throw discoveryError('SELECTION_CHANGED', '库版本持续变化，请重试。')
  })
}
export function createLibraryDiscovery(store: LibraryStore, visible: DiscoveryBackend['visible'] = () => true) {
  return new LibraryDiscovery({ snapshot: () => store.snapshot(), visible, metadata: readLibraryMetadata })
}

/** B6a/宿主共用接点：显式库保持原路径；自动查询只把所选身份交给既有 L3。 */
export async function searchDiscovered(store: LibraryStore, discovery: LibraryDiscovery, question: string, name?: string,
  types?: string[], limit?: number, signal?: AbortSignal, options: SearchOptions = {}, embedding?: EmbeddingClient, runtime?: () => ModelRuntime | undefined) {
  const scopedStore = (ids: string[]) => new LibraryStore(() => {
    const registry = store.snapshot(), libraries = registry.libraries.filter(library => ids.includes(library.id))
    // 子视图的当前库须仍在子集中，不改变宿主登记的当前选择。
    return { ...registry, libraries, activeLibraryId: libraries.some(library => library.id === registry.activeLibraryId) ? registry.activeLibraryId : libraries[0]?.id ?? '' }
  })
  if (name) {
    const registrations = store.snapshot().libraries
    const selected = registrations.find(library => library.id === name) ?? registrations.find(library => library.name.normalize('NFKC').toLowerCase() === name.normalize('NFKC').toLowerCase())
    if (!selected) throw discoveryError('NOT_FOUND', '未找到已启用本地 Wiki：' + name)
    const card = await discovery.show(selected.id, signal)
    const result = await new WikiQuery(scopedStore([selected.id]), embedding, runtime).search(question, selected.id, types, limit, signal, options)
    if (JSON.stringify(card) !== JSON.stringify(await discovery.show(selected.id, signal))) throw discoveryError('SELECTION_CHANGED', '显式库的版本、简介或权限已变化，请重试。')
    return result
  }
  const selection = await discovery.find(question, undefined, signal), ids = selection.cards.map(card => card.libraryId)
  const revision = registryRevision(store.snapshot())
  const selectedStore = scopedStore(ids)
  const result = await new WikiQuery(selectedStore, embedding, runtime).search(question, undefined, types, limit, signal, options)
  // L3 仍验证自己的读视图，返回前再核对选库依据与会话可见性。
  if (revision !== registryRevision(store.snapshot()) || selection.selectionRevision !== (await discovery.find(question, undefined, signal)).selectionRevision)
    throw discoveryError('SELECTION_CHANGED', '选库后登记、版本或权限变化，请重试查询。')
  return { ...result, selectedLibraries: ids, selectionRevision: selection.selectionRevision, skipped: selection.skipped,
    selectionStatus: selection.status, selectionTruncated: selection.truncated }
}
