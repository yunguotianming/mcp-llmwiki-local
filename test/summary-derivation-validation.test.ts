import { readFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { atomicWrite, hash } from '../src/layered/files.js'
import { artifactId, protocolDigest, readProvenance, validateProvenance, writeProtocol, writeProvenance } from '../src/layered/models.js'
import { storageJson } from '../src/layered/vectors.js'
import { safePath } from '../src/storage/paths.js'
import { activeExtraction, derivationFixture, derivedPending, publishDerived } from './summary-derivation-fixture.js'

it.each(['未知操作', '父项缺失', '派生含环', '作者洗白'] as const)('结构校验拒绝%s', async kind => {
  const f = await derivationFixture(), change = await derivedPending(f), second = await publishDerived(f, change.pending)
  const value = structuredClone(second.provenance), active = activeExtraction(value, change.source.extract.path), parentId = active.derivedFrom!.artifactId
  if (kind === '未知操作') (active.derivedFrom as { operation: string }).operation = '任意本地修改'
  if (kind === '父项缺失') delete value.artifacts[parentId]
  if (kind === '派生含环') value.artifacts[parentId]!.derivedFrom = { operation: 'source-summary-exclusion-v1', artifactId: artifactId(active) }
  if (kind === '作者洗白') active.status = 'local-derived'
  expect(() => validateProvenance(value, value.version, value.manifestChecksum)).toThrow()
})

it('父子摘要均重算并自洽仍不能绕过读写时的完整变换重放', async () => {
  const f = await derivationFixture(), change = await derivedPending(f), second = await publishDerived(f, change.pending)
  const value = structuredClone(second.provenance), active = activeExtraction(value, change.source.extract.path), oldId = artifactId(active)
  const result = JSON.parse(await readFile(await safePath(f.root, active.objectPath!), 'utf8'))
  result.segments[0].points[0].evidence[0].quote += '未接受的新证据'
  const bytes = JSON.stringify(result) + '\n'
  await atomicWrite(f.root, active.objectPath!, bytes)
  active.objectDigest = hash(bytes); delete value.artifacts[oldId]; value.artifacts[artifactId(active)] = active
  // 结构与字节摘要都自洽，但严格重放仍必须拒绝。
  expect(() => validateProvenance(value, value.version, value.manifestChecksum)).not.toThrow()
  await expect(writeProvenance(f.root, value)).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
  await writeProtocol(f.root, 'versions/' + value.version + '.provenance.json', { checksum: protocolDigest(value), provenance: value })
  await expect(readProvenance(f.root, value.version, hash(storageJson(second.manifest)))).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
})
