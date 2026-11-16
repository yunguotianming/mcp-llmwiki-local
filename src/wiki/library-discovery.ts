import type { LibraryRegistration, Registry } from '../domain/config.js'
import type { LibraryOrganization } from '../domain/registry-schema.js'
import { protocolDigest } from '../layered/models.js'
import { terms } from './identity-search.js'

export const registryRevision = (registry: Registry): string => protocolDigest(JSON.parse(JSON.stringify(registry)))
export const discoveryError = (code: string, message: string, draft?: unknown) => Object.assign(new Error(message), {
  code, httpStatus: code === 'REGISTRY_CONFLICT' ? 409 : code === 'FORBIDDEN' ? 403 : code === 'NOT_FOUND' ? 404 : 400,
  ...(draft === undefined ? {} : { draft: structuredClone(draft) }),
})
export const cardUri = (id: string): string => `llmwiki://libraries/${encodeURIComponent(id)}/card`
export type Summary = NonNullable<LibraryOrganization['summary']>
export interface LibraryMetadata {
  publishedVersion: string | null; generation: number; topTopics: string[]
  titleSamples: string[]; byType: Record<string, number>; sourceRefs: { sourceId: string; sourceVersion: string }[]
}
export interface DiscoveryBackend {
  snapshot(): Registry
  visible(library: LibraryRegistration, signal?: AbortSignal): boolean | Promise<boolean>
  metadata(library: LibraryRegistration, signal?: AbortSignal): Promise<LibraryMetadata>
}
export interface LibraryCard {
  libraryId: string; name: string; short: string; long: string; topTopics: string[]; publishedVersion: string | null
  summaryRevision: string; summaryStatus: NonNullable<LibraryOrganization['summaryStatus']>; cardUri: string
}
export interface CatalogInput { cursor?: string | undefined; limit?: number | undefined; groupId?: string | null | undefined }
export type SkippedLibrary = { libraryId: string; reason: string }
export function librarySummary(library: LibraryRegistration): Summary {
  // 旧简介来源不明，原文只迁入长档并锁定；短档留给显式补齐。
  return { ...(library.description && !library.summary?.long ? { long: { text: library.description, origin: 'legacy' as const, locked: true, sourceVersion: null } } : {}), ...library.summary }
}
export function summaryView(library: LibraryRegistration, metadata: LibraryMetadata) {
  const summary = librarySummary(library)
  const revoked = metadata.generation > (library.summaryGeneration ?? 0)
  const hidden = revoked || library.summaryStatus === 'review-required'
  const status: NonNullable<LibraryOrganization['summaryStatus']> = hidden ? 'review-required' : library.summaryStatus === 'pending' ? 'pending'
    : !summary.short?.text || !summary.long?.text ? 'missing' : 'ready'
  return { summary, hidden, status, revision: protocolDigest({ summary, generation: library.summaryGeneration ?? 0, status }) }
}
const integer = (value: number | undefined, fallback: number, max: number) => {
  const result = value ?? fallback
  if (!Number.isSafeInteger(result) || result < 1 || result > max) throw discoveryError('INVALID_ARGUMENT', `数量须为 1～${max} 的整数。`)
  return result
}
const compareId = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

/** L0/L1/L2 共用只读元数据；每次取新快照，避免跨修订或撤权复用缓存。 */
export class LibraryDiscovery {
  constructor(readonly backend: DiscoveryBackend) {}
  private async visible(registry: Registry, signal?: AbortSignal) {
    const result: LibraryRegistration[] = []
    for (const library of registry.libraries) {
      signal?.throwIfAborted()
      if (library.enabled && library.kind !== 'whalefall' && await this.backend.visible(library, signal)) result.push(library)
    }
    return result
  }
  private assertRegistry(registry: Registry) {
    if (registryRevision(registry) !== registryRevision(this.backend.snapshot())) throw discoveryError('REGISTRY_CONFLICT', '登记已变化，请重新读取。')
  }
  private card(library: LibraryRegistration, metadata: LibraryMetadata): LibraryCard {
    const view = summaryView(library, metadata)
    return { libraryId: library.id, name: library.name, short: view.hidden ? '' : view.summary.short?.text ?? '',
      long: view.hidden ? '' : view.summary.long?.text ?? '', topTopics: metadata.topTopics.slice(0, 20),
      publishedVersion: metadata.publishedVersion, summaryRevision: view.revision, summaryStatus: view.status, cardUri: cardUri(library.id) }
  }
  async show(id: string, signal?: AbortSignal) {
    const registry = this.backend.snapshot(), library = registry.libraries.find(item => item.id === id)
    if (!library) throw discoveryError('NOT_FOUND', '库未登记。')
    if (!library.enabled || !await this.backend.visible(library, signal)) throw discoveryError('FORBIDDEN', '当前会话不可访问此库。')
    const card = this.card(library, await this.backend.metadata(library, signal))
    this.assertRegistry(registry)
    return card
  }
  async l0(signal?: AbortSignal) {
    const registry = this.backend.snapshot(), visible = await this.visible(registry, signal)
    const limit = registry.discovery?.pinnedLimit ?? 5
    const libraries: { libraryId: string; name: string; short: string }[] = []
    for (const library of visible.filter(item => item.pinned).sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || compareId(a.id, b.id))) {
      if (libraries.length >= limit) break
      try {
        const card = this.card(library, await this.backend.metadata(library, signal))
        if (card.summaryStatus === 'review-required') continue
        libraries.push({ libraryId: library.id, name: library.name.slice(0, 80), short: card.short.slice(0, 80) })
      } catch { signal?.throwIfAborted() }
    }
    this.assertRegistry(registry)
    return { libraries, remainingCount: visible.length - libraries.length }
  }
  async list(input: CatalogInput = {}, signal?: AbortSignal) {
    const limit = integer(input.limit, 20, 50), registry = this.backend.snapshot(), revision = registryRevision(registry)
    const visible = await this.visible(registry, signal), filter = input.groupId ?? null
    const scope = protocolDigest([input.groupId === undefined ? 'all' : 'group', filter, visible.map(item => item.id)])
    let offset = 0
    if (input.cursor !== undefined) {
      try {
        const cursor = JSON.parse(Buffer.from(input.cursor, 'base64url').toString('utf8'))
        if (cursor.revision !== revision || cursor.scope !== scope || !Number.isSafeInteger(cursor.offset) || cursor.offset < 0) throw new Error()
        offset = cursor.offset
      } catch { throw discoveryError('CURSOR_EXPIRED', '目录游标已失效，请从第一页重新读取。') }
    }
    const positions = new Map(registry.libraries.map((library, index) => [library.id, index]))
    const groupOrders = new Map(registry.groups?.map(group => [group.id, group.order]))
    const ordered = visible.filter(item => input.groupId === undefined || (item.groupId ?? null) === filter).sort((a, b) =>
      Number(Boolean(b.pinned)) - Number(Boolean(a.pinned))
      || (groupOrders.get(a.groupId ?? '') ?? Number.MAX_SAFE_INTEGER) - (groupOrders.get(b.groupId ?? '') ?? Number.MAX_SAFE_INTEGER)
      || (a.order ?? positions.get(a.id)!) - (b.order ?? positions.get(b.id)!) || compareId(a.id, b.id))
    const libraries = []
    for (const library of ordered.slice(offset, offset + limit)) {
      let description = '', availability = 'available'
      try { description = this.card(library, await this.backend.metadata(library, signal)).short }
      catch { signal?.throwIfAborted(); availability = 'unavailable' }
      libraries.push({ libraryId: library.id, name: library.name, description, groupId: library.groupId ?? null,
        pinned: library.pinned ?? false, order: library.order ?? positions.get(library.id)!, availability, cardUri: cardUri(library.id) })
    }
    this.assertRegistry(registry)
    return { libraries, total: ordered.length, nextCursor: offset + limit < ordered.length
      ? Buffer.from(JSON.stringify({ revision, scope, offset: offset + limit })).toString('base64url') : null, registryRevision: revision }
  }
  async find(question: string, limit?: number, signal?: AbortSignal) {
    if (typeof question !== 'string' || !question.trim() || question.trim().length > 2000) throw discoveryError('INVALID_ARGUMENT', '问题须为 1～2000 字符。')
    const count = integer(limit, 3, 5), registry = this.backend.snapshot(), needles = [...terms(question)]
    const cards: (LibraryCard & { matchedFields: string[]; matchedTerms: string[]; score: number })[] = []
    const skipped: SkippedLibrary[] = [], versions: unknown[] = []
    for (const library of await this.visible(registry, signal)) {
      try {
        const metadata = await this.backend.metadata(library, signal), card = this.card(library, metadata)
        versions.push([library.id, metadata.publishedVersion, metadata.generation, card.summaryRevision])
        if (card.summaryStatus === 'review-required') { skipped.push({ libraryId: library.id, reason: 'SUMMARY_REVIEW_REQUIRED' }); continue }
        const fields = { name: card.name, short: card.short, long: card.long, topTopics: card.topTopics.join('\n') }
        const matchedFields: string[] = [], matchedTerms = new Set<string>()
        let score = 0
        for (const [field, text] of Object.entries(fields)) {
          const indexed = terms(text), found = needles.filter(term => indexed.has(term))
          if (found.length) { matchedFields.push(field); found.forEach(term => matchedTerms.add(term)); score += found.length * (field === 'name' ? 4 : field === 'topTopics' ? 3 : 1) }
        }
        if (score) cards.push({ ...card, matchedFields, matchedTerms: [...matchedTerms].sort(), score })
      } catch (error) {
        signal?.throwIfAborted()
        skipped.push({ libraryId: library.id, reason: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'LIBRARY_UNAVAILABLE' })
      }
    }
    this.assertRegistry(registry)
    const ranked = cards.sort((a, b) => b.score - a.score || compareId(a.libraryId, b.libraryId)).slice(0, count).map(({ score: _score, ...card }) => card)
    const result = { cards: ranked, selectionRevision: protocolDigest([registryRevision(registry), versions]), status: cards.length ? 'matched' as const : 'no-match' as const, skipped, truncated: cards.length > count }
    // 整个响应有界；大量离线库的详细原因留给分页目录逐项查看。
    while (Buffer.byteLength(JSON.stringify(result)) > 32768 && result.cards.length) { result.cards.pop(); result.truncated = true }
    while (Buffer.byteLength(JSON.stringify(result)) > 32768 && result.skipped.length) { result.skipped.pop(); result.truncated = true }
    return result
  }
  async resource(uri: string, signal?: AbortSignal) {
    const match = /^llmwiki:\/\/libraries\/([^/]+)\/card$/.exec(uri)
    if (!match) throw discoveryError('NOT_FOUND', '库卡片 URI 不存在。')
    let id: string
    try { id = decodeURIComponent(match[1]!) } catch { throw discoveryError('NOT_FOUND', '库卡片 URI 无效。') }
    return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(await this.show(id, signal)) }] }
  }
}
