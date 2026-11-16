import { expect, it } from 'vitest'
import { atomicWrite } from '../src/layered/files.js'
import { identity, prepare } from './b3-fixture.js'
import { activeExtraction, derivationFixture, derivedPending, publishDerived } from './summary-derivation-fixture.js'

it('旧未知内容补出真实新摘要时保留旧贡献，不把摘要generate当成整份提取作者', async () => {
  const f = await derivationFixture(), change = await derivedPending(f)
  change.after.group_summaries = { '甲': { id: '甲', point_ids: [change.after.segments[0]!.points[0]!.point_id], missing: [], level: 0, children: [], fingerprint: '新摘要指纹' } }
  const id = identity('摘要真实新生成'); id.scope.sourceRefs = [{ sourceId: change.source.source_id, sourceVersion: change.source.source_version }]
  const accepted = await prepare(f.root, { identity: id, content: JSON.stringify(change.after) })
  change.source.acceptedRef = await accepted.commit()
  await atomicWrite(f.root, change.source.extract.path, JSON.stringify(change.after) + '\n')
  const result = await publishDerived(f, change.pending), extraction = activeExtraction(result.provenance, change.source.extract.path)
  expect(extraction).toMatchObject({ status: 'legacy-recorded', legacyEvidence: activeExtraction(f.provenance, f.manifest.sources[0]!.extract.path).legacyEvidence })
  expect(extraction.derivedFrom).toBeUndefined()
  expect(extraction.productionIds.some(id => result.provenance.records[id]?.role === 'generate')).toBe(true)
  expect(Object.values(result.provenance.artifacts).find(artifact => artifact.pagePath === 'sources/S-0001.md')!.status).toBe('legacy-recorded')
})
