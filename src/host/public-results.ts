import { redactValue } from '../llm/credentials.js'
import type { LibraryRegistration, Registry } from '../domain/config.js'
import type { ScanJob } from '../ingest/scanner.js'
import type { WikiQuery } from '../wiki/query.js'
import type { LibraryCard, LibraryDiscovery } from '../wiki/library-discovery.js'
import type { WikiAnswer } from '../wiki/chat.js'
import type { LocalHost } from '../local/host.js'
import type { WikiOperations } from './wiki-operations.js'
import type { UpgradeStatus } from '../layered/upgrade.js'
import type { generateLocalLayered } from './local-layered.js'
import type { copyLibraryWithEmbedding } from './query-vectors.js'
import type { SnapshotManifest, TopicGap } from '../layered/schema.js'
import type { EvidenceSegment } from '../wiki/page-search.js'
import type { AnswerEvidenceSegment } from '../wiki/answer-evidence.js'

type Result<T extends (...args: never[]) => unknown> = Awaited<ReturnType<T>>
type Search = Result<LocalHost['query']['search']>

/** 上下文由调用入口给出；未知内容默认遮蔽，只有对应 DTO 的控制字段可原样投影。 */
export function publicResult(value: unknown, secrets: readonly string[], operation?: string, replacement = '[已脱敏]'): unknown {
  const unsafe = <T>(item: T): T => redactValue(item, secrets, replacement)
  const project = <T extends object>(item: T, controls: Partial<Record<keyof T, unknown>>): T => ({ ...unsafe(item), ...controls })
  const card = (item: LibraryCard) => project(item, { libraryId: item.libraryId, publishedVersion: item.publishedVersion,
    summaryRevision: item.summaryRevision, summaryStatus: item.summaryStatus, cardUri: item.cardUri })
  const connection = <T extends { apiKey?: string | undefined }>(item: T) => { const { apiKey: _key, ...controls } = item; return controls }
  const layered = (item: LibraryRegistration['layered']) => {
    if (!item) return item
    const { writerTakeoverToken: _token, ...controls } = item
    return controls
  }
  const registration = (item: LibraryRegistration) => project(item, { id: item.id, kind: item.kind, mode: item.mode,
    wikiPath: item.wikiPath, sourceRoots: item.sourceRoots, vaultPath: item.vaultPath, kbId: item.kbId, catalogId: item.catalogId,
    groupId: item.groupId, publishedVersion: item.publishedVersion, summaryStatus: item.summaryStatus, models: item.models,
    layered: layered(item.layered), siyuan: item.siyuan, queryUnderstanding: item.queryUnderstanding,
    summary: item.summary && Object.fromEntries(Object.entries(item.summary).map(([tier, entry]) => [tier,
      entry && project(entry, { origin: entry.origin, sourceVersion: entry.sourceVersion })])) })
  const registry = (item: Registry) => project(item, { activeLibraryId: item.activeLibraryId, libraries: item.libraries.map(registration),
    groups: item.groups?.map(group => project(group, { id: group.id })), modelExecution: item.modelExecution,
    compatibleProviders: item.compatibleProviders && Object.fromEntries(Object.entries(item.compatibleProviders).map(([id, config]) => [id, connection(config)])),
    embeddingService: item.embeddingService && connection(item.embeddingService) })
  const scan = (item: ScanJob) => project(item, { id: item.id, libraryId: item.libraryId, stage: item.stage, createdAt: item.createdAt,
    files: item.files, errors: item.errors.map(error => project(error, { path: error.path })),
    excluded: item.excluded.map(entry => project(entry, { path: entry.path })) })
  const upgrade = (item: UpgradeStatus | null | undefined) => item && project(item, { id: item.id, status: item.status,
    backupPath: item.backupPath, originalFormat: item.originalFormat, inputDigest: item.inputDigest, files: item.files,
    reuse: item.reuse, steps: item.steps, accepted: item.accepted })
  const segments = (text: string, items: EvidenceSegment[] | undefined) => {
    const content = unsafe(text)
    // 文本改变后不能继续声称旧引用逐字对应；当前范围只展示遮蔽文本，须重新回源核实。
    if (content !== text) return [{ start: 0, end: content.length, anchor: '', locator: '', contextLocator: '', truncated: true, unverified: true, sources: [] }]
    return items?.map(entry => {
      const item = entry as EvidenceSegment & Partial<AnswerEvidenceSegment>
      return project(item, { anchor: item.anchor, locator: item.locator, contextLocator: item.contextLocator,
        sources: item.sources?.map(source => project(source, { sourceId: source.sourceId, sourceVersion: source.sourceVersion, path: source.path })) })
    })
  }
  const excerpt = (item: Search['results'][number]['excerpts'][number]) => project(item, { path: item.path, anchor: item.anchor,
    locator: item.locator, quote_hash: item.quote_hash, segments: segments(item.content, item.segments) })
  const hit = (item: Search['results'][number]) => project(item, { path: item.path, type: item.type, anchor: item.anchor,
    page_ref: item.page_ref, topic_path: item.topic_path, snippetSegments: segments(item.snippet, item.snippetSegments), excerpts: item.excerpts.map(excerpt),
    ...('status' in item ? { status: item.status, retrieval: item.retrieval, id: item.id, sources: item.sources, sourceVersions: item.sourceVersions,
      version: item.version, currentVersion: item.currentVersion } : {}) })
  const answer = (item: WikiAnswer) => project(item, { createdAt: item.createdAt, citations: item.citations.map(citation =>
    project(citation, { path: citation.path, hash: citation.hash, segments: segments(citation.excerpt, citation.segments), version: citation.version })) })
  const topicGap = (item: TopicGap) => project(item, { topic_id: item.topic_id, point_ids: item.point_ids, kind: item.kind,
    category: item.category, effect: item.effect, stage: item.stage,
    reasons: item.reasons?.map(reason => project(reason, { sentence_id: reason.sentence_id })) })
  switch (operation) {
    case 'catalog': {
      const item = value as { libraries: (Result<WikiQuery['catalog']>['libraries'][number] & { status?: string })[] }
      return project(item, { libraries: item.libraries.map(library => project(library, { libraryId: library.libraryId,
        path: library.path, mode: library.mode, status: library.status })) })
    }
    case 'directory/preview': {
      const item = value as Result<LibraryDiscovery['l0']>
      return project(item, { libraries: item.libraries.map(library => project(library, { libraryId: library.libraryId })) })
    }
    case 'wiki_list_libraries': {
      const item = value as Result<LibraryDiscovery['list']>
      return project(item, { registryRevision: item.registryRevision, nextCursor: item.nextCursor,
        libraries: item.libraries.map(library => project(library, { libraryId: library.libraryId, groupId: library.groupId,
          availability: library.availability, cardUri: library.cardUri })) })
    }
    case 'wiki_library_card': return card(value as LibraryCard)
    case 'wiki_find_library': {
      const item = value as Result<LibraryDiscovery['find']>
      return project(item, { selectionRevision: item.selectionRevision, status: item.status, cards: item.cards.map(card),
        skipped: item.skipped.map(entry => project(entry, { libraryId: entry.libraryId })) })
    }
    case 'registry': case 'groups/save': case 'registry/get': case 'organization/save': case 'organization/draft': case 'summary/confirm': {
      const item = value as { registry: Registry; registryRevision: string }
      return project(item, { registryRevision: item.registryRevision, registry: registry(item.registry) })
    }
    case 'registration': case 'wiki_register_library': case 'wiki_update_library': case 'summary/unlock': {
      const item = value as { registration: LibraryRegistration; registryRevision: string; libraryId?: string }
      return project(item, { registration: registration(item.registration), registryRevision: item.registryRevision,
        ...('libraryId' in item ? { libraryId: item.libraryId } : {}) })
    }
    case 'unregister': case 'wiki_unregister_library': {
      const item = value as { removed: boolean; registryRevision: string }
      return project(item, { removed: item.removed, registryRevision: item.registryRevision })
    }
    case 'groups/list': {
      const item = value as { groups: NonNullable<Registry['groups']>; registryRevision: string }
      return project(item, { groups: item.groups.map(group => project(group, { id: group.id })), registryRevision: item.registryRevision })
    }
    case 'registrations': return (value as LibraryRegistration[]).map(registration)
    case 'library': return registration(value as LibraryRegistration)
    case 'library/remove': {
      const item = value as { libraryId: string; removed: boolean; message: string }
      return project(item, { libraryId: item.libraryId })
    }
    case 'summary/refresh': {
      const item = value as { status: 'ready' | 'unchanged'; registryRevision?: string; calls?: number }
      return project(item, { status: item.status, ...('registryRevision' in item ? { registryRevision: item.registryRevision } : {}) })
    }
    case 'resources/list': {
      const item = value as { resources: { uri: string; name: string; description: string; mimeType: string }[]; nextCursor?: string }
      return project(item, { nextCursor: item.nextCursor, resources: item.resources.map(resource => project(resource,
        { uri: resource.uri, mimeType: resource.mimeType })) })
    }
    case 'resources/read': {
      const item = value as { contents: { uri: string; mimeType: string; text: string }[] }
      return { contents: item.contents.map(content => ({ uri: content.uri, mimeType: content.mimeType,
        text: JSON.stringify(card(JSON.parse(content.text) as LibraryCard)) })) }
    }
    case 'resources/templates/list': case 'local-job': return value
    case 'gaps': {
      const item = value as SnapshotManifest | undefined
      return [...(item?.gaps ?? []).map(gap => project(gap, { source_id: gap.source_id, status: gap.status })),
        ...(item?.topic_gaps ?? []).map(topicGap), ...(item?.term_gaps ?? []).map(gap => project(gap, { term_id: gap.term_id, section_id: gap.section_id })),
        ...(item?.point_label_gaps ?? []).map(gap => project(gap, { source_id: gap.source_id, point_ids: gap.point_ids }))]
    }
    case 'wiki_search': {
      const item = value as Search
      return project(item, { results: item.results?.map(hit), groups: item.groups.map(group => project(group, { libraryId: group.libraryId,
        confidence: group.confidence, results: group.results.map(hit) })), confidence: item.confidence,
        understanding: project(item.understanding, { status: item.understanding.status }),
        ...('selectionRevision' in item ? { selectionRevision: item.selectionRevision, selectedLibraries: item.selectedLibraries,
          selectionStatus: item.selectionStatus, skipped: item.skipped?.map(entry => project(entry, { libraryId: entry.libraryId })) } : {}) })
    }
    case 'wiki_browse': {
      const item = value as Result<WikiQuery['browse']>
      const node = (entry: typeof item.node) => project(entry, { path: entry.path, type: entry.type, parent: entry.parent, read_ref: entry.read_ref })
      return project(item, { version: item.version, next_cursor: item.next_cursor, node: node(item.node), children: item.children.map(node) })
    }
    case 'wiki_read': {
      const item = value as Result<WikiQuery['read']>
      return project(item, { path: item.path, type: item.type, ...('currentVersion' in item ? { currentVersion: item.currentVersion,
        version: item.version, status: item.status, sources: item.sources, sourceVersions: item.sourceVersions } : {}) })
    }
    case 'wiki_source_read': {
      const item = value as Result<WikiQuery['sourceRead']>
      return project(item, { sourceId: item.sourceId, locator: item.locator, status: item.status,
        ...('currentVersion' in item ? { currentVersion: item.currentVersion, version: item.version, sourceVersion: item.sourceVersion } : {}) })
    }
    case 'wiki_answer': {
      const item = value as WikiAnswer | Result<LocalHost['answerSelected']>
      return 'answers' in item ? project(item, { selectedLibraries: item.selectedLibraries, selectionRevision: item.selectionRevision,
        answers: item.answers.map(entry => ({ ...answer(entry), libraryId: entry.libraryId })) }) : answer(item)
    }
    case 'scan': return scan(value as ScanJob)
    case 'wiki_generate': case 'wiki_retry_topic_gaps': {
      const item = value as Result<WikiOperations['generate']>
      return project(item, { libraryId: item.libraryId, status: item.status,
        ...(item.scan ? { scan: 'files' in item.scan ? scan(item.scan) : project(item.scan, {
          sources: item.scan.sources, gaps: item.scan.gaps.map(gap => project(gap, { source_id: gap.source_id, status: gap.status })) }) } : {}),
        ...('version' in item ? { version: item.version, added: item.added } : {}),
        ...('jobId' in item ? { jobId: item.jobId, batchId: item.batchId } : {}),
        ...('backupPath' in item ? { backupPath: item.backupPath } : {}),
        ...('upgrade' in item ? { upgrade: upgrade(item.upgrade) } : {}) })
    }
    case 'generate': {
      const item = value as Result<typeof generateLocalLayered>
      return project(item, { libraryId: item.libraryId, status: item.status, version: item.version, added: item.added, batchId: item.batchId,
        ...('jobId' in item ? { id: item.id, jobId: item.jobId, backupPath: item.backupPath } : {}) })
    }
    case 'wiki_copy_with_embedding': {
      const item = value as Result<typeof copyLibraryWithEmbedding>
      return project(item, { path: item.path, libraryId: item.libraryId, sourceLibraryId: item.sourceLibraryId, identity: item.identity, version: item.version })
    }
    case 'wiki_status': {
      const item = value as Result<WikiOperations['productionStatus']>
      return project(item, { libraryId: item.libraryId, version: item.version, format: item.format, upgrade: upgrade(item.upgrade),
        topicGaps: item.topicGaps.map(topicGap), artifacts: item.artifacts.map(artifact => project(artifact, { artifactId: artifact.artifactId, path: artifact.path,
          kind: artifact.kind, status: artifact.status, inheritedFrom: artifact.inheritedFrom,
          productions: artifact.productions.map(production => project(production, { taskId: production.taskId, stage: production.stage,
            outputDigest: production.outputDigest, lineId: production.lineId, bindingRevision: production.bindingRevision,
            capabilityRevision: production.capabilityRevision, parentProductionIds: production.parentProductionIds })) })) })
    }
    case 'wiki_changes': {
      const item = value as Result<WikiOperations['changes']>
      return project(item, { libraryId: item.libraryId, status: item.status,
        ...(item.batches ? { batches: item.batches.map(batch => project(batch, { id: batch.id, status: batch.status, createdAt: batch.createdAt })),
          jobs: item.jobs.map(job => project(job, { id: job.id, status: job.status, batchId: job.batchId })) } : {}),
        ...('batchId' in item ? { batchId: item.batchId } : {}), ...(item.pages ? { digest: item.digest,
          pages: item.pages.map(page => project(page, { path: page.path })) } : {}),
        ...('backupPath' in item ? { backupPath: item.backupPath, upgrade: upgrade(item.upgrade) } : {}) })
    }
    case 'upgrade': return upgrade(value as UpgradeStatus)
    default: return unsafe(value)
  }
}
