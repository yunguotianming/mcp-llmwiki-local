import { expect, it } from 'vitest'
import { atomicWrite } from '../src/layered/files.js'
import { derivationFixture, derivedPending, publishDerived } from './summary-derivation-fixture.js'

it.each(['要点', '证据', '来源版本', '计划', '模型'] as const)('纯排除同时改变%s时拒绝沿用旧接受或旧作者', async kind => {
  const f = await derivationFixture(true), change = await derivedPending(f)
  if (kind === '要点') change.after.segments[0]!.points[0]!.text += '改变'
  if (kind === '证据') change.after.segments[0]!.points[0]!.evidence[0]!.quote += '改变'
  if (kind === '来源版本') change.source.source_version += '改变'
  if (kind === '计划') change.after.chunk_plan![0]![0]!.text += '改变'
  if (kind === '模型') change.after.models!.push({ provider: '新作者', model: '新模型' })
  await atomicWrite(f.root, change.source.extract.path, JSON.stringify(change.after) + '\n')
  await expect(publishDerived(f, change.pending)).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
})
