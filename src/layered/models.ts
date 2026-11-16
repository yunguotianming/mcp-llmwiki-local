import type { ModelAttempt, ModelClient } from '../llm/client.js'
import type { ModelRef } from '../domain/config.js'
import { readFile } from 'node:fs/promises'
import { atomicWrite, hash } from './files.js'
import { safePath } from '../storage/paths.js'
import type { AcceptedRecord, AcceptedRef, PendingBuild, ProductionArtifact, ProductionRecord, SnapshotManifest, VersionProvenance } from './schema.js'

export type { ModelRef } from '../domain/config.js'

export function mergeModels(...groups: (readonly ModelRef[] | undefined)[]): ModelRef[] {
  const routes = new Map<string, ModelRef>()
  for (const group of groups) for (const route of group ?? []) {
    if (!route.provider || !route.model) continue
    const value = { provider: route.provider, model: route.model }
    routes.set(JSON.stringify([value.provider, value.model]), value)
  }
  return [...routes.values()].sort((left, right) => left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model))
}

export function modelUsage<Client extends Pick<ModelClient, 'call' | 'info'>>(client: Client): { client: Client; models: ModelRef[] } {
  const models: ModelRef[] = []
  const call: ModelClient['call'] = async (task, system, input, signal, images, options) => {
    const attempts: ModelAttempt[] = []
    let completed = false
    try {
      const output = await client.call(task, system, input, signal, images, {
        ...options,
        onAttempt: attempt => {
          attempts.push(attempt)
          options?.onAttempt?.(attempt)
        },
      })
      completed = true
      return output
    } finally {
      const successful = attempts.filter(attempt => attempt.finish === 'stop' && !attempt.error).map(attempt => attempt.route)
      if (completed && !attempts.length) {
        try {
          const info = await client.info(task, signal, images?.length ? 'image' : undefined, options?.operation)
          if (info.provider && info.id) successful.push({ provider: info.provider, model: info.id })
        } catch {}
      }
      models.splice(0, models.length, ...mergeModels(models, successful))
    }
  }
  const observed = new Proxy(client, {
    get(target, property) {
      if (property === 'call') return call
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { client: observed, models }
}

export const utf8Compare = (a: string, b: string): number => Buffer.compare(Buffer.from(a), Buffer.from(b))
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + Array.from(value, canonicalJson).join(',') + ']'
  if (value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    return '{' + Object.keys(value).sort(utf8Compare).map(key => JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key])).join(',') + '}'
  }
  throw new Error('规范 JSON 不接受 undefined、非有限数或非 JSON 对象。')
}
export const protocolDigest = (value: unknown): string => hash(canonicalJson(value))
export const sortedUnique = <T>(values: T[]): T[] => [...new Map(values.map(value => [canonicalJson(value), value])).entries()].sort(([a], [b]) => utf8Compare(a, b)).map(([, value]) => value)
export const protocolError = (code: string, message: string): Error & { code: string } => Object.assign(new Error(message), { code })
export const digestPattern = /^sha256:[a-f0-9]{64}$/
export const taskPattern = /^t:[a-f0-9]{64}$/
const stages = ['extract', 'extractionReview', 'topic', 'parent', 'topicReview', 'term', 'rewrite']
const keysMatch = (value: object, keys: string[]) => canonicalJson(Object.keys(value).sort()) === canonicalJson([...keys].sort())
const sourceRefsValid = (refs: import('./schema.js').SourceRef[]) => Array.isArray(refs) && refs.every(ref => ref && keysMatch(ref, ['sourceId', 'sourceVersion']) && typeof ref.sourceId === 'string' && ref.sourceId.length > 0 && typeof ref.sourceVersion === 'string' && ref.sourceVersion.length > 0)
  && canonicalJson(refs) === canonicalJson(sortedUnique(refs))
export async function writeProtocol(root: string, file: string, value: unknown): Promise<void> {
  try { await atomicWrite(root, file, canonicalJson(value) + '\n') }
  catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { storageFailure: true }) }
}
export async function readProtocol<T>(root: string, file: string, corruptCode: string): Promise<T | undefined> {
  let text: string
  try { text = await readFile(await safePath(root, file), 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw error }
  try {
    const value = JSON.parse(text)
    // 新文件强制规范编码，同时拒绝重复键、BOM 与不可表示的数值。
    if (text !== canonicalJson(value) + '\n') throw new Error('非规范编码')
    return value as T
  } catch { throw protocolError(corruptCode, '持久记录损坏：' + file) }
}
export function productionId(record: ProductionRecord): string {
  return protocolDigest({ ...record, parentProductionIds: sortedUnique(record.parentProductionIds) })
}
export function validateProductions(records: Record<string, ProductionRecord>, roots = Object.keys(records)): void {
  const complete = new Set<string>(), active = new Set<string>()
  const visit = (id: string) => {
    if (complete.has(id)) return
    const record = records[id]
    if (!record || !keysMatch(record, ['taskId', 'stage', 'operation', 'role', 'outputDigest', 'lineId', 'provider', 'requestedModel', 'reportedModel', 'parameters', 'bindingRevision', 'capabilityRevision', 'parentProductionIds'])
      || !Array.isArray(record.parentProductionIds) || !record.parameters || typeof record.parameters !== 'object' || Array.isArray(record.parameters)
      || productionId(record) !== id || !taskPattern.test(record.taskId) || !digestPattern.test(record.outputDigest)
      || !stages.includes(record.stage)
      || !['generate', 'review', 'correct'].includes(record.role) || !record.operation || !record.lineId || !record.provider || !record.requestedModel
      || !(record.reportedModel === null || typeof record.reportedModel === 'string')
      || !digestPattern.test(record.bindingRevision) || !digestPattern.test(record.capabilityRevision)
      || canonicalJson(record.parentProductionIds) !== canonicalJson(sortedUnique(record.parentProductionIds))) throw protocolError('PROVENANCE_INCOMPLETE', '生产记录或生产 ID 无效：' + id)
    if (active.has(id)) throw protocolError('PROVENANCE_INCOMPLETE', '生产链含环。')
    active.add(id)
    for (const parent of record.parentProductionIds) visit(parent)
    active.delete(id); complete.add(id)
  }
  for (const id of roots) visit(id)
}
export function validateAcceptedRecord(record: Omit<AcceptedRecord, 'acceptedDigest'>): void {
  if (!keysMatch(record, ['schema', 'taskId', 'identity', 'output', 'validation', 'productions', 'dependencies'])
    || !keysMatch(record.identity, ['version', 'scope', 'stage', 'operation', 'inputDigest', 'promptDigest', 'schemaDigest', 'validatorVersion', 'semanticVersion', 'groupPlanDigest', 'revocationGeneration', 'reextractGeneration'])
    || !keysMatch(record.identity.scope, ['libraryId', 'unitId', 'sourceRefs']) || !record.identity.scope.libraryId || !record.identity.scope.unitId || !sourceRefsValid(record.identity.scope.sourceRefs)
    || !stages.includes(record.identity.stage) || !record.identity.operation || !record.identity.validatorVersion || !record.identity.semanticVersion
    || [record.identity.revocationGeneration, record.identity.reextractGeneration].some(value => !Number.isSafeInteger(value) || value < 0)
    || [record.identity.inputDigest, record.identity.promptDigest, record.identity.schemaDigest].some(value => !digestPattern.test(value))
    || record.identity.groupPlanDigest !== null && !digestPattern.test(record.identity.groupPlanDigest)
    || !keysMatch(record.output, ['path', 'digest', 'bytes', 'encoding']) || !keysMatch(record.validation, ['validatorVersion', 'schemaDigest', 'status'])
    || !Array.isArray(record.dependencies) || record.dependencies.some(dep => !taskPattern.test(dep.taskId) || !digestPattern.test(dep.acceptedDigest) || !sourceRefsValid(dep.sourceRefs))
    || record.schema !== 'llmwiki-accepted-v1' || record.taskId !== 't:' + protocolDigest(record.identity).slice(7)
    || record.identity.version !== 1 || record.validation.status !== 'accepted'
    || record.validation.validatorVersion !== record.identity.validatorVersion || record.validation.schemaDigest !== record.identity.schemaDigest
    || !digestPattern.test(record.output.digest) || !Number.isSafeInteger(record.output.bytes) || record.output.bytes < 0
    || !['utf8-json', 'utf8-text'].includes(record.output.encoding) || !Object.keys(record.productions).length) {
    throw protocolError('ACCEPT_PREPARE_CORRUPT', '拟接受记录的身份、校验规则或生产表无效。')
  }
  validateProductions(record.productions)
}
export const artifactId = (item: ProductionArtifact): string => protocolDigest({ kind: item.kind, objectPath: item.objectPath, objectDigest: item.objectDigest, pagePath: item.pagePath })
export function sidecarPath(version: string, kind: 'provenance' | 'costs'): string {
  if (!/^v\d{6,}$/.test(version)) throw new Error('版本号无效。')
  return `versions/${version}.${kind}.json`
}
export async function isProductionFormat(root: string): Promise<boolean> {
  const file = await safePath(root, '.llmwiki/policy.json')
  const value = await readFile(file, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  if (!value) return false
  const format = JSON.parse(value).libraryFormat
  if (format !== undefined && format !== '0.3.0') throw protocolError('LIBRARY_FORMAT_INVALID', '库格式标记无效。')
  return format === '0.3.0'
}
export function validateProvenance(value: VersionProvenance, version: string, manifestChecksum: string): void {
  if (value.schema !== 'llmwiki-provenance-v1' || value.version !== version || value.manifestChecksum !== manifestChecksum
    || !Number.isSafeInteger(value.revocationGeneration) || value.revocationGeneration < 0) throw protocolError('PROVENANCE_INCOMPLETE', '版本附属记录与主清单不符。')
  validateProductions(value.records)
  for (const [id, artifact] of Object.entries(value.artifacts)) {
    if (artifactId(artifact) !== id || !digestPattern.test(artifact.objectDigest)
      || !['recorded', 'legacy-recorded', 'unknown', 'local-derived'].includes(artifact.status)
      || artifact.status === 'unknown' && !artifact.reason
      || artifact.status === 'recorded' && !artifact.productionIds.length
      || artifact.status === 'local-derived' && artifact.productionIds.length
      || canonicalJson(artifact.productionIds) !== canonicalJson(sortedUnique(artifact.productionIds))
      || !sourceRefsValid(artifact.sourceRefs) || !['extraction', 'page', 'metadata'].includes(artifact.kind)
      || artifact.kind === 'extraction' && (artifact.pagePath !== null || typeof artifact.objectPath !== 'string')
      || artifact.kind === 'page' && (typeof artifact.pagePath !== 'string' || typeof artifact.objectPath !== 'string')) throw protocolError('PROVENANCE_INCOMPLETE', '产物记录无效：' + id)
    if (artifact.kind === 'metadata' && (!artifact.metadata || artifact.objectPath !== null || artifact.pagePath !== null || protocolDigest(artifact.metadata) !== artifact.objectDigest)) throw protocolError('PROVENANCE_INCOMPLETE', '元数据快照无效。')
    validateProductions(value.records, [...artifact.productionIds, ...(artifact.inheritedFrom?.productionIds ?? [])])
  }
}
export async function readProvenance(root: string, version: string, checksum: string): Promise<VersionProvenance> {
  try {
    const envelope = await readProtocol<{ checksum: string; provenance: VersionProvenance }>(root, sidecarPath(version, 'provenance'), 'PROVENANCE_INCOMPLETE')
    if (!envelope || protocolDigest(envelope.provenance) !== envelope.checksum) throw new Error('附属文件缺失或摘要不符')
    validateProvenance(envelope.provenance, version, checksum)
    return envelope.provenance
  } catch (error) { throw protocolError('PROVENANCE_INCOMPLETE', '生产记录不完整：' + String(error)) }
}
export async function writeProvenance(root: string, provenance: VersionProvenance): Promise<{ path: string; checksum: string }> {
  validateProvenance(provenance, provenance.version, provenance.manifestChecksum)
  const checksum = protocolDigest(provenance), file = sidecarPath(provenance.version, 'provenance')
  await writeProtocol(root, file, { checksum, provenance })
  return { path: file, checksum }
}
/** 只读取旧证据；旧模型并集不能用来认定具体角色。 */
export async function legacyProvenance(root: string, manifest: SnapshotManifest, manifestChecksum: string): Promise<VersionProvenance> {
  const artifacts: VersionProvenance['artifacts'] = {}
  const add = (item: ProductionArtifact) => { artifacts[artifactId(item)] = item }
  for (const source of manifest.sources) {
    const bytes = await readFile(await safePath(root, source.extract.path)), extraction = JSON.parse(bytes.toString('utf8'))
    const evidence: NonNullable<ProductionArtifact['legacyEvidence']> = []
    for (const [field, models] of Object.entries({ models: extraction.models, 'verification.models': extraction.segments?.flatMap((s: { points?: { verification?: { models?: unknown } }[] }) => s.points?.flatMap(p => p.verification?.models ?? []) ?? []), actual_model: extraction.actual_model, 'processing.model': extraction.processing?.model })) {
      if (models !== undefined) evidence.push({ originVersion: manifest.version!, field, models, role: null })
    }
    add({ kind: 'extraction', objectPath: source.extract.path, objectDigest: hash(bytes), pagePath: null,
      sourceRefs: [{ sourceId: source.source_id, sourceVersion: source.source_version }], status: 'unknown', reason: 'legacy-library', productionIds: [], inheritedFrom: null, legacyEvidence: evidence })
  }
  for (const [page, digest] of Object.entries(manifest.pages ?? {})) {
    const emptyArchive = manifest.topics?.topics.some(topic => topic.path === page && topic.archived && !topic.point_ids.length)
      && manifest.deps?.pages[page]?.points.length === 0 && !manifest.deps?.pages[page]?.models?.length
    const local = page === 'index.md' || /\/index[^/]*\.md$/.test(page) || emptyArchive
    add({ kind: 'page', objectPath: `objects/pages/${digest.slice(7)}.md`, objectDigest: digest, pagePath: page,
      sourceRefs: sortedUnique((manifest.deps?.pages[page]?.sources ?? []).map(id => ({ sourceId: id, sourceVersion: manifest.sources.find(s => s.source_id === id)?.source_version ?? '' }))),
      status: local ? 'local-derived' : 'unknown', ...(!local ? { reason: 'legacy-library' } : {}), productionIds: [], inheritedFrom: null,
      legacyEvidence: [{ originVersion: manifest.version!, field: 'deps.pages.models', models: manifest.deps?.pages[page]?.models ?? [], role: null }] })
  }
  for (const [pointId, labels] of Object.entries(manifest.point_labels ?? {})) {
    const metadata = { target: pointId, fields: ['labels', 'keywords'], value: { labels: labels.labels, keywords: labels.keywords } }
    const source = manifest.sources.find(source => pointId.startsWith(source.source_id + ':'))
    add({ kind: 'metadata', objectPath: null, objectDigest: protocolDigest(metadata), pagePath: null, metadata,
      sourceRefs: source ? [{ sourceId: source.source_id, sourceVersion: source.source_version }] : [], status: 'unknown', reason: 'legacy-library', productionIds: [], inheritedFrom: null,
      legacyEvidence: [{ originVersion: manifest.version!, field: 'point_labels.model', models: labels.model, role: null }] })
  }
  if (manifest.tag_merges) {
    const metadata = { target: 'tag_merges', fields: ['checked', 'groups'], value: { checked: manifest.tag_merges.checked, groups: manifest.tag_merges.groups } }
    add({ kind: 'metadata', objectPath: null, objectDigest: protocolDigest(metadata), pagePath: null, metadata,
      sourceRefs: sortedUnique(manifest.sources.map(s => ({ sourceId: s.source_id, sourceVersion: s.source_version }))),
      status: manifest.tag_merges.checked.length || manifest.tag_merges.groups.length ? 'unknown' : 'local-derived',
      ...(manifest.tag_merges.checked.length || manifest.tag_merges.groups.length ? { reason: 'legacy-library' } : {}), productionIds: [], inheritedFrom: null,
      legacyEvidence: [{ originVersion: manifest.version!, field: 'tag_merges.models', models: manifest.tag_merges.models ?? [], role: null }] })
  }
  return { schema: 'llmwiki-provenance-v1', version: manifest.version!, manifestChecksum, revocationGeneration: manifest.revocation_generation, artifacts, records: {} }
}

export async function publicationProvenance(root: string, pending: PendingBuild, manifestChecksum: string, previous?: VersionProvenance): Promise<VersionProvenance> {
  const value = await legacyProvenance(root, pending.manifest, manifestChecksum)
  const { createExecutionLedger } = await import('./costs.js')
  const hooks = createExecutionLedger(root)
  const attach = async (artifact: ProductionArtifact, ref: AcceptedRef) => {
    const snapshot = await hooks.readAcceptance(ref.taskId)
    if (snapshot.status !== 'bound' || snapshot.acceptedDigest !== ref.digest) throw protocolError('PROVENANCE_INCOMPLETE', '待发布成果缺少已绑定的接受记录。')
    const bytes = await readFile(await safePath(root, snapshot.record.output.path))
    if (hash(bytes) !== snapshot.record.output.digest || bytes.length !== snapshot.record.output.bytes) throw protocolError('PROVENANCE_INCOMPLETE', '接受输出字节损坏。')
    artifact.productionIds = sortedUnique([...artifact.productionIds, ...Object.keys(snapshot.record.productions)])
    artifact.sourceRefs = sortedUnique([...artifact.sourceRefs, ...snapshot.record.identity.scope.sourceRefs, ...snapshot.record.dependencies.flatMap(item => item.sourceRefs)])
    artifact.status = 'recorded'; delete artifact.reason; delete artifact.legacyEvidence
    Object.assign(value.records, snapshot.record.productions)
  }
  for (const artifact of Object.values(value.artifacts)) {
    const source = pending.manifest.sources.find(source => artifact.kind === 'extraction' ? source.extract.path === artifact.objectPath : artifact.pagePath === `sources/${source.source_id}.md`)
    const ref = source?.acceptedRef ?? (artifact.pagePath ? pending.manifest.deps?.pages[artifact.pagePath]?.review?.acceptedRef ?? pending.manifest.deps?.pages[artifact.pagePath]?.acceptedRef : undefined)
      ?? (artifact.metadata?.target === 'tag_merges' ? pending.manifest.tag_merges?.acceptedRef : pending.manifest.point_labels?.[artifact.metadata?.target ?? '']?.acceptedRef)
    // 术语整页由独立接受的分节组装；逐节关联真实生产链。
    const sectionRefs = artifact.pagePath?.startsWith('terms/') ? (pending.manifest.deps?.pages[artifact.pagePath]?.children ?? [])
      .flatMap(child => pending.manifest.deps?.pages[child.page]?.acceptedRef ?? []) : []
    const refs = sortedUnique([...(ref ? [ref] : []), ...sectionRefs])
    const inherited = previous && Object.entries(previous.artifacts).find(([, prior]) => prior.kind === artifact.kind && prior.objectDigest === artifact.objectDigest && prior.pagePath === artifact.pagePath)
    const sameAcceptance = refs.length && refs.every(ref => inherited?.[1].productionIds.some(id => previous!.records[id]?.taskId === ref.taskId))
    if (refs.length && !sameAcceptance) {
      for (const accepted of refs) await attach(artifact, accepted)
      const contribution = inherited ?? (previous && Object.entries(previous.artifacts).find(([, prior]) => prior.kind === artifact.kind && (artifact.kind === 'page'
        ? prior.pagePath === artifact.pagePath : artifact.kind === 'metadata' ? prior.metadata?.target === artifact.metadata?.target
          : prior.sourceRefs.some(ref => ref.sourceId === source?.source_id))))
      if (contribution && ['unknown', 'legacy-recorded'].includes(contribution[1].status) && !artifact.productionIds.some(id => value.records[id]?.role === 'generate')) {
        artifact.status = 'legacy-recorded'; artifact.legacyEvidence = contribution[1].legacyEvidence ?? []
        artifact.productionIds = sortedUnique([...artifact.productionIds, ...contribution[1].productionIds, ...(contribution[1].inheritedFrom?.productionIds ?? [])])
        artifact.inheritedFrom = { version: previous!.version, artifactId: contribution[0], productionIds: contribution[1].productionIds }
        Object.assign(value.records, previous!.records)
      }
    } else if (inherited) {
      Object.assign(artifact, structuredClone(inherited[1]), { inheritedFrom: { version: previous!.version, artifactId: inherited[0], productionIds: inherited[1].productionIds } })
      Object.assign(value.records, previous!.records)
    } else if (artifact.status !== 'local-derived') {
      // 本地来源页可以从原样复用的提取结果派生，但不能猜新主题的作者。
      const oldExtraction = source && previous && Object.values(previous.artifacts).find(a => a.kind === 'extraction' && a.objectPath === source.extract.path)
      if (oldExtraction && artifact.kind === 'page') {
        artifact.status = oldExtraction.status; artifact.productionIds = oldExtraction.productionIds
        if (oldExtraction.reason) artifact.reason = oldExtraction.reason
        else delete artifact.reason
        artifact.legacyEvidence = oldExtraction.legacyEvidence ?? []
        artifact.inheritedFrom = { version: previous!.version, artifactId: artifactId(oldExtraction), productionIds: oldExtraction.productionIds }
        Object.assign(value.records, previous!.records)
      } else throw protocolError('PROVENANCE_INCOMPLETE', '新成果没有接受来源：' + (artifact.pagePath ?? artifact.objectPath))
    }
  }
  // 升级补齐的简介和核对字段只存在附属文件中，续建时仍需原样继承。
  for (const [id, prior] of Object.entries(previous?.artifacts ?? {})) {
    if (prior.kind !== 'metadata' || prior.metadata?.target === 'tag_merges' || prior.metadata?.fields.includes('labels')
      || Object.values(value.artifacts).some(item => item.metadata?.target === prior.metadata?.target && canonicalJson(item.metadata?.fields) === canonicalJson(prior.metadata?.fields))
      || !prior.sourceRefs.every(ref => pending.manifest.sources.some(source => source.source_id === ref.sourceId && source.source_version === ref.sourceVersion))) continue
    value.artifacts[id] = { ...structuredClone(prior), inheritedFrom: { version: previous!.version, artifactId: id, productionIds: prior.productionIds } }
    Object.assign(value.records, previous!.records)
  }
  // 内嵌闭合链，移除未被本版本引用的历史记录。
  const needed = new Set<string>()
  const visit = (id: string) => { if (needed.has(id)) return; needed.add(id); for (const parent of value.records[id]?.parentProductionIds ?? []) visit(parent) }
  for (const artifact of Object.values(value.artifacts)) for (const id of [...artifact.productionIds, ...(artifact.inheritedFrom?.productionIds ?? [])]) visit(id)
  value.records = Object.fromEntries([...needed].map(id => [id, value.records[id]!]))
  return value
}
