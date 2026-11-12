import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { siyuanSettings } from '../domain/config.js'
import type { SiyuanSettings } from '../domain/config.js'
import { actualPath, safePath, within } from '../storage/paths.js'
import { readOptional } from '../storage/files.js'
import { hash, hashName, immutableWrite, withRevocationLock, writeJson } from './files.js'
import { readCurrent, readManifest } from './publication.js'
import { readRevocations, revokeSourcesAtRoot } from './revocations.js'
import type { LocalSource } from './snapshot.js'
import type { PendingBuild, SnapshotManifest, SourceEntry } from './schema.js'

const id = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/), digest = z.string().regex(/^sha256:[0-9a-f]{64}$/)
const nativeId = z.string().regex(/^\d{14}-[a-z0-9]{7}$/), generation = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)
const common = z.object({ protocol_version: z.literal(1), status: z.literal('ok'), request_id: z.string().uuid(),
  epoch: z.string().uuid(), generation, scope_revision: generation, config_hash: digest, checked_at: z.string() })
const page = common.extend({ next_cursor: z.string().min(1).nullable(), complete: z.boolean(), snapshot_id: z.string().optional() })
const state = z.object({ document_id: nativeId, state: z.enum(['allowed', 'missing', 'private', 'revoked']), reason: z.string().nullable(), state_generation: generation })
const admission = page.extend({ items: z.array(state), changes_required: z.boolean() })
const changes = page.extend({ items: z.array(state.omit({ state_generation: true }).extend({ generation, event_id: z.string().uuid(), observed_at: z.string() })),
  high_watermark: generation, next_generation: generation })
const document = z.object({ document_id: nativeId, notebook_id: id, parent_id: nativeId.nullable(), path: z.string(), title: z.string(), updated: z.string(),
  hpath: z.string().optional(), attributes: z.record(z.string(), z.string()).optional(), metadata: z.object({ source_type: z.string(), source_date: z.string().nullable() }).optional() })
const exportedDocument = document.extend({ content_hash: digest, source_version: z.string(), resource_version: z.array(digest),
  content_projection_version: z.literal('siyuan-content-v1'), hash_algorithm: z.literal('sha256'),
  target: z.object({ backend: z.literal('siyuan'), workspace_id: id, document_id: nativeId }), keeper_revision: z.record(z.string(), z.unknown()) })
const descriptor = z.object({ object_id: id, kind: z.enum(['kramdown', 'database_raw', 'database_map', 'database_table', 'content_projection', 'attributes', 'metadata', 'locators', 'references']),
  media_type: z.string(), byte_length: z.number().int().nonnegative().max(268435456), raw_hash: digest })
const exportPage = page.extend({ export_id: z.string(), document: exportedDocument, objects: z.array(descriptor),
  parts: z.array(z.object({ object_id: id, offset_bytes: z.number().int().nonnegative(), text: z.string(), last: z.boolean() })),
  object_count: z.number().int().positive().optional(), objects_digest: digest.optional() })
const attachment = z.object({ attachment_id: id, original_path: z.string(), name: z.string(), content_hash: digest,
  size_bytes: z.number().int().nonnegative().max(268435456), media_type: z.string(), block_ids: z.array(nativeId), state: z.literal('allowed') })
type Common = z.infer<typeof common>
type ExportedDocument = z.infer<typeof exportedDocument>
type Descriptor = z.infer<typeof descriptor>
type Admission = z.infer<typeof admission>
export type ExportStatus = 'missing' | 'private' | 'revoked' | 'unsupported' | 'unavailable' | 'unauthorized' | 'forbidden' | 'conflict' | 'expired' | 'invalid'
const errors: Record<string, [ExportStatus, string]> = {
  client_unauthorized: ['unauthorized', 'whalefall 专用凭据未通过认证。'], capability_forbidden: ['forbidden', '请使用仅有 wiki_export 能力的专用凭据。'],
  scope_forbidden: ['forbidden', '收录范围尚未确认或不匹配，请到 whalefall 管理页确认本库、工作空间及收录笔记本。'],
  config_mismatch: ['conflict', '收录名单尚未确认或已变化，请到 whalefall 管理页重新确认。'],
  source_missing: ['missing', '思源来源已不存在。'], attachment_missing: ['missing', '思源附件已不存在。'],
  private_access_required: ['private', '私密资料不能导出到知识库。'], scope_revoked: ['revoked', '来源已退出收录范围，正在更新。'],
  source_format_unsupported: ['unsupported', '当前资料格式无法完整导出，已记为缺口。'], payload_too_large: ['unsupported', '导出内容超过协议上限，已记为缺口。'],
  siyuan_unavailable: ['unavailable', '思源暂时不可达，拒绝读取思源库。'], admission_unverified: ['unavailable', '准入无法核对，拒绝读取思源库。'],
  upstream_timeout: ['unavailable', '准入核对超时，拒绝读取思源库。'], rate_limited: ['unavailable', 'whalefall 暂时限流，拒绝读取思源库。'],
  source_changed: ['conflict', '来源已变化，请重新导出。'], admission_changed: ['conflict', '准入已变化，请重新同步。'],
  epoch_changed: ['conflict', '准入日志世代已变化，需要重新核对全库。'], resync_required: ['conflict', '准入日志不完整，需要重新核对全库。'],
  generation_ahead: ['conflict', '准入代次已回退，需要重新核对全库。'], cursor_expired: ['expired', '游标已过期，请重新枚举。'],
  validation_error: ['invalid', '导出参数或响应格式无效。'], range_invalid: ['invalid', '附件范围无效。'], resource_changed: ['conflict', '附件版本已变化，请重新导出。'],
}
export class WikiExportError extends Error {
  readonly status: ExportStatus
  constructor(readonly code: string) { const entry = errors[code] ?? errors.admission_unverified!; super(entry[1]); this.name = 'WikiExportError'; this.status = entry[0] }
}
function invalid(): never { throw new WikiExportError('admission_unverified') }
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(key => JSON.stringify(key) + ':' + canonical((value as Record<string, unknown>)[key])).join(',') + '}'
  return JSON.stringify(value)
}
// 同现有 fetch 客户端一样合并调用取消与超时；计时器可用虚拟时钟验证，涵盖正文读取及凭据解析。
async function deadline<T>(ms: number, signal: AbortSignal | undefined, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const abort = new AbortController(), combined = signal ? AbortSignal.any([signal, abort.signal]) : abort.signal
  const timer = setTimeout(() => abort.abort(), ms)
  let cancelled: (() => void) | undefined
  try {
    if (combined.aborted) throw new WikiExportError('upstream_timeout')
    return await Promise.race([action(combined), new Promise<never>((_, reject) => {
      cancelled = () => reject(new WikiExportError('upstream_timeout')); combined.addEventListener('abort', cancelled, { once: true })
    })])
  } catch (error) {
    if (signal?.aborted) throw new Error('思源操作已取消。')
    if (combined.aborted) throw new WikiExportError('upstream_timeout')
    if (error instanceof WikiExportError) throw error
    // 不保留上游正文、URL、Header、异常 cause，防止凭据进入日志与失败留痕。
    throw new WikiExportError('admission_unverified')
  } finally { clearTimeout(timer); if (cancelled) combined.removeEventListener('abort', cancelled) }
}
export type CredentialReader = (reference: string) => string | undefined | Promise<string | undefined>
export class WikiExportClient {
  readonly settings: ReturnType<typeof siyuanSettings>
  readonly configHash: string
  constructor(readonly libraryId: string, settings: SiyuanSettings, private readonly request: typeof fetch = fetch,
    private readonly credential: CredentialReader = reference => process.env[reference]) {
    this.settings = siyuanSettings(settings)
    if (!id.safeParse(libraryId).success) throw new Error('思源库标识无效。')
    this.configHash = hash(canonical({ workspace_id: settings.workspaceId, notebook_ids: [...new Set(settings.notebookIds)].sort(),
      exclude_attribute: this.settings.excludeAttribute, exclude_value: 'exclude', exclude_descendants: false, enabled: true }))
  }
  private async call<T>(route: string, fields: Record<string, unknown>, schema: z.ZodType<T>, signal?: AbortSignal, method = 'POST', timeout = this.settings.admissionTimeoutMs): Promise<T> {
    return deadline(timeout, signal, async active => {
      const requestId = randomUUID(), body = { request_id: requestId, library_id: this.libraryId, workspace_id: this.settings.workspaceId, config_hash: this.configHash, ...fields }
      const response = await this.send(route, body, method, active)
      const value = schema.parse(await response.json())
      const checked = common.parse(value)
      if (checked.request_id !== requestId || route !== '/changes/read' && checked.config_hash !== this.configHash) invalid()
      return value
    })
  }
  private async send(route: string, body: Record<string, unknown>, method: string, signal: AbortSignal, extra: Record<string, string> = {}) {
    const token = await this.credential(this.settings.credentialRef)
    if (!token?.trim() || /[\r\n]/.test(token)) throw new WikiExportError('client_unauthorized')
    const url = new URL(this.settings.whalefallUrl.replace(/\/+$/, '') + '/local/v1/wiki-export' + route)
    if (method === 'GET') for (const [key, value] of Object.entries(body)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value))
    const response = await this.request(url, { method, headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json',
      'x-request-id': String(body.request_id), ...extra }, ...(method === 'POST' ? { body: JSON.stringify(body) } : {}), signal, redirect: 'error', cache: 'no-store' })
    if (!response.ok) {
      let code = 'admission_unverified'
      try { const value = await response.json() as { error_code?: unknown }; if (typeof value.error_code === 'string' && Object.hasOwn(errors, value.error_code)) code = value.error_code } catch { /* 非协议错误也不能回显响应正文。 */ }
      throw new WikiExportError(code)
    }
    return response
  }
  notebooks(cursor?: string, signal?: AbortSignal) {
    return this.call('/notebooks', { ...(cursor ? { cursor } : {}), limit: 100 }, page.extend({ items: z.array(z.object({ notebook_id: id, name: z.string(), state: z.enum(['allowed', 'unavailable']) })) }), signal, 'GET')
  }
  documents(cursor?: string, signal?: AbortSignal) {
    return this.call('/documents/list', { cursor: cursor ?? null, limit: 100, notebook_ids: [...new Set(this.settings.notebookIds)].sort(), recursive: true }, page.extend({ items: z.array(document) }), signal)
  }
  export(documentId: string, cursor?: string, signal?: AbortSignal) {
    return this.call(`/documents/${nativeId.parse(documentId)}/export`, { cursor: cursor ?? null, max_bytes: 262144 }, exportPage, signal)
  }
  attachments(documentId: string, exportId: string, cursor?: string, signal?: AbortSignal) {
    return this.call(`/documents/${nativeId.parse(documentId)}/attachments`, { export_id: exportId, cursor: cursor ?? null, limit: 100 }, page.extend({ items: z.array(attachment), export_id: z.string(), resource_version: z.array(digest).optional() }), signal)
  }
  admissions(cursor?: string, signal?: AbortSignal, documentIds?: string[]) {
    return this.call('/admissions/check', { ...(documentIds ? { document_ids: documentIds } : { cursor: cursor ?? null }), limit: 100 }, admission, signal)
  }
  changes(epoch: string, afterGeneration: number, cursor?: string, signal?: AbortSignal, wait = this.settings.pollWaitMs) {
    return this.call('/changes/read', { epoch, after_generation: afterGeneration, cursor: cursor ?? null, wait_ms: wait, limit: 100 }, changes, signal, 'POST', wait + this.settings.admissionTimeoutMs)
  }
  async download(documentId: string, exportId: string, asset: z.infer<typeof attachment>, signal?: AbortSignal): Promise<Buffer> {
    return deadline(this.settings.admissionTimeoutMs, signal, async active => {
      const parts: Buffer[] = []
      for (let start = 0; start < asset.size_bytes || start === 0; start += 1048576) {
        const end = Math.min(asset.size_bytes, start + 1048576) - 1, requestId = randomUUID()
        const response = await this.send(`/documents/${nativeId.parse(documentId)}/attachments/${asset.attachment_id}`,
          { request_id: requestId, library_id: this.libraryId, workspace_id: this.settings.workspaceId, config_hash: this.configHash, export_id: exportId }, 'GET', active,
          { 'if-match': '"' + asset.content_hash + '"', ...(asset.size_bytes ? { range: `bytes=${start}-${end}` } : {}) })
        if (response.headers.get('etag') !== '"' + asset.content_hash + '"' || response.headers.get('x-request-id') !== requestId
          || !z.string().uuid().safeParse(response.headers.get('x-admission-epoch')).success || !generation.safeParse(Number(response.headers.get('x-admission-generation'))).success
          || asset.size_bytes && (response.status !== 206 || response.headers.get('content-range') !== `bytes ${start}-${end}/${asset.size_bytes}`)) invalid()
        const bytes = Buffer.from(await response.arrayBuffer())
        if (bytes.length !== Math.max(0, end - start + 1)) invalid()
        parts.push(bytes)
      }
      const bytes = Buffer.concat(parts)
      if (hash(bytes) !== asset.content_hash) throw new WikiExportError('resource_changed')
      return bytes
    })
  }
}

function sameSnapshot(first: Common & { snapshot_id?: string | undefined }, next: Common & { snapshot_id?: string | undefined }) {
  if (first.epoch !== next.epoch || first.scope_revision !== next.scope_revision || first.config_hash !== next.config_hash || first.snapshot_id !== next.snapshot_id) invalid()
}
async function pages<T extends Common & { next_cursor: string | null; complete: boolean; snapshot_id?: string | undefined }>(read: (cursor?: string) => Promise<T>, each: (page: T) => Promise<void>) {
  let cursor: string | undefined, first: T | undefined
  const seen = new Set<string>()
  for (;;) {
    const value = await read(cursor)
    if (first) sameSnapshot(first, value); else first = value
    if (value.complete !== (value.next_cursor === null)) invalid()
    await each(value)
    if (value.complete) return value
    if (seen.has(value.next_cursor!)) invalid()
    seen.add(value.next_cursor!); cursor = value.next_cursor!
  }
}
export async function validateSiyuanRoot(root: string, settings: SiyuanSettings): Promise<string> {
  const [actual, workspace] = await Promise.all([actualPath(root), actualPath(settings.workspacePath)])
  if (within(workspace, actual)) throw new Error('思源库目录必须在思源工作空间之外。')
  return actual
}
interface Frozen { document: ExportedDocument; exportId: string; objects: Map<string, { descriptor: Descriptor; bytes: Buffer }> }
interface Checkpoint { library_id: string; config_hash: string; workspace_id: string; epoch: string; generation: number }
const checkpointFile = 'state/siyuan-admission.json'
export class SiyuanAdapter {
  constructor(readonly client: WikiExportClient) {}
  async freeze(documentId: string, signal?: AbortSignal): Promise<Frozen> {
    let frozen: Frozen | undefined
    const completed = new Set<string>()
    const final = await pages(cursor => this.client.export(documentId, cursor, signal), async part => {
      if (!frozen) frozen = { document: part.document, exportId: part.export_id, objects: new Map() }
      if (part.document.document_id !== documentId || part.document.target.document_id !== documentId || part.document.target.workspace_id !== this.client.settings.workspaceId
        || canonical(part.document) !== canonical(frozen.document) || part.export_id !== frozen.exportId) invalid()
      for (const desc of part.objects) {
        const previous = frozen.objects.get(desc.object_id)
        if (previous && canonical(previous.descriptor) !== canonical(desc)) invalid()
        if (!previous) frozen.objects.set(desc.object_id, { descriptor: desc, bytes: Buffer.alloc(0) })
      }
      for (const fragment of part.parts) {
        const object = frozen.objects.get(fragment.object_id)
        if (!object || completed.has(fragment.object_id) || object.bytes.length !== fragment.offset_bytes) invalid()
        object.bytes = Buffer.concat([object.bytes, Buffer.from(fragment.text)])
        if (object.bytes.length > object.descriptor.byte_length) invalid()
        if (fragment.last) {
          if (object.bytes.length !== object.descriptor.byte_length || hash(object.bytes) !== object.descriptor.raw_hash) invalid()
          completed.add(fragment.object_id)
        }
      }
    })
    if (!frozen || final.object_count !== frozen.objects.size || completed.size !== frozen.objects.size
      || hash(canonical([...frozen.objects.values()].map(item => item.descriptor).sort((a, b) => a.object_id < b.object_id ? -1 : a.object_id > b.object_id ? 1 : 0))) !== final.objects_digest) invalid()
    const projection = [...frozen.objects.values()].filter(item => item.descriptor.kind === 'content_projection')
    if (projection.length !== 1 || hash(projection[0]!.bytes) !== frozen.document.content_hash || frozen.document.source_version !== frozen.document.updated + '~' + frozen.document.content_hash) invalid()
    return frozen
  }
  async scan(root: string, signal?: AbortSignal): Promise<{ sources: LocalSource[]; gaps: NonNullable<SnapshotManifest['gaps']> }> {
    await validateSiyuanRoot(root, this.client.settings)
    const records: z.infer<typeof document>[] = [], seen = new Set<string>()
    await pages(cursor => this.client.documents(cursor, signal), async page => {
      for (const item of page.items) {
        if (seen.has(item.document_id) || !this.client.settings.notebookIds.includes(item.notebook_id)) invalid()
        seen.add(item.document_id); records.push(item)
      }
    })
    const sources: LocalSource[] = [], gaps: NonNullable<SnapshotManifest['gaps']> = []
    for (const record of records) {
      try { sources.push(await this.snapshot(root, await this.freeze(record.document_id, signal), signal)) }
      catch (error) {
        if (!(error instanceof WikiExportError) || !['unsupported', 'missing', 'private', 'revoked'].includes(error.status)) throw error
        gaps.push({ source_id: record.document_id, status: error.status, message: error.message })
      }
    }
    return { sources, gaps }
  }
  private async snapshot(root: string, frozen: Frozen, signal?: AbortSignal): Promise<LocalSource> {
    const doc = frozen.document, sourceId = doc.document_id
    const body = [...frozen.objects.values()].filter(item => item.descriptor.kind === 'kramdown')
    if (body.length !== 1) invalid()
    // 语义目录内按原始版本分层，时间戳/属性变化不覆盖旧 Kramdown，也不触发模型重提。
    const rawHash = body[0]!.descriptor.raw_hash, base = `objects/snapshots/${sourceId}/${hashName(doc.content_hash)}`
    const snapshot = base + '/raw/' + hashName(hash(canonical([...frozen.objects.values()].map(item => item.descriptor))))
    const files: SourceEntry['files'] = { source: snapshot + '/source.md', assets: [] }, objects: NonNullable<SourceEntry['siyuan']>['objects'] = []
    const json = (kind: Descriptor['kind']): unknown => {
      const value = [...frozen.objects.values()].filter(item => item.descriptor.kind === kind)
      if (value.length !== 1) invalid()
      try { return JSON.parse(value[0]!.bytes.toString('utf8')) } catch { return invalid() }
    }
    const locations = z.array(z.object({ locator: z.string().regex(/^block:\d{14}-[a-z0-9]{7}$/), object_id: id, start_bytes: z.number().int().nonnegative(), end_bytes: z.number().int().nonnegative(), source_document_id: nativeId, block_id: nativeId, keeper_revision: z.unknown().optional() })).safeParse(json('locators'))
    if (!locations.success) invalid()
    let text = ''
    const segments: LocalSource['segments'] = [], dependencies = new Set<string>([sourceId]), sourceRefs: NonNullable<SourceEntry['siyuan']>['source_refs'] = []
    const reference = (blockId: string, owner: string, revision?: unknown) => sourceRefs.push({ locator: 'block:' + blockId,
      target: { backend: 'siyuan', workspace_id: this.client.settings.workspaceId, document_id: owner, block_id: blockId }, ...(revision !== undefined ? { revision } : {}) })
    const append = (value: string, locator: string) => { const start = text.length; text += value; segments.push({ start, end: text.length, locator, text_hash: hash(value) }); text += '\n\n' }
    for (const location of locations.data) {
      const object = frozen.objects.get(location.object_id)
      if (!object || !['kramdown', 'database_table'].includes(object.descriptor.kind) || location.end_bytes < location.start_bytes || location.end_bytes > object.bytes.length || location.locator !== 'block:' + location.block_id) invalid()
      dependencies.add(location.source_document_id)
      reference(location.block_id, location.source_document_id, location.keeper_revision ?? (location.source_document_id === sourceId ? doc.keeper_revision : undefined))
      let value = object.bytes.subarray(location.start_bytes, location.end_bytes).toString('utf8').trimEnd()
      if (object.descriptor.kind === 'database_table') {
        const header = object.bytes.toString('utf8').split('\n').slice(0, 2)
        value = header[0]!.replace(/^\|/, '| 行块 ID |') + '\n' + header[1]!.replace(/^\|/, '| --- |') + '\n' + value.replace(/^\|/, '| ' + location.block_id + ' |')
      }
      if (value.trim()) append(value, location.locator)
    }
    const references = z.array(z.object({ block_id: nativeId, state: z.enum(['allowed', 'private', 'missing', 'revoked']), source_document_id: nativeId.optional(), title: z.string().optional(), summary: z.string().optional(), keeper_revision: z.unknown().optional() })).safeParse(json('references'))
    if (!references.success) invalid()
    for (const item of references.data) if (item.state === 'allowed') {
      if (!item.source_document_id) invalid()
      dependencies.add(item.source_document_id); reference(item.block_id, item.source_document_id, item.keeper_revision)
      append(`引用块 ${item.block_id}：${item.title ?? ''}\n${item.summary ?? ''}`, 'block:' + item.block_id)
    }
    for (const object of frozen.objects.values()) {
      const relative = object.descriptor.kind === 'kramdown' ? files.source : snapshot + (object.descriptor.kind.startsWith('database_') ? '/tables/' : '/metadata/') + object.descriptor.object_id + (object.descriptor.kind === 'database_table' ? '.md' : '.json')
      await immutableWrite(root, relative, object.bytes); objects.push({ path: relative, hash: object.descriptor.raw_hash })
    }
    const metadataPath = snapshot + '/document-' + hashName(hash(canonical(doc))) + '.json'
    await immutableWrite(root, metadataPath, Buffer.from(canonical(doc))); objects.push({ path: metadataPath, hash: hash(canonical(doc)) })
    const assets: z.infer<typeof attachment>[] = []
    const listed = await pages(cursor => this.client.attachments(sourceId, frozen.exportId, cursor, signal), async page => {
      if (page.export_id !== frozen.exportId) invalid()
      assets.push(...page.items)
    })
    const resources = [...new Set(assets.map(asset => asset.content_hash))].sort()
    if (canonical(resources) !== canonical(doc.resource_version) || canonical(resources) !== canonical(listed.resource_version)
      || new Set(assets.map(asset => asset.attachment_id)).size !== assets.length) invalid()
    for (const asset of assets) {
      const target = `${base}/assets/${hashName(asset.content_hash)}/${asset.attachment_id}`
      await immutableWrite(root, target, await this.client.download(sourceId, frozen.exportId, asset, signal))
      files.assets.push({ original_path: asset.original_path, hash: asset.content_hash, path: target })
    }
    const input = base + '/input/' + hashName(hash(text)) + '.md'
    await immutableWrite(root, input, Buffer.from(text)); objects.push({ path: input, hash: hash(text) })
    const attrs = z.record(z.string(), z.string()).safeParse(json('attributes'))
    if (!attrs.success) invalid()
    const declared = doc.metadata?.source_date ?? attrs.data['custom-whalefall-source-date']
    return { path: doc.hpath ?? doc.path, bytes: body[0]!.bytes, text, contentHash: doc.content_hash, sourceId, sourceVersion: doc.source_version, files,
      segments, metadata: { title: doc.title, source_type: doc.metadata?.source_type ?? attrs.data['custom-whalefall-source-type'] ?? '思源笔记', credibility: 'unknown', credibility_reason: '尚无可核验的可信度依据',
        source_date: declared && /^\d{4}-\d{2}-\d{2}$/.test(declared) ? declared : doc.updated.slice(0, 4) + '-' + doc.updated.slice(4, 6) + '-' + doc.updated.slice(6, 8), source_date_basis: declared ? '原文日期' : '文件时间' },
      siyuan: { updated: doc.updated, raw_hash: rawHash, references_hash: hash(canonical(references.data.map(({ keeper_revision: _revision, ...value }) => value))), input, objects, workspace_id: this.client.settings.workspaceId, dependencies: [...dependencies].sort(), source_refs: sourceRefs } }
  }
  private async entries(root: string): Promise<SourceEntry[]> {
    const current = await readCurrent(root), manifest = await readManifest(root, current)
    const pending = await readOptional<PendingBuild>(await safePath(root, 'work/pending.json'))
    return [...manifest.sources, ...pending?.manifest.sources ?? []]
  }
  private async apply(root: string, states: { document_id: string; state: string }[]) {
    const denied = new Set(states.filter(item => item.state !== 'allowed').map(item => item.document_id))
    const entries = await this.entries(root), affected = entries.filter(entry => denied.has(entry.source_id) || entry.siyuan?.dependencies.some(id => denied.has(id)))
    if (affected.length) await revokeSourcesAtRoot(root, affected.map(entry => entry.source_id), '思源准入变化：排除、私密、删除或移出收录范围')
  }
  private async save(root: string, value: Common, reset = false) {
    await withRevocationLock(root, async () => {
      const previous = await readOptional<Checkpoint>(await safePath(root, checkpointFile))
      if (!reset && previous?.epoch === value.epoch && previous.generation > value.generation) return
      await writeJson(root, checkpointFile, { library_id: this.client.libraryId, workspace_id: this.client.settings.workspaceId,
        config_hash: this.client.configHash, epoch: value.epoch, generation: value.generation } satisfies Checkpoint)
    })
  }
  async checkAdmission(root: string, signal?: AbortSignal): Promise<Common> {
    const result = await deadline(this.client.settings.admissionTimeoutMs, signal, async active => {
      await validateSiyuanRoot(root, this.client.settings)
      // 物理清除后仍核对已知来源身份，不能把准入漏项误当成空库成功。
      const revoked = (await readRevocations(root)).sources.map(item => item.source_id).filter(id => nativeId.safeParse(id).success)
      const required = [...new Set([...revoked, ...(await this.entries(root)).flatMap(entry => [entry.source_id, ...entry.siyuan?.dependencies ?? []])])], items: Admission['items'] = []
      let last: Admission | undefined, first: Common | undefined
      const accept = async (value: Admission) => {
        if (first && (first.epoch !== value.epoch || first.generation !== value.generation || first.scope_revision !== value.scope_revision)) invalid()
        first ??= value; items.push(...value.items); last = value
        // 每页先落撤权，再读取下一页；后续失败也不能恢复旧正文。
        await this.apply(root, value.items)
      }
      if (!required.length) await pages(cursor => this.client.admissions(cursor, active), accept)
      else for (let offset = 0; offset < required.length; offset += 200) {
        const batch = required.slice(offset, offset + 200), value = await this.client.admissions(undefined, active, batch)
        if (!value.complete || value.items.length !== batch.length || batch.some(id => !value.items.some(item => item.document_id === id))) invalid()
        await accept(value)
      }
      if (!last) invalid()
      return last
    })
    if (!await readOptional(await safePath(root, checkpointFile))) await this.save(root, result)
    return result
  }
  async pollOnce(root: string, signal?: AbortSignal): Promise<void> {
    await validateSiyuanRoot(root, this.client.settings)
    let saved = await readOptional<Checkpoint>(await safePath(root, checkpointFile))
    if (!saved) { await this.checkAdmission(root, signal); saved = await readOptional<Checkpoint>(await safePath(root, checkpointFile)) }
    if (!saved || saved.library_id !== this.client.libraryId || saved.workspace_id !== this.client.settings.workspaceId || !generation.safeParse(saved.generation).success || !z.string().uuid().safeParse(saved.epoch).success) invalid()
    try {
      const anchor = saved
      let previous = anchor.generation
      await pages(cursor => this.client.changes(anchor.epoch, anchor.generation, cursor, signal), async value => {
        if (value.epoch !== anchor.epoch || value.next_generation < previous || value.high_watermark !== value.generation || value.next_generation > value.high_watermark) invalid()
        for (const event of value.items) { if (event.generation !== previous + 1) invalid(); previous = event.generation }
        if (previous !== value.next_generation || value.complete && previous !== value.high_watermark) invalid()
        await this.apply(root, value.items)
        // 每页先屏蔽后持久化已消费代次，掉线后不跳过未读事件。
        await this.save(root, { ...value, generation: previous })
      })
    } catch (error) {
      if (error instanceof WikiExportError && ['epoch_changed', 'resync_required', 'generation_ahead'].includes(error.code)) {
        const entries = await this.entries(root)
        if (entries.length) await revokeSourcesAtRoot(root, entries.map(entry => entry.source_id), '思源准入日志变化，等待重新核对并重建')
        await this.save(root, await this.checkAdmission(root, signal), true)
      } else throw error
    }
  }
  async watch(root: string, signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try { await this.pollOnce(root, signal) } catch { /* 查询仍同步核对；后台重连只使用已持久化代次，不输出上游错误。 */ }
      if (!signal.aborted) await new Promise<void>(resolve => {
        const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve() }
        const timer = setTimeout(finish, this.client.settings.pollIntervalMs)
        signal.addEventListener('abort', finish, { once: true })
        if (signal.aborted) finish()
      })
    }
  }
}

export async function validateSiyuanSnapshot(root: string, entry: SourceEntry): Promise<string> {
  const saved = entry.siyuan
  if (!saved || !nativeId.safeParse(entry.source_id).success || entry.source_version !== saved.updated + '~' + entry.content_hash) invalid()
  const prefix = `objects/snapshots/${entry.source_id}/${hashName(entry.content_hash)}/`
  if (![entry.files.source, saved.input, ...saved.objects.map(item => item.path)].every(file => file.startsWith(prefix)) || !saved.objects.some(item => item.path === saved.input)) invalid()
  for (const object of saved.objects) if (hash(await readFile(await safePath(root, object.path))) !== object.hash) invalid()
  if (hash(await readFile(await safePath(root, entry.files.source))) !== saved.raw_hash) invalid()
  const projection = saved.objects.find(item => item.path.endsWith('/content-projection.json'))
  if (!projection || projection.hash !== entry.content_hash) invalid()
  return readFile(await safePath(root, saved.input), 'utf8')
}
