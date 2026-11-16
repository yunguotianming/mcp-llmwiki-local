import { cp, readFile, readdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'vitest'
import { hash, writeJson } from '../src/layered/files.js'
import { legacyProvenance, productionId, publicationProvenance, readProvenance, validateProductions, writeProvenance } from '../src/layered/models.js'
import { readVersion, writeVersion } from '../src/layered/objects.js'
import { collectGarbage, pinVersion } from '../src/layered/retention.js'
import { activatePublication, finishPublication } from '../src/layered/publication.js'
import { upgradeLibrary } from '../src/layered/upgrade.js'
import { writeVersionCosts } from '../src/layered/costs.js'
import { revokeSourcesAtRoot } from '../src/layered/revocations.js'
import { safePath } from '../src/storage/paths.js'
import { storageJson } from '../src/layered/vectors.js'
import { copyWithEmbedding } from '../src/layered/query-vectors.js'
import type { PendingBuild, ProductionRecord } from '../src/layered/schema.js'
import { identity, legacyFixture, prepare, runId, taskIdOf } from './b3-fixture.js'

it('生成、核对、纠正和继承链闭合，旧未知与本地派生区分且不改旧字节', async () => {
  const f = await legacyFixture(), accepted = await prepare(f.root)
  const generated = accepted.record, review: ProductionRecord = { ...generated, taskId: taskIdOf(identity('核对', 'extractionReview')), stage: 'extractionReview', role: 'review', parentProductionIds: [productionId(generated)] }
  const correct: ProductionRecord = { ...generated, taskId: taskIdOf(identity('纠正', 'extractionReview')), stage: 'extractionReview', role: 'correct', parentProductionIds: [productionId(review)] }
  const records = { [productionId(generated)]: generated, [productionId(review)]: review, [productionId(correct)]: correct }
  expect(() => validateProductions(records)).not.toThrow()
  expect(() => validateProductions({ [productionId(correct)]: correct })).toThrow()
  const checksum = hash(storageJson(f.manifest)), previous = await legacyProvenance(f.root, f.manifest, checksum)
  const pending: PendingBuild = { format_version: 2, base_version: 'v000001', version: 'v000002', manifest: { ...f.manifest, version: 'v000002' }, card: f.manifest.card!, added: [], model_calls: 0, started_at: '2026-11-13' }
  const inherited = await publicationProvenance(f.root, pending, hash(storageJson(pending.manifest)), previous)
  expect(Object.values(inherited.artifacts).filter(a => a.status === 'unknown').every(a => a.reason === 'legacy-library' && a.inheritedFrom?.version === 'v000001')).toBe(true)
  expect(Object.values(inherited.artifacts).find(a => a.pagePath === 'index.md')?.status).toBe('local-derived')
  expect(await readFile(await safePath(f.root, 'versions/v000001.json'))).toEqual(f.original)
})

it('发布切换前后附属完整，收尾删除 pending，准备输出受 GC 保护且复制不丢归属', async () => {
  const f = await legacyFixture(); await upgradeLibrary(f.root)
  const accepted = await prepare(f.root)
  const manifest = { ...f.manifest, version: 'v000002' }, checksum = hash(storageJson(manifest))
  const pending: PendingBuild = { format_version: 2, acceptedProtocol: 1, runId, base_version: 'v000001', version: 'v000002', manifest, card: manifest.card!, added: [], model_calls: 0, started_at: '2026-11-13' }
  await writeVersion(f.root, manifest)
  const previous = await readProvenance(f.root, 'v000001', hash(storageJson(f.manifest)))
  pending.provenanceRef = await writeProvenance(f.root, await publicationProvenance(f.root, pending, checksum, previous))
  pending.costsRef = await writeVersionCosts(f.root, 'v000002', checksum, [runId])
  await writeJson(f.root, 'work/pending.json', pending)
  expect(await activatePublication(f.root, pending)).toBe('v000002')
  await expect(readFile(await safePath(f.root, 'work/pending.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await collectGarbage(f.root, 0)
  await expect(readFile(await safePath(f.root, accepted.accepted.output.path))).resolves.toBeDefined()
  const copied = path.join(f.parent, '.llmwiki-copy'); await cp(f.root, copied, { recursive: true })
  expect(await readVersion(copied, 'v000002')).toEqual(manifest)
  expect(await readProvenance(copied, 'v000002', checksum)).toEqual(await readProvenance(f.root, 'v000002', checksum))
  // 模拟 current 已切而 pending 尚在的恢复收尾。
  await writeJson(f.root, 'work/pending.json', pending); await finishPublication(f.root, pending)
}, 20000)

it('当前附属损坏回退完整旧版，退役及取消版本的附属文件随 GC 删除', async () => {
  const f = await legacyFixture(); await upgradeLibrary(f.root)
  for (const version of ['v000002', 'v000003']) {
    const manifest = { ...f.manifest, version }, checksum = hash(storageJson(manifest))
    await writeVersion(f.root, manifest)
    await writeProvenance(f.root, await legacyProvenance(f.root, manifest, checksum))
    await writeVersionCosts(f.root, version, checksum, [])
  }
  await writeJson(f.root, 'state/current.json', { version: 'v000002', revocation_generation: 0, history: ['v000001'] })
  await unlink(await safePath(f.root, 'versions/v000002.provenance.json'))
  const pin = await pinVersion(f.root)
  expect(pin.manifest.version).toBe('v000001'); expect(pin.warning).toContain('上一完整版本'); await pin.release()
  await writeJson(f.root, 'state/current.json', { version: 'v000001', revocation_generation: 0, history: [] })
  // 取消入口已删主版本时，孤立附属仍应清理。
  await unlink(await safePath(f.root, 'versions/v000003.json')); await collectGarbage(f.root, 0)
  const files = await readdir(await safePath(f.root, 'versions'))
  expect(files.some(file => file.startsWith('v000002') || file.startsWith('v000003'))).toBe(false)
})

it('撤权清理接受与生产关联，保留未撤来源及成本累计并可重入', async () => {
  const f = await legacyFixture(); await upgradeLibrary(f.root)
  const id = identity('被撤'); id.scope.sourceRefs = [{ sourceId: 'S-0001', sourceVersion: f.manifest.sources[0]!.source_version }]
  const accepted = await prepare(f.root, { identity: id }); await accepted.commit()
  const keepId = identity('保留'); keepId.scope.sourceRefs = [{ sourceId: 'S-0002', sourceVersion: f.manifest.sources[1]!.source_version }]
  const keep = await prepare(f.root, { identity: keepId, sequence: 2 }); await keep.commit()
  await revokeSourcesAtRoot(f.root, ['S-0001'], '离线撤权用例')
  expect((await accepted.hooks.readAcceptance(accepted.accepted.taskId)).status).toBe('missing')
  expect((await keep.hooks.readAcceptance(keep.accepted.taskId)).status).toBe('bound')
  const manifest = await readVersion(f.root, 'v000001'), provenance = await readProvenance(f.root, 'v000001', hash(storageJson(manifest)))
  expect(manifest.sources.map(s => s.source_id)).toEqual(['S-0002'])
  expect(Object.values(provenance.artifacts).some(a => a.sourceRefs.some(s => s.sourceId === 'S-0001'))).toBe(false)
  await expect(readFile(await safePath(f.root, keep.accepted.output.path))).resolves.toBeDefined()
  await revokeSourcesAtRoot(f.root, ['S-0001'], '重复撤权')
  await expect(readVersion(f.root, 'v000001')).resolves.toBeDefined()
}, 20000)

it('切换向量的正式复制链路内嵌继承生产记录，重绑定新清单摘要并保留旧版本', async () => {
  const f = await legacyFixture(); await upgradeLibrary(f.root)
  const result = await copyWithEmbedding(f.root, { embeddingMode: 'ollama', localEmbeddingModel: 'qwen3-embedding:0.6b' }, true,
    { embeddingClient: { identity: async () => '离线权重', embed: async inputs => inputs.map(() => [1, 0, 0]) } })
  const next = await readVersion(result.path, result.version)
  const provenance = await readProvenance(result.path, result.version, hash(storageJson(next)))
  expect(Object.values(provenance.artifacts).every(a => a.inheritedFrom?.version === 'v000001')).toBe(true)
  expect(await readFile(await safePath(result.path, 'versions/v000001.json'))).toEqual(f.original)
  expect(await readFile(await safePath(f.root, 'versions/v000001.json'))).toEqual(f.original)
  expect(result.generation_calls).toBe(0)
})
