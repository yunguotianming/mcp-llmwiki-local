import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach } from 'vitest'
import { defaultPolicy } from '../src/domain/policy.js'
import { atomicWrite, hash, writeJson } from '../src/layered/files.js'
import { createExecutionLedger } from '../src/layered/costs.js'
import { canonicalJson, productionId, protocolDigest, writeProtocol } from '../src/layered/models.js'
import { putPage, writeVersion } from '../src/layered/objects.js'
import { localDevice } from '../src/layered/devices.js'
import { safePath, initializePartitionLayout } from '../src/storage/paths.js'
import type { AcceptanceRequest, AcceptedRecord, AttemptRequest, ExecutionHooks, ProductionRecord, SnapshotManifest, TaskIdentity } from '../src/layered/schema.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true, maxRetries: 4 }) })
export const runId = '11111111-1111-4111-8111-111111111111'
export async function temporary() {
  const parent = await mkdtemp(path.join(tmpdir(), 'llmwiki-b3-')); roots.push(parent)
  const root = path.join(parent, '.llmwiki'); await mkdir(root)
  return { root, parent }
}
export function identity(unit = '单元', stage: TaskIdentity['stage'] = 'extract'): TaskIdentity {
  return { version: 1, scope: { libraryId: '夹具库', unitId: unit, sourceRefs: [] }, stage, operation: 'generate', inputDigest: hash(unit), promptDigest: hash('提示'), schemaDigest: hash('结构'), validatorVersion: 'v1', semanticVersion: 'v1', groupPlanDigest: null, revocationGeneration: 0, reextractGeneration: 0 }
}
export const taskIdOf = (identity: TaskIdentity) => 't:' + protocolDigest(identity).slice(7)
export function request(taskId: string, sequence = 1, line = '备用', run = runId, stage: TaskIdentity['stage'] = 'extract'): AttemptRequest {
  return { runId: run, attemptId: `a:${run}:${sequence}`, taskId, retryScopeId: taskId, stage, operation: 'generate', estimatedInputTokens: 100, maxOutputTokens: 20,
    candidate: { candidateId: hash(line), lineId: line, provider: '离线桩', requestedModel: line + '模型', parameters: { reasoningEffort: 'high' }, bindingRevision: hash('绑定'), capabilityRevision: hash('能力') },
    priceSnapshot: { currency: 'CNY', unit: 1000, input: 1, cacheRead: 0.1, cacheWrite: 1, output: 2, priceRevision: 'v1' } }
}
export async function finish(hooks: ExecutionHooks, req: AttemptRequest, success = true, usage: import('../src/layered/schema.js').NormalizedUsage | null = { inputTokens: 10, cacheReadTokens: 2, cacheWriteTokens: 0, outputTokens: 5 }) {
  const result = await hooks.beforeAttempt(req)
  if (result.status !== 'reserved') throw new Error(result.reason)
  await hooks.onDispatch(result.reservationId)
  await hooks.afterAttempt({ attemptId: req.attemptId, reservationId: result.reservationId, status: 'finished', finish: success ? 'success' : 'transport-error',
    provider: req.candidate.provider, model: req.candidate.requestedModel, reportedModel: null, usage, requestId: null, errorCategory: success ? null : 'transport', localExitStatus: null })
}
export async function prepare(root: string, options: { identity?: TaskIdentity; sequence?: number; hooks?: ExecutionHooks; run?: string; content?: string } = {}) {
  const id = options.identity ?? identity(), taskId = taskIdOf(id), hooks = options.hooks ?? createExecutionLedger(root)
  const req = request(taskId, options.sequence ?? 1, '备用', options.run ?? runId, id.stage)
  await finish(hooks, req)
  const content = options.content ?? '{"结果":"已核验"}', digest = hash(content), output = `work/accepted/objects/${digest.slice(7)}.bin`
  await atomicWrite(root, output, content)
  const record: ProductionRecord = { taskId, stage: id.stage, operation: id.operation, role: 'generate', outputDigest: digest,
    lineId: req.candidate.lineId, provider: req.candidate.provider, requestedModel: req.candidate.requestedModel, reportedModel: null,
    parameters: req.candidate.parameters, bindingRevision: req.candidate.bindingRevision, capabilityRevision: req.candidate.capabilityRevision, parentProductionIds: [] }
  const accepted: Omit<AcceptedRecord, 'acceptedDigest'> = { schema: 'llmwiki-accepted-v1', taskId, identity: id, output: { path: output, digest, bytes: Buffer.byteLength(content), encoding: 'utf8-json' }, validation: { status: 'accepted', validatorVersion: id.validatorVersion, schemaDigest: id.schemaDigest }, productions: { [productionId(record)]: record }, dependencies: [] }
  const input: AcceptanceRequest = { taskId, record: accepted, responseAttemptId: req.attemptId, acceptedAttemptIds: [req.attemptId] }
  const prepared = await hooks.prepareAccepted(input)
  return { hooks, req, input, prepared, record, accepted, commit: async () => {
    const acceptedDigest = protocolDigest(accepted), file = `work/accepted/tasks/${taskId.slice(2)}.json`
    // 模拟 B1 唯一提交点；B3 产品代码不写此索引。
    await writeProtocol(root, file, { ...accepted, acceptedDigest })
    await hooks.onAccepted({ taskId, prepareId: prepared.prepareId, acceptedDigest })
    return { taskId, path: file, digest: acceptedDigest }
  } }
}
/** 仓库没有 0.2.0/0.2.1 封存夹具；按当时 format_version=2 构造原始字节。 */
export async function legacyFixture(version: '0.2.0' | '0.2.1' = '0.2.0', partitioned = false) {
  const f = await temporary(), root = f.root
  if (partitioned) await initializePartitionLayout(root)
  await writeJson(root, '.llmwiki/policy.json', defaultPolicy())
  await writeJson(root, '.llmwiki/library.json', { libraryId: '夹具库', formatVersion: 1, protocolVersion: 1 })
  await writeJson(root, 'state/writer.json', await localDevice())
  await writeJson(root, 'state/revocations.json', { generation: 0, sources: [] })
  const sources: SnapshotManifest['sources'] = [], pages: Record<string, string> = {}, deps: NonNullable<SnapshotManifest['deps']> = { pages: {}, reverse: {}, reverse_sources: {} }
  for (const sourceId of ['S-0001', 'S-0002']) {
    const text = `${sourceId} 的已发布证据。`, contentHash = hash(text), sourcePath = `objects/snapshots/${sourceId}/source.md`, extractionPath = `objects/snapshots/${sourceId}/extraction.json`
    await atomicWrite(root, sourcePath, text)
    const metadata = { title: sourceId, source_type: '文本', credibility: 'unknown' as const, credibility_reason: '', source_date: '2026-11-13', source_date_basis: '文件时间' as const }
    const processing = { tier: 3, prompt_version: version, model: '历史主模型' }
    await atomicWrite(root, extractionPath, JSON.stringify({ format_version: 1, source_id: sourceId, source_hash: contentHash, processing, metadata, calls: [], models: [{ provider: '历史', model: '模型并集' }], segments: [] }) + '\n')
    sources.push({ source_id: sourceId, origin_type: 'local', current_path: sourceId + '.md', previous_paths: [], content_hash: contentHash, source_version: contentHash, resource_version: [], segments: [], metadata, files: { source: sourcePath, assets: [] }, extract: { path: extractionPath, processing, processing_fingerprint: hash('旧指纹') }, revocation_generation: 0, updated_at: '2026-11-13' })
    const page = `sources/${sourceId}.md`; pages[page] = await putPage(root, text)
    deps.pages[page] = { sources: [sourceId], points: [] }; deps.reverse_sources![sourceId] = [page]
  }
  pages['index.md'] = await putPage(root, '# Wiki\n\n- [一](sources/S-0001.md)\n- [二](sources/S-0002.md)\n')
  deps.pages['index.md'] = { sources: [], points: [] }
  const manifest: SnapshotManifest = { format_version: 2, version: 'v000001', next_source_number: 3, revocation_generation: 0, sources, pages, deps, aliases: {}, card: { name: '旧库', domain: '', origin_type: 'local', source_type: '文本', default_credibility: 'unknown', source_count: 2, updated_at: '2026-11-13', format_version: 2 } }
  await atomicWrite(root, 'library.yaml', 'format_version: 2\norigin_type: local\nname: 旧库\n')
  await writeVersion(root, manifest); await writeJson(root, 'state/current.json', { version: manifest.version, revocation_generation: 0, history: [] })
  const original = await readFile(await safePath(root, 'versions/v000001.json'))
  return { ...f, manifest, original, policy: canonicalJson(defaultPolicy()) }
}
