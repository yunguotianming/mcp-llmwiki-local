import { readFile } from 'node:fs/promises'
import { atomicWrite, hash, writeJson } from '../src/layered/files.js'
import { artifactId, legacyProvenance, publicationProvenance, writeProvenance } from '../src/layered/models.js'
import { excludeEmptySourceSummary, resultFingerprint } from '../src/layered/extraction.js'
import { putPage, readVersion, writeVersion } from '../src/layered/objects.js'
import { storageJson } from '../src/layered/vectors.js'
import { safePath } from '../src/storage/paths.js'
import { writeVersionCosts } from '../src/layered/costs.js'
import type { Extraction, PendingBuild, VersionProvenance } from '../src/layered/schema.js'
import { identity, legacyFixture, prepare } from './b3-fixture.js'

export async function derivationFixture(recorded = false) {
  const f = await legacyFixture()
  for (const source of f.manifest.sources) {
    const extraction: Extraction = JSON.parse(await readFile(await safePath(f.root, source.extract.path), 'utf8'))
    const part = { paragraph_id: 0, locator: 'L1-L1', text_hash: source.content_hash, text: source.source_id + ' 的已发布证据。' }
    extraction.chunk_plan = [[part]]; extraction.plan_config_fingerprint = hash('冻结计划'); extraction.grouping_fingerprint = hash('冻结分组')
    extraction.group_cache = Object.fromEntries(['甲', '乙'].map(key => [key, { parts: [part], quota: 1, missing_summary: true,
      raw: JSON.stringify({ tags: [], credibility: 'unknown', credibility_reason: null,
        points: [{ paragraph_id: 0, text: '未接受的旧候选' + key, section: '主要发现', evidence: [{ locator: 'L1-L1', quote: part.text }] }], terms: [] }) }]))
    extraction.gaps = [{ kind: 'summary', segment_hashes: [part.text_hash], item: null, reasons: [{ rule: 'summary-support', expected: '有效摘要', actual: '摘要缺口' }] }]
    extraction.segments = [{ locator: 'L1-L1', text_hash: part.text_hash, start: 1, end: 1, resource_hashes: [], processing_fingerprint: hash('处理身份'), terms: [],
      points: [{ point_id: source.source_id + ':P1', source_version: source.source_version, text: '旧已接受结论', text_hash: hash('旧已接受结论'), locator: 'L1-L1', section: '主要发现',
        evidence: [{ source_id: source.source_id, source_version: source.source_version, locator: 'L1-L1', quote: part.text }] }] }]
    source.extract.processing_fingerprint = resultFingerprint(extraction)
    await atomicWrite(f.root, source.extract.path, JSON.stringify(extraction) + '\n')
  }
  let accepted: Awaited<ReturnType<typeof prepare>> | undefined
  if (recorded) {
    const id = identity('真实旧提取'); id.scope.sourceRefs = [{ sourceId: f.manifest.sources[0]!.source_id, sourceVersion: f.manifest.sources[0]!.source_version }]
    accepted = await prepare(f.root, { identity: id }); f.manifest.sources[0]!.acceptedRef = await accepted.commit()
  }
  await writeJson(f.root, 'versions/v000001.json', { checksum: hash(storageJson(f.manifest)), manifest: f.manifest })
  const manifest = await readVersion(f.root, 'v000001', false), checksum = hash(storageJson(manifest)), provenance = await legacyProvenance(f.root, manifest, checksum)
  if (accepted) {
    const artifact = Object.values(provenance.artifacts).find(artifact => artifact.kind === 'extraction' && artifact.objectPath === manifest.sources[0]!.extract.path)!
    artifact.status = 'recorded'; delete artifact.reason; delete artifact.legacyEvidence
    artifact.productionIds = Object.keys(accepted.accepted.productions); Object.assign(provenance.records, accepted.accepted.productions)
  }
  await writeProvenance(f.root, provenance)
  await writeVersionCosts(f.root, manifest.version!, checksum, [])
  await writeJson(f.root, '.llmwiki/policy.json', { ...JSON.parse(f.policy), libraryFormat: '0.3.0' })
  return { ...f, manifest, provenance }
}
export async function derivedPending(f: Awaited<ReturnType<typeof derivationFixture>>, keys = ['甲'], sourceId = 'S-0001') {
  const manifest = structuredClone(f.manifest), source = manifest.sources.find(source => source.source_id === sourceId)!
  const before: Extraction = JSON.parse(await readFile(await safePath(f.root, source.extract.path), 'utf8')), after = structuredClone(before)
  for (const key of keys) excludeEmptySourceSummary(after, key, [])
  source.extract.path = source.extract.path.replace('.json', '-' + keys.join('') + '.json')
  await atomicWrite(f.root, source.extract.path, JSON.stringify(after) + '\n')
  manifest.version = 'v' + String(Number(f.manifest.version!.slice(1)) + 1).padStart(6, '0')
  manifest.pages!['sources/' + sourceId + '.md'] = await putPage(f.root, sourceId + '旧证据\n\n摘要排除：' + keys.join('、'))
  const pending: PendingBuild = { format_version: 2, base_version: f.manifest.version, version: manifest.version, manifest,
    card: manifest.card!, added: [], model_calls: 0, started_at: '2026-11-16',
    source_scope: { request: { sourceIds: [sourceId], kinds: ['summary'] }, completed: [sourceId], source_input: '', affected_topics: [], changed_points: [] } }
  return { pending, before, after, source }
}
export async function publishDerived(f: Awaited<ReturnType<typeof derivationFixture>>, pending: PendingBuild) {
  await writeVersion(f.root, pending.manifest)
  const checksum = hash(storageJson(pending.manifest)), provenance = await publicationProvenance(f.root, pending, checksum, f.provenance)
  await writeProvenance(f.root, provenance)
  await writeVersionCosts(f.root, pending.manifest.version!, checksum, [])
  await writeJson(f.root, 'state/current.json', { version: pending.manifest.version, revocation_generation: 0, history: [f.manifest.version] })
  return { ...f, manifest: pending.manifest, provenance }
}
export function activeExtraction(value: VersionProvenance, path: string) {
  return Object.values(value.artifacts).find(artifact => artifact.kind === 'extraction' && artifact.objectPath === path)!
}
export const parentOf = (value: VersionProvenance, path: string) => value.artifacts[activeExtraction(value, path).derivedFrom!.artifactId]!
export { artifactId }
