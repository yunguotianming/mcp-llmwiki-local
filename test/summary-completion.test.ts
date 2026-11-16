import { readFile, rm } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { z } from 'zod'
import { layeredSettings } from '../src/domain/config.js'
import { jsonProtocol, schemaJSON } from '../src/llm/protocol.js'
import { atomicWrite, hash, writeJson } from '../src/layered/files.js'
import { legacyProvenance, mergeModels, protocolDigest, readProvenance, writeProvenance } from '../src/layered/models.js'
import { renderSource, resultFingerprint } from '../src/layered/extraction.js'
import { putPage } from '../src/layered/objects.js'
import { replaySummaryCompletion, summaryCompletionProof } from '../src/layered/summary-completion.js'
import { safePath } from '../src/storage/paths.js'
import { storageJson } from '../src/layered/vectors.js'
import { derivationFixture, derivedPending, publishDerived, activeExtraction } from './summary-derivation-fixture.js'
import { identity, prepare } from './b3-fixture.js'

async function completion() {
  const f = await derivationFixture(), source = f.manifest.sources[0]!
  const before = JSON.parse(await readFile(await safePath(f.root, source.extract.path), 'utf8')) as import('../src/layered/schema.js').Extraction
  const point = before.segments[0]!.points[0]!, group = before.group_cache!['甲']!
  const raw = JSON.parse(group.raw); raw.points[0].text = point.text; raw.points[0].evidence = point.evidence.map(({ locator, quote }) => ({ locator, quote })); group.raw = JSON.stringify(raw)
  before.group_cache = { '甲': group }; before.group_summaries = {}; before.summary_nodes = {}
  before.gaps!.push({ kind: 'point', segment_hashes: [], item: '原有非摘要缺口', reasons: [] })
  await atomicWrite(f.root, source.extract.path, JSON.stringify(before) + '\n')
  source.extract.processing_fingerprint = resultFingerprint(before)
  await writeJson(f.root, 'versions/v000001.json', { checksum: hash(storageJson(f.manifest)), manifest: f.manifest })
  f.provenance = await legacyProvenance(f.root, f.manifest, hash(storageJson(f.manifest))); await writeProvenance(f.root, f.provenance)
  const change = await derivedPending(f, []), settings = layeredSettings({}, before.processing.tier)
  const schema = z.object({ point_ids: z.array(z.string()).min(1).max(settings.sourceSummaryMaxPoints) })
  const prompt = jsonProtocol('从本组已校验要点选择摘要。只返回输入中的 point_ids，不修改要点或证据，数量不超过 point_limit。', schemaJSON(schema))
  const request = JSON.stringify({ source_id: source.source_id, summary_id: '甲', point_limit: settings.sourceSummaryMaxPoints,
    children: [{ id: '甲', points: [{ point_id: point.point_id, text: point.text }] }] })
  const id = identity(source.source_id + '/group-summary/甲'); id.operation = 'sourceSummary'; id.scope.sourceRefs = [{ sourceId: source.source_id, sourceVersion: source.source_version }]
  id.inputDigest = protocolDigest({ input: { request }, dependencies: [] }); id.promptDigest = protocolDigest(prompt); id.schemaDigest = protocolDigest(schemaJSON(schema))
  id.validatorVersion = id.semanticVersion = 'source-summary-v1'
  const output = { ids: [point.point_id], models: [{ provider: '离线桩', model: '新摘要模型' }] }
  const accepted = await prepare(f.root, { identity: id, content: JSON.stringify(output, null, 2) + '\n' }), ref = await accepted.commit()
  const after = change.after, summary = { id: '甲', point_ids: output.ids, models: output.models, missing: [], level: 0, children: [], fingerprint: hash(JSON.stringify(['甲', output.ids])), acceptedRef: ref }
  after.group_cache!['甲']!.missing_summary = false; after.group_cache!['甲']!.summary_models = output.models
  after.group_summaries = { '甲': summary }; after.summary = summary; after.summary_nodes = {}; Object.assign(after, { summary_plans: {}, summary_blocks: {} })
  after.gaps = after.gaps!.filter(gap => gap.kind !== 'summary')
  after.calls = after.summary_calls = [{ input_bytes: Buffer.byteLength(prompt + request), input_limit: 10000 }]
  after.models = mergeModels(before.models, output.models); after.actual_model = after.models[0]!.provider + '/' + after.models[0]!.model; after.processing.model = after.actual_model
  change.source.extract.processing = structuredClone(after.processing); change.source.extract.processing_fingerprint = resultFingerprint(after)
  await atomicWrite(f.root, change.source.extract.path, JSON.stringify(after) + '\n')
  change.pending.manifest.pages!['sources/' + source.source_id + '.md'] = await putPage(f.root, renderSource(change.source, after))
  Object.assign(change.pending, { acceptedRefs: { [id.scope.unitId]: ref } })
  const proof = await summaryCompletionProof(f.root, change.source, source, 'v000001', [ref], settings)
  return { f, ...change, before, after, proof, baseManifest: storageJson(f.manifest) }
}

it('旧非摘要缺口保留且有真实子接受时严格组合，不产生整份接受', async () => {
  const c = await completion(), records = await replaySummaryCompletion(c.f.root, c.before, c.after, c.source, c.proof, 0, c.baseManifest)
  expect(Object.keys(records)).toHaveLength(1); expect(c.source.acceptedRef).toBeUndefined()
  expect(c.after.gaps).toEqual(c.before.gaps!.filter(gap => gap.kind !== 'summary'))
})
it('真实接受来自另一来源版本时拒绝', async () => {
  const c = await completion(); c.source.source_version = hash('另一来源版本')
  await expect(replaySummaryCompletion(c.f.root, c.before, c.after, c.source, c.proof, 0, c.baseManifest)).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
})
it('最终摘要改变选点但接受原字节保持时拒绝', async () => {
  const c = await completion(); c.after.summary!.point_ids = ['未接受的其他选点']
  await expect(replaySummaryCompletion(c.f.root, c.before, c.after, c.source, c.proof, 0, c.baseManifest)).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
})
it('同来源同版本但改变旧要点证据时拒绝', async () => {
  const c = await completion(); c.after.segments[0]!.points[0]!.evidence[0]!.quote += '改变'
  await expect(replaySummaryCompletion(c.f.root, c.before, c.after, c.source, c.proof, 0, c.baseManifest)).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
})
it('发布混合作者链在接受工作目录清理后仍可读并严格重放', async () => {
  const c = await completion(), result = await publishDerived(c.f, c.pending)
  const artifact = activeExtraction(result.provenance, c.source.extract.path)
  expect(artifact.status).toBe('legacy-recorded'); expect(artifact.derivedFrom?.operation).toBe('source-summary-completion-v1')
  expect(artifact.legacyEvidence).toEqual(activeExtraction(c.f.provenance, c.f.manifest.sources[0]!.extract.path).legacyEvidence)
  await rm(await safePath(c.f.root, 'work/accepted'), { recursive: true, force: true })
  await expect(readProvenance(c.f.root, result.manifest.version!, hash(storageJson(result.manifest)))).resolves.toBeTruthy()
})

it('反例：错基线清单不能冒充原来源所属基线', async () => {
  const c = await completion(), manifest = JSON.parse(c.baseManifest); manifest.sources[0].extract.path = 'objects/其他基线.json'
  c.baseManifest = storageJson(manifest); c.proof.baseManifestChecksum = hash(c.baseManifest)
  await expect(replaySummaryCompletion(c.f.root, c.before, c.after, c.source, c.proof, 0, c.baseManifest)).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
})
it('反例：已冻结旧摘要计划被修改时拒绝', async () => {
  const c = await completion()
  Object.assign(c.before, { summary_plans: { frozen: [['旧候选']] } }); Object.assign(c.after, { summary_plans: { frozen: [['其他候选']] } })
  await expect(replaySummaryCompletion(c.f.root, c.before, c.after, c.source, c.proof, 0, c.baseManifest)).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
})
it('反例：没有真实任务消费的额外摘要计划被拒绝', async () => {
  const c = await completion(); Object.assign(c.after, { summary_plans: { forged: [[c.after.summary!.point_ids[0]]] } })
  await expect(replaySummaryCompletion(c.f.root, c.before, c.after, c.source, c.proof, 0, c.baseManifest)).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
})
it('反例：接受依赖没有闭合到内嵌原字节记录时拒绝', async () => {
  const c = await completion(), entry = c.proof.accepted[0]!
  entry.record.dependencies.push({ taskId: 't:' + 'a'.repeat(64), acceptedDigest: hash('缺失父项'), sourceRefs: entry.record.identity.scope.sourceRefs })
  entry.ref.digest = protocolDigest(entry.record)
  await expect(replaySummaryCompletion(c.f.root, c.before, c.after, c.source, c.proof, 0, c.baseManifest)).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
})
it('反例：接受输出内容相同但原字节被重排时拒绝', async () => {
  const c = await completion(), entry = c.proof.accepted[0]!; entry.output = JSON.stringify(JSON.parse(entry.output))
  await expect(replaySummaryCompletion(c.f.root, c.before, c.after, c.source, c.proof, 0, c.baseManifest)).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
})

async function inheritedCompletion(generation = 0) {
  const c = await completion(), published = await publishDerived(c.f, c.pending)
  const pending = structuredClone(c.pending); delete pending.source_scope
  pending.base_version = published.manifest.version; pending.version = pending.manifest.version = 'v000003'
  pending.manifest.revocation_generation = generation
  const next = await publishDerived({ ...c.f, manifest: published.manifest, provenance: published.provenance }, pending)
  await rm(await safePath(c.f.root, 'work/accepted'), { recursive: true, force: true })
  await rm(await safePath(c.f.root, 'versions/v000001.json'))
  return { c, next, artifact: activeExtraction(next.provenance, c.source.extract.path) }
}
it('继承：组合成果下一版原样继承且旧基线与接受目录清理后仍可读', async () => {
  const { c, next, artifact } = await inheritedCompletion()
  expect(artifact.inheritedFrom?.version).toBe('v000002')
  expect(artifact.derivedFrom?.operation).toBe('source-summary-completion-v1')
  await expect(readProvenance(c.f.root, 'v000003', hash(storageJson(next.manifest)))).resolves.toBeTruthy()
})
it('继承：无关撤权代数提高后仍按创建代数重放历史组合', async () => {
  const { c, next, artifact } = await inheritedCompletion(2)
  expect(artifact.derivedFrom?.operation === 'source-summary-completion-v1' && artifact.derivedFrom.proof.creationGeneration).toBe(0)
  await expect(readProvenance(c.f.root, 'v000003', hash(storageJson(next.manifest)))).resolves.toBeTruthy()
})
it('页面：其他正文不能冒用本轮摘要提取的作者链', async () => {
  const c = await completion()
  c.pending.manifest.pages!['sources/' + c.source.source_id + '.md'] = await putPage(c.f.root, '与已接受提取无关的正文')
  await expect(publishDerived(c.f, c.pending)).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
})
it('页面：来源页继承不能指向原基线而跳过本轮提取', async () => {
  const c = await completion(), published = await publishDerived(c.f, c.pending)
  const extraction = activeExtraction(published.provenance, c.source.extract.path)
  const page = Object.values(published.provenance.artifacts).find(artifact => artifact.pagePath === 'sources/' + c.source.source_id + '.md')!
  page.inheritedFrom!.artifactId = extraction.derivedFrom!.artifactId
  await expect(writeProvenance(c.f.root, published.provenance)).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
})
it('混链：本轮组合不能降成unknown并携带新生产记录绕过验证', async () => {
  const c = await completion(), published = await publishDerived(c.f, c.pending)
  const extraction = activeExtraction(published.provenance, c.source.extract.path)
  extraction.status = 'unknown'; extraction.reason = 'legacy-library'
  await expect(writeProvenance(c.f.root, published.provenance)).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
})
it('共享：基线只封存一份且普通继承剔除未引用快照', async () => {
  const c = await completion(), published = await publishDerived(c.f, c.pending)
  expect(Object.keys(published.provenance.derivationBases!)).toEqual([c.proof.baseManifestChecksum])
  expect(published.provenance.derivationBases![c.proof.baseManifestChecksum]).toBe(c.baseManifest)
  expect(c.proof).not.toHaveProperty('baseManifest')
  published.provenance.derivationBases![hash('无关基线')] = '无关基线'
  const pending = structuredClone(c.pending); delete pending.source_scope
  pending.base_version = published.manifest.version; pending.version = pending.manifest.version = 'v000003'
  const next = await publishDerived({ ...c.f, manifest: published.manifest, provenance: published.provenance }, pending)
  expect(Object.keys(next.provenance.derivationBases!)).toEqual([c.proof.baseManifestChecksum])
})
it('共享：缺失共享基线map或基线原字节hash不符时拒绝', async () => {
  const c = await completion(), published = await publishDerived(c.f, c.pending)
  const checksum = c.proof.baseManifestChecksum
  published.provenance.derivationBases![checksum] += ' '
  await expect(writeProvenance(c.f.root, published.provenance)).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
  delete published.provenance.derivationBases
  await expect(writeProvenance(c.f.root, published.provenance)).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
})
