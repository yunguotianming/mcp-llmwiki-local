import { readFile, unlink } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { atomicWrite, hash, writeJson } from '../src/layered/files.js'
import { createExecutionLedger } from '../src/layered/costs.js'
import { artifactId, legacyProvenance, productionId, protocolDigest, publicationProvenance, readProvenance, validateProvenance, writeProtocol } from '../src/layered/models.js'
import { storageJson } from '../src/layered/vectors.js'
import { safePath } from '../src/storage/paths.js'
import { readVersion } from '../src/layered/objects.js'
import { upgradeLibrary } from '../src/layered/upgrade.js'
import { revokeSourcesAtRoot } from '../src/layered/revocations.js'
import type { PendingBuild, ProductionArtifact, ProductionRecord, SnapshotManifest } from '../src/layered/schema.js'
import { finish, identity, legacyFixture, prepare, request, taskIdOf } from './b3-fixture.js'

const pendingOf = (manifest: SnapshotManifest): PendingBuild => ({ format_version: 2, base_version: 'v000001', version: 'v000002', manifest: { ...manifest, version: 'v000002' }, card: manifest.card!, added: [], model_calls: 0, started_at: '2026-11-13' })
const labels = { fingerprint: hash('补标'), labels: ['方法'], keywords: ['证据'], model: '历史模型' }

it('旧补标和归并保存未知证据，空归并是本地派生', async () => {
  const f = await legacyFixture()
  f.manifest.point_labels = { 'S-0001:P1': labels }
  f.manifest.tag_merges = { checked: ['方法'], groups: [{ canonical: '方法', tags: ['研究方法'] }], models: [{ provider: '历史', model: '旧模型' }] }
  const prior = await legacyProvenance(f.root, f.manifest, hash(storageJson(f.manifest)))
  const metadata = Object.values(prior.artifacts).filter(a => a.kind === 'metadata')
  expect(metadata).toHaveLength(2)
  expect(metadata.every(a => a.status === 'unknown' && a.reason === 'legacy-library' && a.legacyEvidence?.length)).toBe(true)
  expect(metadata.find(a => a.metadata?.target === 'S-0001:P1')?.sourceRefs[0]?.sourceId).toBe('S-0001')
  const pending = pendingOf({ ...f.manifest, tag_merges: { checked: [], groups: [] } })
  const result = await publicationProvenance(f.root, pending, hash(storageJson(pending.manifest)), prior)
  expect(Object.values(result.artifacts).find(a => a.metadata?.target === 'tag_merges')?.status).toBe('local-derived')
})

it('新补标必须接受，已发布生产链在接受缓存清除后仍可继承', async () => {
  const f = await legacyFixture(), prior = await legacyProvenance(f.root, f.manifest, hash(storageJson(f.manifest)))
  const pending = pendingOf({ ...f.manifest, point_labels: { 'S-0001:P1': labels } })
  await expect(publicationProvenance(f.root, pending, hash(storageJson(pending.manifest)), prior)).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
  const accepted = await prepare(f.root), ref = await accepted.commit()
  pending.manifest.point_labels!['S-0001:P1']!.acceptedRef = ref
  const result = await publicationProvenance(f.root, pending, hash(storageJson(pending.manifest)), prior)
  expect(Object.values(result.artifacts).find(a => a.metadata?.target === 'S-0001:P1')?.status).toBe('recorded')
  await unlink(await safePath(f.root, ref.path)); await unlink(await safePath(f.root, `logs/model-accepts/${ref.taskId.slice(2)}.json`))
  const next = pendingOf(pending.manifest); next.manifest.version = 'v000003'
  const inherited = await publicationProvenance(f.root, next, hash(storageJson(next.manifest)), result)
  expect(Object.values(inherited.artifacts).find(a => a.metadata?.target === 'S-0001:P1')?.inheritedFrom?.version).toBe('v000002')
  expect(() => validateProvenance(inherited, 'v000003', hash(storageJson(next.manifest)))).not.toThrow()
})

it('核对及纠正旧未知产物保留闭合父链，相同字节重新生成记录新作者', async () => {
  const f = await legacyFixture(), hooks = createExecutionLedger(f.root)
  let prior = await legacyProvenance(f.root, f.manifest, hash(storageJson(f.manifest)))
  let outputPath = f.manifest.sources[0]!.extract.path
  for (const sequence of [1, 2, 3]) {
    const id = identity('核对' + sequence, 'extractionReview'), taskId = taskIdOf(id), req = request(taskId, sequence, '备用', undefined, id.stage)
    await finish(hooks, req)
    let bytes = await readFile(await safePath(f.root, outputPath))
    if (sequence === 2) {
      bytes = Buffer.from(bytes.toString('utf8') + '\n'); outputPath = 'objects/snapshots/S-0001/corrected.json'
      await atomicWrite(f.root, outputPath, bytes.toString('utf8'))
    }
    const output = { path: outputPath, digest: hash(bytes), bytes: bytes.length, encoding: 'utf8-json' as const }
    const production: ProductionRecord = { taskId, stage: id.stage, operation: id.operation, role: sequence === 3 ? 'generate' : sequence === 2 ? 'correct' : 'review', outputDigest: output.digest, lineId: req.candidate.lineId, provider: req.candidate.provider, requestedModel: req.candidate.requestedModel, reportedModel: null, parameters: req.candidate.parameters, bindingRevision: req.candidate.bindingRevision, capabilityRevision: req.candidate.capabilityRevision, parentProductionIds: [] }
    const record = { schema: 'llmwiki-accepted-v1' as const, taskId, identity: id, output, validation: { status: 'accepted' as const, validatorVersion: id.validatorVersion, schemaDigest: id.schemaDigest }, productions: { [productionId(production)]: production }, dependencies: [] }
    const prepared = await hooks.prepareAccepted({ taskId, record, responseAttemptId: req.attemptId, acceptedAttemptIds: [req.attemptId] })
    const digest = protocolDigest(record), file = `work/accepted/tasks/${taskId.slice(2)}.json`
    await writeProtocol(f.root, file, { ...record, acceptedDigest: digest }); await hooks.onAccepted({ taskId, prepareId: prepared.prepareId, acceptedDigest: digest })
    const pending = pendingOf(structuredClone(f.manifest)); pending.manifest.version = `v00000${sequence + 1}`
    pending.manifest.sources[0]!.extract.path = outputPath
    pending.manifest.sources[0]!.acceptedRef = { taskId, path: file, digest }
    prior = await publicationProvenance(f.root, pending, hash(storageJson(pending.manifest)), prior)
    expect(Object.values(prior.artifacts).find(a => a.objectPath === output.path)?.status).toBe(sequence === 3 ? 'recorded' : 'legacy-recorded')
    expect(Object.values(prior.artifacts).find(a => a.objectPath === output.path)?.productionIds).toHaveLength(sequence === 2 ? 2 : 1)
    expect(() => validateProvenance(prior, pending.manifest.version!, hash(storageJson(pending.manifest)))).not.toThrow()
  }
}, 20000)

it('升级附属元数据在依赖有效时继承，来源变更后解除旧引用', async () => {
  const f = await legacyFixture(), prior = await legacyProvenance(f.root, f.manifest, hash(storageJson(f.manifest)))
  const metadata = { target: '升级简介', fields: ['summary'], value: '已验证的简介' }
  const artifact: ProductionArtifact = { kind: 'metadata', objectPath: null, pagePath: null, objectDigest: protocolDigest(metadata), sourceRefs: [{ sourceId: 'S-0001', sourceVersion: f.manifest.sources[0]!.source_version }], status: 'unknown', reason: 'legacy-library', productionIds: [], inheritedFrom: null, metadata }
  prior.artifacts[artifactId(artifact)] = artifact
  const pending = pendingOf(structuredClone(f.manifest))
  expect((await publicationProvenance(f.root, pending, hash(storageJson(pending.manifest)), prior)).artifacts[artifactId(artifact)]?.inheritedFrom?.version).toBe('v000001')
  pending.manifest.sources[0]!.source_version = hash('变更后的来源')
  expect((await publicationProvenance(f.root, pending, hash(storageJson(pending.manifest)), prior)).artifacts[artifactId(artifact)]).toBeUndefined()
})

it('撤权移除被撤补标及无法按来源拆分的归并，保留其他来源的补标', async () => {
  const f = await legacyFixture()
  f.manifest.point_labels = { 'S-0001:P1': labels, 'S-0002:P1': labels }
  f.manifest.tag_merges = { checked: ['方法'], groups: [{ canonical: '方法', tags: ['旧别名'] }] }
  await writeJson(f.root, 'versions/v000001.json', { checksum: hash(storageJson(f.manifest)), manifest: f.manifest })
  await upgradeLibrary(f.root); await revokeSourcesAtRoot(f.root, ['S-0001'], '撤权元数据验证')
  const manifest = await readVersion(f.root, 'v000001'), provenance = await readProvenance(f.root, 'v000001', hash(storageJson(manifest)))
  expect(Object.keys(manifest.point_labels!)).toEqual(['S-0002:P1'])
  expect(manifest.tag_merges).toBeUndefined()
  expect(Object.values(provenance.artifacts).filter(a => a.kind === 'metadata').map(a => a.metadata?.target)).toEqual(['S-0002:P1'])
}, 20000)
