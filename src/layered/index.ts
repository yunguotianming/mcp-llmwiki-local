import { canonicalVocabulary } from './tags.js'
import { buildConfiguration } from './build-configuration.js'
import { preparePointLabels } from './point-labels.js'
import { deferVectorStages, prepareVectorRun, sameExtractionContext, updateVectorCoverage } from './vector-build.js'
import { overviewLimits, reviewExtraction, reviewFingerprint, reviewNeedsRetry, reviewPolicy } from './review.js'
import { checkWriter, claimWriter } from './devices.js'
import { hydrateVectors, storageJson } from './vectors.js'
import { resumeReadingCopy } from './reading-copy.js'
import { collectGarbage } from './retention.js'
import path from 'node:path'
import { mapConcurrent } from '../llm/scheduler.js'
import { isModelTransportError } from '../llm/client.js'
import { defaultPolicy } from '../domain/policy.js'
import { readFile, readdir, unlink } from 'node:fs/promises'
import { parse } from 'yaml'
import { scanSourceFiles } from '../ingest/scanner.js'
import { matchSourceIdentities } from '../ingest/source-identity.js'
import { layeredSettings } from '../domain/config.js'
import { directory, safePath } from '../storage/paths.js'
import { resolveLibraryRoot } from '../storage/library-root.js'
import { readOptional } from '../storage/files.js'
import { advanceStorageGeneration, atomicWrite, hash, hashName, immutableWrite, withBuildLock, withStorageGeneration, writeJson } from './files.js'
import { extractSource, extractionFingerprint, extractionNeedsRetry, groupingFingerprint, planExtraction, resultFingerprint, reusableExtraction, extractionPromptHash, sameProcessing, reusableExtractionPlan, publishedExtractionUnchanged } from './extraction.js'
import { finishPublication, initializeLibrary, publishLibrary, readCurrent, readExtraction, readManifest } from './publication.js'
import { readLocalSource, segmentResources, snapshotSource } from './snapshot.js'
import { formatVersion } from './schema.js'
import { prepareTopics } from './topics.js'
import { prepareTerms } from './terms.js'
import { prepareTagMerges } from './tag-merges.js'
import { checkGeneration, readRevocations, revokeSourcesAtRoot } from './revocations.js'
import { validateSiyuanRoot } from './siyuan.js'
import { costMarkdown, meteredOptions, saveCosts } from './costs.js'
import { embedInputs } from './embedding.js'
import { validTimestamp } from './frontmatter.js'
import type { BuildLayeredOptions, Extraction, LibraryCard, PendingBuild, Processing, SourceEntry } from './schema.js'

interface IncrementalPending extends PendingBuild {
  reextract?: { request: 'all' | string[]; sources: string[]; started: string[]; completed: string[] }
  /** 用户显式重试缺口的意图随未完成作业保存；中断后继续时不需要再次选择。 */
  retry_gaps?: boolean
}

// 补标开关只影响独立阶段，不能阻止已有提取检查点续做。
function extractionContextWithoutPointLabels(context: NonNullable<PendingBuild['preview_context']>): NonNullable<PendingBuild['preview_context']> {
  try {
    const registration: unknown = JSON.parse(context.registrationKey)
    if (registration && typeof registration === 'object' && !Array.isArray(registration)
      && 'layered' in registration && registration.layered && typeof registration.layered === 'object' && !Array.isArray(registration.layered)) {
      delete (registration.layered as Record<string, unknown>).pointLabelsOnBuild
      if (!Object.keys(registration.layered).length) delete (registration as Record<string, unknown>).layered
      return { ...context, registrationKey: JSON.stringify(registration) }
    }
  } catch {}
  return context
}

export { preparePointLabels }
export { readLayeredPage, readLayeredDocument, readLayeredSource, revokeLayeredSources } from './revocations.js'
export { OllamaEmbeddingClient } from './embedding.js'
export { estimateLayeredBuild, truncateFairly } from './budget.js'
export type { EstimateInput, LayeredEstimate } from './budget.js'
export type { BuildLayeredOptions } from './schema.js'
export async function layeredInputBudget(options: Pick<BuildLayeredOptions, 'client' | 'maxInputBytes' | 'signal'>): Promise<number> {
  if (options.maxInputBytes !== undefined && (!Number.isSafeInteger(options.maxInputBytes) || options.maxInputBytes <= 0)) throw new Error('上下文输入预算必须为正整数。')
  const info = await options.client.info('ingest', options.signal, undefined, 'extract')
  const modelBudget = options.client.inputBudget ? await options.client.inputBudget('ingest', options.signal, 'extract')
    : info.context?.contextWindow === undefined ? undefined : info.context.contextWindow - (info.defaultMaxTokens || 4096)
  if (modelBudget === undefined) throw new Error('模型未声明上下文窗口，请到设置页“上下文上限”选择档位。')
  const inputLimit = options.maxInputBytes === undefined ? modelBudget : Math.min(modelBudget, options.maxInputBytes)
  if (inputLimit === undefined || !Number.isFinite(inputLimit) || inputLimit <= 0) throw new Error('模型未声明可用上下文或预算不足。请配置 buildLayeredLibrary.maxInputBytes（UTF-8 字节）；对照入口配置 compareWikiFlows.layered.maxInputBytes，或库设置的上下文上限 contextWindowTokens（对照入口 policy.contextWindowTokens，扣除输出预算）。')
  return inputLimit
}
export async function buildLayeredLibrary(options: BuildLayeredOptions): Promise<{ version: string; added: string[]; modelCalls: number; unchanged: boolean }> {
  layeredSettings(options.topics || {}, options.tier)
  const startedAt = new Date().toISOString()
  const knowledgeRoot = await directory(options.knowledgeRoot), tier = options.tier ?? 50
  if (options.siyuan) await validateSiyuanRoot(knowledgeRoot, options.siyuan.client.settings)
  if ((!Number.isSafeInteger(tier) || tier < 1 || tier > 2000) || options.promptVersion !== undefined && !options.promptVersion.trim()) throw new Error('提取档位或提示词版本无效。')
  if (options.maxInputBytes !== undefined && (!Number.isSafeInteger(options.maxInputBytes) || options.maxInputBytes <= 0)) throw new Error('上下文输入预算必须为正整数。')
  const existingRoot = options.siyuan ? knowledgeRoot : await resolveLibraryRoot(knowledgeRoot, options.wikiPath, options.topics === false ? { embeddingMode: 'none' } : options.topics ?? {})
  try { await checkWriter(existingRoot, layeredSettings(options.topics || {}, options.tier).writerTakeoverToken) }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
  return await withBuildLock(knowledgeRoot, async () => {
    options.signal?.throwIfAborted()
    const initialCard: LibraryCard = { name: options.name ?? path.basename(knowledgeRoot), domain: options.domain ?? '', origin_type: options.siyuan ? 'siyuan' : 'local',
      source_type: options.sourceType ?? 'Markdown 资料', default_credibility: options.defaultCredibility ?? 'unknown', source_count: 0, updated_at: new Date().toISOString(), format_version: formatVersion }
    const settingsForWriter = layeredSettings(options.topics || {}, options.tier)
    const root = await initializeLibrary(knowledgeRoot, initialCard, settingsForWriter.writerTakeoverToken, options.legacyLibraryAction, existingRoot)
    await claimWriter(root, settingsForWriter.writerTakeoverToken)
    return withStorageGeneration(root, async () => {
    const current = await readCurrent(root)
    let pending = await hydrateVectors(root, await readOptional<IncrementalPending>(await safePath(root, 'work/pending.json')), true)
    if (pending?.version && pending.version === current?.version) {
      await finishPublication(root, pending); pending = undefined
      await unlink(await safePath(root, 'work/preview.json')).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
    const preview = await readOptional<{ version: string }>(await safePath(root, 'work/preview.json'))
    if (preview) {
      if (options.publish !== false || pending?.version !== preview.version) throw new Error('该库已有分层预览，请先提交或取消后再生成。')
      return { version: preview.version, added: pending.added, modelCalls: 0, unchanged: false }
    }
    await resumeReadingCopy(root, current?.version)
    if (await readOptional(await safePath(root, 'state/gc-pending.json'))) await collectGarbage(root)
    let committed = await readManifest(root, current)
    if (pending && (pending.format_version !== formatVersion || pending.base_version !== (current?.version ?? null))) throw new Error('待更新清单基线不匹配，已保留现场。')
    const card: LibraryCard = { ...initialCard, ...parse(await readFile(await safePath(root, 'library.yaml'), 'utf8')) }
    if (card.origin_type !== initialCard.origin_type) throw new Error('库的来源载体与建库配置不一致。')
    const originalCard = JSON.stringify(card)
    card.name = options.name ?? card.name; card.domain = options.domain ?? card.domain
    card.source_type = options.sourceType ?? card.source_type; card.default_credibility = options.defaultCredibility ?? card.default_credibility
    pending ??= { format_version: formatVersion, base_version: current?.version ?? null, version: null, manifest: structuredClone(committed), card,
      added: [], model_calls: 0, started_at: startedAt }
    if (options.previewContext) {
      if (pending.preview_context && !sameExtractionContext(extractionContextWithoutPointLabels(pending.preview_context), extractionContextWithoutPointLabels(options.previewContext))) throw new Error('未完成分层作业的登记或策略已变化，请恢复原设置后继续。')
      pending.preview_context = options.previewContext
    }
    pending.card = card
    pending.changes ??= {}
    if (options.retryGaps && !(pending as IncrementalPending).retry_gaps) { (pending as IncrementalPending).retry_gaps = true; await writeJson(root, 'work/pending.json', pending) }
    if ((pending as IncrementalPending).retry_gaps) options = { ...options, retryGaps: true }
    const change = (kind: string, id: string) => { const ids = pending.changes![kind] ??= []; if (!ids.includes(id)) ids.push(id) }
    let vectorRun: Promise<BuildLayeredOptions> | undefined, vectorClient: BuildLayeredOptions['embeddingClient'], vectorTopics: BuildLayeredOptions['topics']
    const measured = meteredOptions(root, pending, { ...options, embeddingClient: {
      identity: signal => vectorClient!.identity!(signal), embed: (inputs, signal) => vectorClient!.embed(inputs, signal),
    } })
    const initializeVectors = async (hasInputs = true) => {
      const resolved = await (vectorRun ??= prepareVectorRun(root, pending, committed, options, hasInputs))
      vectorClient = resolved.embeddingClient
      vectorTopics = resolved.topics
      if (resolved.vectorIdentity) measured.vectorIdentity = resolved.vectorIdentity
      measured.vectorDeferred ||= resolved.vectorDeferred ?? false
    }
    if (pending.paused) { delete pending.paused; await writeJson(root, 'work/pending.json', pending) }
    if (options.siyuan) await options.siyuan.checkAdmission(root, options.signal)
    let revocations = await readRevocations(root)
    advanceStorageGeneration(root, revocations.generation)
    if (pending.manifest.revocation_generation < revocations.generation) {
      committed = await readManifest(root, current)
      pending.manifest = structuredClone(committed); pending.added = []
      delete pending.topics; delete pending.terms
    }
    const revokedIds = new Set(revocations.sources.filter(item => (pending.manifest.sources.find(source => source.source_id === item.source_id)?.revocation_generation ?? -1) < item.generation).map(item => item.source_id))
    pending.manifest.sources = pending.manifest.sources.filter(source => !revokedIds.has(source.source_id))
    pending.manifest.revocation_generation = revocations.generation
    pending.manifest.next_source_number = Math.max(pending.manifest.next_source_number, ...revocations.sources.filter(item => /^S-\d+$/.test(item.source_id)).map(item => Number(item.source_id.slice(2)) + 1))
    pending.added = pending.added.filter(id => !revokedIds.has(id))
    // 作业先登记，再扫描或封存对象；GC 在检查点存续期间保留在建对象。
    await writeJson(root, 'work/pending.json', pending)
    const scanned = options.siyuan ? { inputs: [], errors: [] } : await scanSourceFiles([knowledgeRoot], root, options.signal)
    if (scanned.errors.length) throw new Error('扫描失败：' + scanned.errors.map(error => `${error.path}：${error.message}`).join('；'))
    const key = (relative: string) => process.platform === 'win32' ? relative.toLowerCase() : relative
    const revokedPaths = new Set(revocations.sources.filter(item => !item.deleted).flatMap(item => [item.current_path, ...(item.alias_paths ?? [])].map(key)))
    const inputs = scanned.inputs.filter(input => /\.(md|markdown)$/i.test(input.actual) && !revokedPaths.has(key(path.relative(knowledgeRoot, input.actual).replaceAll('\\', '/'))))
    const remote = options.siyuan ? await options.siyuan.scan(root, options.signal) : undefined
    if (remote) pending.manifest.gaps = remote.gaps
    let sources = remote?.sources ?? await Promise.all(inputs.map(input => readLocalSource(input.actual, card.source_type)))
    const relativePath = (source: typeof sources[number]) => source.sourceId ? source.path : path.relative(knowledgeRoot, source.path).replaceAll('\\', '/')
    const sourceKey = (source: typeof sources[number]) => source.sourceId ?? source.contentHash
    const byPath = new Map<string, SourceEntry>()
    const aliasPaths = new Map<string, string[]>()
    const duplicateSources = new Map<string, typeof sources>()
    let deleted: SourceEntry[]
    if (remote) {
      const live = new Set(sources.map(sourceKey))
      deleted = pending.manifest.sources.filter(entry => !live.has(entry.source_id))
      for (const entry of pending.manifest.sources) byPath.set(entry.source_id, entry)
    } else {
      const matched = matchSourceIdentities(sources.map(source => ({ source, path: relativePath(source), hash: source.contentHash, segments: source.segments.map(segment => segment.text_hash) })),
        pending.manifest.sources.map(entry => ({ entry, id: entry.source_id, path: entry.current_path, aliases: entry.alias_paths, hash: entry.content_hash, segments: entry.segments.map(segment => segment.text_hash) })),
        layeredSettings(options.topics || {}, options.tier).sourceMatchThreshold)
      sources = matched.groups.map(group => group.documents[0]!.source)
      deleted = matched.deleted.map(record => record.entry)
      for (const group of matched.groups) {
        const source = group.documents[0]!.source, previous = group.previous?.entry
        const aliases = group.documents.slice(1).map(document => document.path).sort()
        aliasPaths.set(sourceKey(source), aliases)
        duplicateSources.set(sourceKey(source), group.documents.slice(1).map(document => document.source))
        if (previous) {
          byPath.set(sourceKey(source), previous)
          if (JSON.stringify(previous.alias_paths ?? []) !== JSON.stringify(aliases)) {
            const currentPaths = new Set(group.documents.map(document => document.path))
            previous.previous_paths = [...new Set([...previous.previous_paths, ...(previous.alias_paths ?? []).filter(file => !currentPaths.has(file))])]
            previous.alias_paths = aliases; change('别名', previous.source_id)
          }
        }
      }
    }
    for (const source of sources) {
      const previous = byPath.get(sourceKey(source)), relative = relativePath(source)
      if (previous && previous.current_path !== relative) {
        previous.previous_paths = [...new Set([...previous.previous_paths, previous.current_path])]
        previous.current_path = relative; change('改名', previous.source_id)
      }
    }
    // 直接发布仍立即撤权；本地预览把删除留到确认时，查询继续读取当前版。
    if (deleted.length) {
      if (options.publish === false) pending.deleted_sources = [...new Set([...(pending.deleted_sources ?? []), ...deleted.map(entry => entry.source_id)])]
      else {
      revocations = await revokeSourcesAtRoot(root, deleted.map(entry => entry.source_id), options.siyuan ? '思源来源已移出导出集合或出现导出缺口' : '本地来源删除或移出资料目录', !options.siyuan)
      advanceStorageGeneration(root, revocations.generation)
      }
      for (const entry of deleted) change('删除', entry.source_id)
      pending.manifest.sources = pending.manifest.sources.filter(entry => !deleted.includes(entry))
      committed = await readManifest(root, current)
      pending.manifest = { ...structuredClone(committed), sources: pending.manifest.sources, next_source_number: pending.manifest.next_source_number }
      delete pending.topics; delete pending.terms
    }
    pending.manifest.revocation_generation = revocations.generation
    if (deleted.length) await writeJson(root, 'work/pending.json', pending)
    const processing: Processing = { tier, ...(options.granularity ? { granularity: options.granularity } : {}), prompt_version: options.promptVersion ?? 'layered-extract-v5', prompt_hash: extractionPromptHash(), ...(options.imagePolicy === 'images' ? { image_policy: 'images' as const } : {}) }
    const settings = layeredSettings(vectorTopics || options.topics || {}, options.tier)
    pending.manifest.tag_policy = { limit: settings.tagLimit, only: settings.tagVocabularyOnly, vocabulary: options.tagVocabulary ?? [] }
    measured.vocabulary = canonicalVocabulary([...(options.tagVocabulary ?? []), ...committed.sources.flatMap(source => source.tags ?? [])],
      Object.values(committed.deps?.pages ?? {}).flatMap(page => page.terms ?? []), committed.tag_merges)
    const inputLimit = Math.min(await layeredInputBudget(options), settings.extractMaxInputBytes)
    let changed = committed.anchor_format !== 'obsidian-block-v1' || !committed.page_created
      || Object.keys(committed.pages ?? {}).some(page => !validTimestamp(committed.page_created?.[page]))
      || storageJson(pending.manifest) !== storageJson(committed) || JSON.stringify(card) !== originalCard, modelCalls = 0
    const extractionAttemptStart = options.client.attempts?.length ?? 0
    pending.source_ids ??= {}
    let allocated = false
    for (const source of sources) {
      const identity = sourceKey(source)
      if (!byPath.has(identity) && !pending.source_ids[identity]) {
        pending.source_ids[identity] = source.sourceId ?? 'S-' + String(pending.manifest.next_source_number++).padStart(4, '0')
        allocated = true
      }
    }
    if (allocated) await writeJson(root, 'work/pending.json', pending)
    const requestedReextract = options.reextract === 'all' ? 'all' : options.reextract === undefined ? undefined : [...new Set(options.reextract)].sort()
    if (requestedReextract !== undefined) {
      if (requestedReextract !== 'all' && (!requestedReextract.length || requestedReextract.some(id => typeof id !== 'string' || !id.trim()))) throw new Error('重新提取须选择全部来源或非空来源 ID 列表。')
      if (pending.reextract && JSON.stringify(pending.reextract.request) !== JSON.stringify(requestedReextract)) throw new Error('待续做作业的重新提取范围不同，请先完成当前作业。')
      if (!pending.reextract) {
        const available = sources.map(source => byPath.get(sourceKey(source))?.source_id ?? pending.source_ids![sourceKey(source)]!)
        const selected = requestedReextract === 'all' ? available : requestedReextract
        if (selected.some(id => !available.includes(id))) throw new Error('重新提取的来源 ID 不在当前扫描范围内。')
        pending.reextract = { request: requestedReextract, sources: [...selected].sort(), started: [], completed: [] }
        await writeJson(root, 'work/pending.json', pending)
      }
    }
    await mapConcurrent(sources, options.client.concurrency?.() ?? defaultPolicy().pageGenerationConcurrency, options.signal ?? new AbortController().signal, async (source, signal) => {
      signal.throwIfAborted()
      const relative = relativePath(source), previous = byPath.get(sourceKey(source))
      const sourceId = previous?.source_id ?? pending.source_ids![sourceKey(source)]!
      const files = source.files ?? await snapshotSource(root, knowledgeRoot, sourceId, source)
      for (const duplicate of duplicateSources.get(sourceKey(source)) ?? []) {
        const duplicateFiles = await snapshotSource(root, knowledgeRoot, sourceId, duplicate)
        if (JSON.stringify(duplicateFiles.assets) !== JSON.stringify(files.assets)) throw new Error('同正文路径的附件内容不同，不能合并为完全相同的副本：' + relativePath(duplicate))
      }
      const resources = [...new Set(files.assets.map(asset => asset.hash))].sort()
      const segmentAssets = processing.image_policy ? segmentResources(source, files) : source.segments.map(() => [])
      const readCache = async (relative: string) => {
        try { return await readOptional<Extraction>(await safePath(root, relative)) }
        catch (error) { if (error instanceof SyntaxError) return undefined; throw error }
      }
      const previousResult = previous ? await readCache(previous.extract.path) : undefined
      const progressDirectory = `work/extractions/${sourceId}/${hashName(source.contentHash)}/extract`
      let savedProgress: Extraction | undefined
      for (const name of await readdir(await safePath(root, progressDirectory)).catch(error => { if (error.code === 'ENOENT') return []; throw error })) {
        if (!name.endsWith('-progress.json')) continue
        const candidate = await readCache(progressDirectory + '/' + name)
        if (candidate?.in_progress && candidate.source_id === sourceId && candidate.source_hash === source.contentHash
          && reusableExtractionPlan(candidate, sourceId, source, processing, options, inputLimit, settings, measured.vocabulary)) { savedProgress = candidate; break }
      }
      const publishedUnchanged = publishedExtractionUnchanged(previousResult, sourceId, source, processing, options, settings)
        && sameProcessing(previousResult!.processing, previous!.extract.processing) && resultFingerprint(previousResult!) === previous!.extract.processing_fingerprint
        && (!processing.image_policy || JSON.stringify(previous?.resource_version) === JSON.stringify(resources))
      const force = Boolean(pending.reextract?.sources.includes(sourceId) && !pending.reextract.completed.includes(sourceId))
      let plan: ReturnType<typeof planExtraction> = [], planningFailure: unknown
      try { plan = publishedUnchanged && !force ? previousResult!.chunk_plan! : reusableExtractionPlan(savedProgress ?? previousResult, sourceId, source, processing, options, inputLimit, settings, measured.vocabulary)
        ?? planExtraction(sourceId, source, processing, inputLimit, settings, measured.vocabulary) }
      catch (error) { planningFailure = error }
      const fingerprint = publishedUnchanged && !force ? previous!.extract.processing_fingerprint : extractionFingerprint(source, processing, segmentAssets, groupingFingerprint(plan, settings))
      if (!force && previous?.content_hash === source.contentHash && previous.extract.processing_fingerprint === fingerprint && (!source.siyuan || previous.siyuan?.references_hash === source.siyuan.references_hash) && (publishedUnchanged || sameProcessing(previous.extract.processing, processing))
        && reusableExtraction(previousResult) && previousResult.source_id === sourceId && previousResult.source_hash === source.contentHash
        && (publishedUnchanged || sameProcessing(previousResult.processing, processing)) && !extractionNeedsRetry(previousResult, true) && !(options.retryGaps && (extractionNeedsRetry(previousResult) || reviewNeedsRetry(previousResult))) && [reviewPolicy(options), reviewPolicy(options, true)].includes(previousResult.review_policy ?? '') && JSON.stringify(previousResult.overview_limits) === JSON.stringify(overviewLimits(options))
        && (!processing.image_policy || JSON.stringify(previous.resource_version) === JSON.stringify(resources))) {
        if (source.siyuan && source.sourceVersion !== previous.source_version) {
          const rebound = await readExtraction(root, previous.extract.path)
          for (const segment of rebound.segments) for (const point of segment.points) {
            point.source_version = source.sourceVersion!
            for (const evidence of point.evidence) evidence.source_version = source.sourceVersion!
          }
          const reboundPath = `objects/snapshots/${sourceId}/${hashName(source.contentHash)}/extract/${hashName(previous.extract.processing_fingerprint)}-${hashName(hash(source.sourceVersion!))}.json`
          await immutableWrite(root, reboundPath, Buffer.from(JSON.stringify(rebound, null, 2) + '\n'))
          previous.source_version = source.sourceVersion!; previous.extract.path = reboundPath; changed = true; change('元数据', sourceId)
        }
        if (source.siyuan) {
          // 同语义内容保留已有提取投影；原始快照另存，版本与路径独立刷新。
          const newInput = source.siyuan.input
          source.siyuan.input = previous.siyuan!.input
          source.siyuan.objects = [...source.siyuan.objects.filter(item => item.path !== newInput), ...previous.siyuan!.objects.filter(item => item.path === previous.siyuan!.input)]
          if (JSON.stringify(previous.siyuan) !== JSON.stringify(source.siyuan)) { previous.siyuan = source.siyuan; changed = true }
        }
        if (JSON.stringify(previous.files) !== JSON.stringify(files)) {
          previous.files = files; previous.resource_version = resources; changed = true; change('附件', sourceId)
        }
        return
      }
      const versionSuffix = source.sourceVersion ? '-' + hashName(hash(source.sourceVersion)) : ''
      const expectedPath = `objects/snapshots/${sourceId}/${hashName(source.contentHash)}/extract/${hashName(fingerprint)}${versionSuffix}.json`
      let extractPath = expectedPath
      const progressPath = expectedPath.replace('objects/snapshots/', 'work/extractions/').replace(/\.json$/, '-progress.json')
      if (force && !pending.reextract!.started.includes(sourceId)) {
        // 新的显式重提不继承之前的半成品；本次开始后保留检查点供跨模型续做。
        for (const file of [progressPath, progressPath.replace('-progress.json', '-review.json')]) {
          await unlink(await safePath(root, file)).catch(error => { if (error.code !== 'ENOENT') throw error })
        }
        pending.reextract!.started.push(sourceId); pending.reextract!.started.sort()
        await writeJson(root, 'work/pending.json', pending)
      }
      const latestFailure = previous?.content_hash === source.contentHash && previous.extract.processing_fingerprint === fingerprint
        && reusableExtraction(previousResult) && extractionNeedsRetry(previousResult) ? previousResult : undefined
      let extraction = await readCache(progressPath) ?? (force ? undefined : latestFailure ?? (previous?.extract.processing_fingerprint === fingerprint && reusableExtraction(previousResult) ? previousResult : undefined) ?? await readCache(expectedPath))
      const reusable = reusableExtraction(extraction)
      if (extraction && reusable && (extraction.source_id !== sourceId || extraction.source_hash !== source.contentHash || !sameProcessing(extraction.processing, processing))) throw new Error('已保存提取结果的身份或处理指纹不匹配。')
      if (!extraction || !reusable || extraction.in_progress || extractionNeedsRetry(extraction)) {
        const savedCalls = reusable && extraction?.in_progress ? extraction.calls.length : 0
        const oldExtraction = extraction ?? (force ? undefined : previousResult)
        extraction = await extractSource(root, sourceId, source, processing, { ...measured, signal,
          taskModelIdentity: force ? { context: measured.taskModelIdentity, reextractJob: pending.started_at } : measured.taskModelIdentity }, inputLimit, oldExtraction, segmentAssets,
          async indices => {
            const hashes = new Set(indices.flatMap(index => segmentAssets[index]!))
            if (!hashes.size) return []
            if (!options.loadImage) throw new Error('使用图片提取需要注入 loadImage 图片加载器。')
            return await Promise.all([...hashes].map(async resource => {
              const asset = files.assets.find(item => item.hash === resource)!
              return await options.loadImage!(await readFile(await safePath(root, asset.path)), path.basename(asset.original_path), options.signal)
            }))
          }, plan)
        if (planningFailure) extraction.gaps!.push({ kind: 'group', segment_hashes: source.segments.map(segment => segment.text_hash), item: null,
          reasons: [{ rule: 'extract-plan', expected: '来源可按输入上限分组', actual: String(planningFailure) }] })
        const actualFingerprint = resultFingerprint(extraction)
        let actualPath = `objects/snapshots/${sourceId}/${hashName(source.contentHash)}/extract/${hashName(actualFingerprint)}${versionSuffix}.json`
        const partial = await readCache(actualPath)
        if (reusableExtraction(partial) && partial.in_progress && partial.source_id === sourceId && partial.source_hash === source.contentHash) await writeJson(root, actualPath, extraction)
        else {
          // 重试发布独立成果，旧版本引用的失败留痕仍保持不可变。
          if (await readFile(await safePath(root, actualPath)).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })
            && (!reusableExtraction(partial) || extractionNeedsRetry(partial) || force)) actualPath = actualPath.replace(/\.json$/, '-' + hashName(hash(JSON.stringify(extraction))) + '.json')
          await immutableWrite(root, actualPath, Buffer.from(JSON.stringify(extraction, null, 2) + '\n'))
        }
        extractPath = actualPath
        await unlink(await safePath(root, progressPath)).catch(error => { if (error.code !== 'ENOENT') throw error })
        const addedCalls = extraction.calls.length - savedCalls
        modelCalls += addedCalls; pending.model_calls += extraction.calls.length
      }
      // 核对与概览独立于提取缓存；改变这些开关不重发原文提取。
      const reviewPath = progressPath.replace('-progress.json', '-review.json')
      const savedReview = await readCache(reviewPath)
      extraction = structuredClone(reusableExtraction(savedReview) && !extractionNeedsRetry(savedReview, !options.retryGaps) && savedReview.source_hash === source.contentHash
        && savedReview.source_id === sourceId && resultFingerprint(savedReview) === resultFingerprint(extraction) ? savedReview : extraction)
      const priorReviews = new Map((!force && reusableExtraction(previousResult) ? previousResult : undefined)?.segments.flatMap(segment => segment.points).filter(point => point.verification)
        .map(point => [reviewFingerprint(point), point.verification!] as const) ?? [])
      for (const point of extraction.segments.flatMap(segment => segment.points)) {
        const prior = priorReviews.get(reviewFingerprint(point))
        if (prior && !point.verification) point.verification = structuredClone(prior)
      }
      const reviewCalls = await reviewExtraction(extraction, source, { ...measured, signal }, inputLimit,
        async () => { signal.throwIfAborted(); await writeJson(root, reviewPath, extraction) })
      signal.throwIfAborted()
      modelCalls += reviewCalls; pending.model_calls += reviewCalls
      const reviewedPath = expectedPath.replace(/\.json$/, '-quality-' + hashName(hash(JSON.stringify(extraction))) + '.json')
      await immutableWrite(root, reviewedPath, Buffer.from(JSON.stringify(extraction, null, 2) + '\n'))
      extractPath = reviewedPath
      const actualFingerprint = resultFingerprint(extraction)
      const entry: SourceEntry = { source_id: sourceId, origin_type: source.siyuan ? 'siyuan' : 'local', current_path: relative, previous_paths: previous?.previous_paths ?? [],
        ...(aliasPaths.get(sourceKey(source))?.length ? { alias_paths: aliasPaths.get(sourceKey(source))! } : {}), models: extraction.models ?? [],
        ...(previous ? { created_at: previous.created_at ?? previous.updated_at } : {}),
        logical_source_id: previous?.logical_source_id ?? sourceId,
        content_hash: source.contentHash, source_version: source.sourceVersion ?? source.contentHash, resource_version: resources, segments: source.segments,
        metadata: extraction.metadata, files, extract: { path: extractPath, processing: extraction.processing, processing_fingerprint: actualFingerprint },
        revocation_generation: source.siyuan ? revocations.generation : 0, updated_at: pending.started_at, ...(source.siyuan ? { siyuan: source.siyuan } : {}) }
      pending.manifest.sources = pending.manifest.sources.filter(item => item.source_id !== sourceId)
      pending.manifest.sources.push(entry); pending.manifest.sources.sort((left, right) => left.source_id.localeCompare(right.source_id))
      if (!previous) { pending.added.push(sourceId); pending.added.sort() }
      change(previous ? '修改' : '新增', sourceId)
      byPath.set(sourceKey(source), entry); changed = true
      if (force) { pending.reextract!.completed.push(sourceId); pending.reextract!.completed.sort() }
      await writeJson(root, 'work/pending.json', pending)
      await unlink(await safePath(root, reviewPath)).catch(error => { if (error.code !== 'ENOENT') throw error })
      // 来源完成全部提取、补提和语义支撑核对后立即预嵌入已核实要点，只暖缓存，不提前聚类。
      if (options.topics !== false && settings.embeddingMode !== 'none' && !measured.vectorDeferred) {
        const verified = extraction.segments.flatMap(segment => segment.points)
          .filter(point => point.verification?.status !== 'unverified').map(point => point.text)
        if (verified.length) try {
          await initializeVectors()
          if (measured.vectorDeferred) return
          await embedInputs(root, verified, layeredSettings(vectorTopics || {}, options.tier), measured.embeddingClient!, signal,
            options.client.concurrency?.() ?? defaultPolicy().pageGenerationConcurrency, measured.vectorIdentity)
        } catch (cause) {
          signal.throwIfAborted()
          measured.vectorDeferred = true
          pending.manifest.vector_state!.message = '向量服务不可用，已保留要点，等待补齐嵌入。'
          if (settings.embeddingUnavailable === 'pause') {
            pending.paused = { reason: 'embedding', message: (pending.manifest.vector_state?.mode === 'cloud' ? '云端向量服务不可用，主题聚类已暂停。' : '本地向量模型不可用，主题聚类已暂停。')
              + (!pending.manifest.vector_state?.identity && cause instanceof Error ? cause.message : ''), at: new Date().toISOString() }
            await updateVectorCoverage(root, pending)
            await writeJson(root, 'work/pending.json', pending)
            throw new Error(pending.paused.message, { cause })
          }
        }
      }
    })
    const extractionAttempts = (options.client.attempts ?? []).slice(extractionAttemptStart)
    const extractionCalls = extractionAttempts.filter(attempt => !attempt.structuredSchemaKind || attempt.structuredSchemaKind === 'extraction')
    const protocolFailures = extractionCalls.filter(attempt => attempt.error && !isModelTransportError({ message: attempt.error, status: attempt.status }) && (attempt.status !== undefined && attempt.status >= 400 && attempt.status < 600
      || /schema|required|additionalproperties|structured|strict|invalid request|\b[45]\d\d\b/i.test(attempt.error)))
    const completedExtraction = extractionCalls.filter(attempt => attempt.finish === 'stop').length
    if (protocolFailures.length > extractionCalls.length / 2) {
      const first = protocolFailures[0]!.error!.replace(/(?:sk-|Bearer\s+)[A-Za-z0-9._-]+/gi, '[凭据已隐藏]')
        .replace(/((?:api[_-]?key|token|authorization)["']?\s*[:=]\s*["']?)[^\s"',;}]*/gi, '$1[凭据已隐藏]').slice(0, 600)
      throw new Error(`提取调用因结构化输出协议或服务端拒绝而中止（失败 ${protocolFailures.length}，成功 ${completedExtraction}）。首个服务端错误：${first}`)
    }
    if (options.siyuan) { await options.siyuan.checkAdmission(root, options.signal); await checkGeneration(root, pending.manifest.revocation_generation) }
    const hasVectorInputs = (await Promise.all(pending.manifest.sources.map(source => readExtraction(root, source.extract.path))))
      .some(extract => extract.segments.some(segment => segment.terms.length || segment.points.some(point => point.verification?.status !== 'unverified')))
    await initializeVectors(hasVectorInputs)
    // 全部来源完成后再应用向量配置，避免预嵌入时补齐的默认值改变在途提取分包指纹。
    measured.topics = vectorTopics ?? {}
    const configuration = buildConfiguration(layeredSettings(vectorTopics || {}, options.tier))
    // 旧库首次补齐向量身份也需要发布，不能被来源未变化的快路径丢弃。
    changed ||= pending.manifest.vector_state?.generation !== committed.vector_state?.generation
    // 来源及处理规则已逐项核对；旧版未保存全局配置时只接纳默认配置。
    // 关闭主题时旧版遗留的待嵌入队列不构成内容变化。
    if (!changed && current && (committed.build_configuration ?? buildConfiguration(layeredSettings({}, options.tier))) === configuration && !options.retryGaps && !pending.reextract
      && !pending.manifest.tag_merge_gap
      && !pending.topics && !pending.terms && !Object.values(committed.deps?.pages ?? {}).some(page => page.terms?.some(term => term.sections.some(section => section.queued)))
      && (options.topics === false || !pending.manifest.vector_state?.coverage.missing.length && !pending.manifest.vector_state?.pending_points.length)) {
      await checkGeneration(root, pending.manifest.revocation_generation)
      await unlink(await safePath(root, 'work/pending.json'))
      return { version: current.version, added: [], modelCalls: 0, unchanged: true }
    }
    pending.manifest.build_configuration = configuration
    // 词项主题依赖补标；语义模式保持原有阶段并行及预算顺序。
    const lexicalLabels = pending.manifest.vector_state?.mode === 'none' && options.topics !== false
      ? preparePointLabels(root, pending, measured) : undefined
    const vectorStages = (async () => {
      if (lexicalLabels) await lexicalLabels
      if (measured.vectorDeferred) { await deferVectorStages(root, pending, committed, measured); return }
      try {
        const topics = await prepareTopics(root, pending, committed, measured, options.maxInputBytes)
        changed ||= topics.changed; modelCalls += topics.modelCalls
        const terms = pending.manifest.vector_state?.mode === 'none'
          ? (await deferVectorStages(root, pending, committed, measured, true), { changed: false, modelCalls: 0 })
          : await prepareTerms(root, pending, committed, measured, options.maxInputBytes)
        changed ||= terms.changed; modelCalls += terms.modelCalls
        await updateVectorCoverage(root, pending)
      } catch (error) {
        options.signal?.throwIfAborted()
        if (pending.manifest.vector_state?.mode === 'none' || !(error instanceof Error && /向量|嵌入/.test(error.message))) throw error
        measured.vectorDeferred = true
        await deferVectorStages(root, pending, committed, measured)
      }
    })()
    const requiredStages = vectorStages.then(async () => {
      const tags = await prepareTagMerges(root, pending, measured)
      changed ||= tags.changed; modelCalls += tags.modelCalls
    })
    // 使用向量时默认跳过补标；无向量或显式启用时独立补标，不改变提取缓存。
    // 语义模式有总预算时先保证主题及来源标签；词项模式先补标，额度不足按正文聚类。
    const labelStage = lexicalLabels ?? (settings.embeddingMode === 'none' || settings.pointLabelsOnBuild
      ? settings.maxBuildCalls || settings.maxBuildTokens
        ? requiredStages.then(() => preparePointLabels(root, pending, measured)) : preparePointLabels(root, pending, measured)
      : Promise.resolve({ changed: false, modelCalls: 0 }))
    const stages = await Promise.allSettled([labelStage, requiredStages])
    for (const stage of stages) if (stage.status === 'rejected') throw stage.reason
    const labels = stages[0]
    if (labels.status === 'fulfilled') { changed ||= labels.value.changed; modelCalls += labels.value.modelCalls }
    changed ||= JSON.stringify(pending.manifest.vector_state) !== JSON.stringify(committed.vector_state)
    if (!changed && current) {
      await checkGeneration(root, pending.manifest.revocation_generation)
      await saveCosts(root, pending, 'unchanged-' + pending.started_at)
      const log = await readFile(await safePath(root, 'logs/build.md'), 'utf8')
      await atomicWrite(root, 'logs/build.md', log + `\n### 无变化运行 ${pending.started_at}\n\n${costMarkdown(pending.costs!)}`)
      await unlink(await safePath(root, 'work/pending.json')).catch(error => { if (error.code !== 'ENOENT') throw error })
      return { version: current.version, added: [], modelCalls: 0, unchanged: true }
    }
    if (options.siyuan) await options.siyuan.checkAdmission(root, options.signal)
    const version = await publishLibrary(root, pending, options.signal, options.publish !== false, measured)
    return { version, added: pending.added, modelCalls, unchanged: false }
    })
  }, Boolean(layeredSettings(options.topics || {}, options.tier).writerTakeoverToken))
}
