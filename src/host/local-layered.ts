import { createBuildModelClient } from './models.js'
import { granularityTier } from '../domain/granularity.js'
import path from 'node:path'
import { isLibraryDirectoryName } from '../domain/embedding-name.js'
import { randomUUID } from 'node:crypto'
import { layeredSettings, resolveModel } from '../domain/config.js'
import type { LibraryPolicy } from '../domain/policy.js'
import type { LibraryStore } from '../storage/libraries.js'
import { directory, isLayeredRoot, validateRoots } from '../storage/paths.js'
import { ChangeStore } from '../storage/changes.js'
import type { ModelRuntime } from '../llm/client.js'
import { buildLayeredLibrary } from '../layered/index.js'
import { initializeLibrary, readCurrent, readManifest } from '../layered/publication.js'
import { hash, withBuildLock } from '../layered/files.js'
import { scanSourceFiles, type ScanFile, type ScanJob } from '../ingest/scanner.js'
import { readLocalSource } from '../layered/snapshot.js'
import { separateImages } from '../ingest/markdown.js'
import { matchSourceIdentities } from '../ingest/source-identity.js'
import { buildPolicyKey, buildRegistrationKey } from '../domain/build-identity.js'
import type { BuildLayeredOptions } from '../layered/schema.js'

export function layeredTier(policy: Pick<LibraryPolicy, 'extractionGranularity' | 'customEntityLimit' | 'customConceptLimit' | 'customPointLimit'>): number {
  return granularityTier(policy).value
}
export async function localLayeredRoot(store: LibraryStore, id: string) {
  const library = store.registration(id), root = await store.root(id, true)
  if (library.sourceRoots.length !== 1) throw new Error('本地分层库目前只支持一个资料根；请将资料整理到同一根目录后重新登记，不能只读取第一个目录。')
  const knowledgeRoot = await directory(library.sourceRoots[0]!).catch(error => {
    if (error.code === 'ENOENT') throw new Error('资料根不存在，请核对目录后重新生成。')
    throw error
  })
  if (!isLibraryDirectoryName(path.basename(root))) throw new Error('wikiPath 必须为 .llmwiki 或 .llmwiki-<模型标准名>。')
  await validateRoots(root, [knowledgeRoot])
  return { library, root, knowledgeRoot }
}
export async function scanLocalLayered(store: LibraryStore, id: string, signal: AbortSignal): Promise<ScanJob> {
  const { library, root, knowledgeRoot } = await localLayeredRoot(store, id)
  const scan = await scanSourceFiles([knowledgeRoot], root, signal)
  const manifest = await isLayeredRoot(root) ? await readManifest(root, await readCurrent(root)) : undefined
  let textChars = 0
  const documents = await Promise.all(scan.inputs.filter(input => /\.(md|markdown)$/i.test(input.actual)).map(async input => {
    signal.throwIfAborted(); const source = await readLocalSource(input.actual, 'Markdown 资料')
    return { source, path: path.relative(knowledgeRoot, input.actual).replaceAll('\\', '/'), hash: source.contentHash, segments: source.segments.map(segment => segment.text_hash) }
  }))
  const matches = matchSourceIdentities(documents, (manifest?.sources ?? []).map(entry => ({ entry, id: entry.source_id, path: entry.current_path,
    aliases: entry.alias_paths, hash: entry.content_hash, segments: entry.segments.map(segment => segment.text_hash) })), layeredSettings(library.layered).sourceMatchThreshold)
  const files: ScanFile[] = matches.groups.flatMap(group => group.documents.map(document => {
    const previous = group.previous?.entry, source = document.source, parsed = separateImages(source.text)
    const changed = !previous || previous.content_hash !== source.contentHash, moved = previous && previous.current_path !== document.path
    textChars += parsed.text.length
    return { path: source.path, sourceId: previous?.source_id ?? hash(group.documents[0]!.source.path), change: !previous ? 'new' : changed ? 'changed' : moved ? 'moved' : 'unchanged',
      ...(moved ? { previousPath: path.join(knowledgeRoot, previous.current_path) } : {}),
      bytes: source.bytes.length, chunks: source.segments.length, images: parsed.images.length, pendingImages: 0,
      needsGeneration: changed || Boolean(moved) || JSON.stringify(previous?.alias_paths ?? []) !== JSON.stringify(group.documents.slice(1).map(item => item.path).sort()),
      generation: !previous ? 'new' : changed || moved ? 'update' : 'current' } as ScanFile
  }))
  // 读取不全时只报告扫描错误，避免把未读到的文件误报为删除。
  if (!scan.errors.length) for (const { entry } of matches.deleted) files.push({ path: path.join(knowledgeRoot, entry.current_path), sourceId: entry.source_id,
    change: 'missing', needsGeneration: true, generation: 'update', bytes: 0, chunks: 0, images: 0, pendingImages: 0 })
  store.assertUnchanged(library)
  return { id: randomUUID(), libraryId: id, stage: 'scanned', createdAt: new Date().toISOString(), files, errors: scan.errors, excluded: scan.excluded,
    textChars, bytes: files.reduce((total, file) => total + file.bytes, 0) }
}
export async function generateLocalLayered(store: LibraryStore, id: string, runtime: ModelRuntime, signal: AbortSignal, legacyLibraryAction?: 'backup', reextract?: BuildLayeredOptions['reextract'] | 'gaps', retryTopics?: BuildLayeredOptions['retryTopics'], retrySources?: BuildLayeredOptions['retrySources']) {
  const { library, root, knowledgeRoot } = await localLayeredRoot(store, id)
  const scan = await scanSourceFiles([knowledgeRoot], root, signal)
  if (scan.errors.length) throw new Error('资料扫描失败：' + scan.errors.map(error => error.message).join('；'))
  if (!scan.inputs.some(input => /\.(md|markdown)$/i.test(input.actual)) && !await isLayeredRoot(root)) throw new Error('资料根不含任何 .md/.markdown 文件，无法生成 Wiki。')
  const previousPolicy = await store.policy(id), settings = layeredSettings(library.layered)
  const modelLibrary = { ...library, models: { ...library.models, unified: resolveModel(library.models, 'ingest') } }
  const client = createBuildModelClient(runtime, modelLibrary, previousPolicy.policy, store.snapshot())
  // 初始化先完成格式核对与显式备份，再恢复随库策略；不把新策略写入旧库。
  await withBuildLock(path.dirname(root), async () => {
    signal.throwIfAborted(); store.assertUnchanged(library)
    return initializeLibrary(knowledgeRoot, { name: library.name, domain: library.description, origin_type: 'local',
      source_type: 'Markdown 资料', default_credibility: 'unknown', source_count: 0, updated_at: new Date().toISOString(), format_version: 2 }, settings.writerTakeoverToken, legacyLibraryAction, root, client.upgradeOptions)
  }, Boolean(settings.writerTakeoverToken))
  let policy = await store.policy(id)
  if (!policy.initialized) {
    policy = await store.initialize(id)
    if (previousPolicy.initialized) policy = await store.savePolicy(id, previousPolicy.policy, policy.revision, JSON.stringify(library))
  }
  const existing = (await new ChangeStore(store).list(id)).find(batch => batch.layered && batch.status === 'preview')
  if (existing) throw new Error('该库已有分层预览，请先提交或取消后再生成。')
  // 本地阶段覆盖仍优先；未覆盖的阶段继承本库统一/按任务选择的提取模型。
  const result = await buildLayeredLibrary({ knowledgeRoot, wikiPath: root, client, ...(client.recovery ? { recovery: client.recovery } : {}), ...(client.upgradeOptions ? { upgradeOptions: client.upgradeOptions } : {}), taskModelIdentity: { models: modelLibrary.models, policy: policy.policy },
    name: library.name, domain: library.description, topics: library.layered ?? {}, tier: layeredTier(policy.policy), granularity: granularityTier(policy.policy).name, signal, publish: false, ...(retryTopics ? { retryTopics } : {}),
    tagVocabulary: policy.policy.tagVocabularyMode === 'custom' ? [...policy.policy.customEntityTags, ...policy.policy.customConceptTags] : [],
    ...(reextract === 'gaps' ? { retryGaps: true } : { reextract }), ...(retrySources ? { retrySources } : {}), previewContext: { registrationKey: buildRegistrationKey(library), policyRevision: buildPolicyKey(policy.policy) } })
  if (result.unchanged) return { libraryId: id, status: 'unchanged', ...result, batchId: undefined, pendingImages: 0, message: '内容没有变化。' }
  // 建库首写会给策略补 0.3.0 格式标记（publication/upgrade），文件签名随之改变。
  // 只接受这一处差异，用写后的签名登记预览；其他字段变化仍按配置冲突拒绝提交。
  const written = await store.policy(id)
  const { libraryFormat: _before, ...before } = policy.policy, { libraryFormat: _after, ...after } = written.policy
  const policyRevision = JSON.stringify(before) === JSON.stringify(after) ? written.revision : policy.revision
  const batch = await new ChangeStore(store).prepareLayered(id, result.version, JSON.stringify(library), policyRevision)
  store.assertUnchanged(library)
  return { libraryId: id, id: batch.id, jobId: batch.id, batchId: batch.id, status: 'preview', ...result, pendingImages: 0,
    backupPath: batch.layered?.backupPath, message: '分层预览已生成；当前版本仍供查询，确认提交后刷新阅读目录。' + (batch.message ?? '') }
}
