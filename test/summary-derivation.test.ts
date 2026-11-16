import { expect, it } from 'vitest'
import { readProvenance } from '../src/layered/models.js'
import { hash } from '../src/layered/files.js'
import { storageJson } from '../src/layered/vectors.js'
import { activeExtraction, derivationFixture, derivedPending, parentOf, publishDerived } from './summary-derivation-fixture.js'

it('旧未知提取的纯摘要排除保留未知作者，内嵌精确父项且来源页沿用作者链', async () => {
  const f = await derivationFixture(), change = await derivedPending(f), result = await publishDerived(f, change.pending)
  const active = activeExtraction(result.provenance, change.source.extract.path), parent = parentOf(result.provenance, change.source.extract.path)
  expect(active).toMatchObject({ status: 'unknown', reason: 'legacy-library', productionIds: [], derivedFrom: { operation: 'source-summary-exclusion-v1' } })
  expect(parent.objectPath).toBe(f.manifest.sources[0]!.extract.path)
  expect(active.legacyEvidence).toEqual(parent.legacyEvidence)
  expect(Object.values(result.provenance.artifacts).find(artifact => artifact.pagePath === 'sources/S-0001.md')).toMatchObject({ status: 'unknown', productionIds: [] })
  expect(await readProvenance(f.root, result.manifest.version!, hash(storageJson(result.manifest)))).toEqual(result.provenance)
})

it('真实旧接受仍在时优先验证本地排除，不把旧接受冒认新生成', async () => {
  const f = await derivationFixture(true), change = await derivedPending(f), result = await publishDerived(f, change.pending)
  const active = activeExtraction(result.provenance, change.source.extract.path)
  expect(active.status).toBe('recorded')
  expect(active.derivedFrom).toBeDefined()
  expect(active.productionIds).toEqual(parentOf(result.provenance, change.source.extract.path).productionIds)
  expect(result.provenance.records).toEqual(f.provenance.records)
  expect(change.source.acceptedRef).toEqual(f.manifest.sources[0]!.acceptedRef)
})

it('零模型回执未携带旧ref时仍保留旧真实生产链', async () => {
  const f = await derivationFixture(true), change = await derivedPending(f)
  delete change.source.acceptedRef
  const result = await publishDerived(f, change.pending)
  expect(activeExtraction(result.provenance, change.source.extract.path)).toMatchObject({ status: 'recorded', derivedFrom: { operation: 'source-summary-exclusion-v1' } })
  expect(result.provenance.records).toEqual(f.provenance.records)
})

it('连续两组确定性排除封存完整祖先，不依赖工作目录接受缓存', async () => {
  const first = await derivationFixture(), one = await derivedPending(first), second = await publishDerived(first, one.pending)
  const two = await derivedPending(second, ['乙']), third = await publishDerived(second, two.pending)
  const parent = parentOf(third.provenance, two.source.extract.path)
  expect(parent.derivedFrom).toBeDefined()
  expect(third.provenance.artifacts[parent.derivedFrom!.artifactId]!.objectPath).toBe(first.manifest.sources[0]!.extract.path)
  expect(activeExtraction(third.provenance, two.source.extract.path).status).toBe('unknown')
})

it('父项只能选基线当前提取，不能借历史祖先证明回退的新对象', async () => {
  const f = await derivationFixture(), one = await derivedPending(f), second = await publishDerived(f, one.pending)
  const two = await derivedPending(second, ['乙'])
  // 回退第一组再排除第二组，仅对历史祖先成立，无法从当前提取重放。
  two.after.group_cache!['甲']!.missing_summary = true; delete two.after.group_cache!['甲']!.summary_excluded_reason
  const { atomicWrite } = await import('../src/layered/files.js')
  await atomicWrite(f.root, two.source.extract.path, JSON.stringify(two.after) + '\n')
  await expect(publishDerived(second, two.pending)).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
})
