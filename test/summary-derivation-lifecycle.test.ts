import { readFile, unlink } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { atomicWrite, hash } from '../src/layered/files.js'
import { readProvenance } from '../src/layered/models.js'
import { readVersion } from '../src/layered/objects.js'
import { collectGarbage } from '../src/layered/retention.js'
import { copyWithEmbedding } from '../src/layered/query-vectors.js'
import { revokeSourcesAtRoot } from '../src/layered/revocations.js'
import { storageJson } from '../src/layered/vectors.js'
import { safePath } from '../src/storage/paths.js'
import { activeExtraction, derivationFixture, derivedPending, parentOf, publishDerived } from './summary-derivation-fixture.js'

it('后续普通发布保留稳定派生边，父版本退役后仍可独立读当前版', async () => {
  const f = await derivationFixture(), change = await derivedPending(f), second = await publishDerived(f, change.pending)
  const pending = structuredClone(change.pending)
  pending.base_version = second.manifest.version; pending.version = pending.manifest.version = 'v000003'
  const third = await publishDerived(second, pending), parent = parentOf(third.provenance, change.source.extract.path)
  expect(activeExtraction(third.provenance, change.source.extract.path).derivedFrom).toEqual(activeExtraction(second.provenance, change.source.extract.path).derivedFrom)
  await collectGarbage(f.root, 0)
  await expect(readFile(await safePath(f.root, 'versions/v000001.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(await safePath(f.root, parent.objectPath!))).resolves.toBeDefined()
  expect(await readProvenance(f.root, 'v000003', hash(storageJson(third.manifest)))).toEqual(third.provenance)
})

it('GC只保当前派生所需父对象，不保孤立提取或全部旧版本', async () => {
  const f = await derivationFixture(), change = await derivedPending(f), second = await publishDerived(f, change.pending)
  const unused = 'objects/snapshots/unused.json'; await atomicWrite(f.root, unused, '{}')
  await collectGarbage(f.root, 0)
  await expect(readFile(await safePath(f.root, parentOf(second.provenance, change.source.extract.path).objectPath!))).resolves.toBeDefined()
  await expect(readFile(await safePath(f.root, unused))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('正式向量复制保留独立派生边，删除父历史版本后复制库仍能读', async () => {
  const f = await derivationFixture(), change = await derivedPending(f), second = await publishDerived(f, change.pending)
  const copied = await copyWithEmbedding(f.root, { embeddingMode: 'ollama', localEmbeddingModel: 'qwen3-embedding:0.6b' }, true,
    { embeddingClient: { identity: async () => '本地假权重', embed: async texts => texts.map(() => [1, 0, 0]) } })
  await unlink(await safePath(copied.path, 'versions/v000001.json'))
  await unlink(await safePath(copied.path, 'versions/v000001.provenance.json'))
  const manifest = await readVersion(copied.path, copied.version), value = await readProvenance(copied.path, copied.version, hash(storageJson(manifest)))
  expect(activeExtraction(value, change.source.extract.path).derivedFrom).toEqual(activeExtraction(second.provenance, change.source.extract.path).derivedFrom)
  expect(copied.generation_calls).toBe(0)
})

it('读取父对象损坏或缺失时拒绝，不因当前子对象仍完好而放行', async () => {
  const f = await derivationFixture(), change = await derivedPending(f), second = await publishDerived(f, change.pending)
  const parent = parentOf(second.provenance, change.source.extract.path)
  await atomicWrite(f.root, parent.objectPath!, '{}\n')
  await expect(readProvenance(f.root, second.manifest.version!, hash(storageJson(second.manifest)))).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
})

it('撤权清除被撤来源的父子对象，同时保留另一来源的派生闭包', async () => {
  const f = await derivationFixture(), one = await derivedPending(f), second = await publishDerived(f, one.pending)
  const two = await derivedPending(second, ['甲'], 'S-0002'), third = await publishDerived(second, two.pending)
  const revoked = [one.source.extract.path, parentOf(third.provenance, one.source.extract.path).objectPath!]
  const kept = parentOf(third.provenance, two.source.extract.path).objectPath!
  await revokeSourcesAtRoot(f.root, ['S-0001'], '合成撤权验证')
  const manifest = await readVersion(f.root, third.manifest.version!), value = await readProvenance(f.root, manifest.version!, hash(storageJson(manifest)))
  expect(Object.values(value.artifacts).some(artifact => artifact.sourceRefs.some(ref => ref.sourceId === 'S-0001'))).toBe(false)
  for (const file of revoked) await expect(readFile(await safePath(f.root, file))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(await safePath(f.root, kept))).resolves.toBeDefined()
  expect(activeExtraction(value, two.source.extract.path).derivedFrom).toBeDefined()
})
