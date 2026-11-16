import { expect, it } from 'vitest'
import { reviewExtraction } from '../src/layered/review.js'
import { point, reviewFixture } from './quality-fix2-audit-fixture.js'

it.each(['实际来源错绑', '正文摘要错绑', '缺少证据', '非法定位'])('%s不能成为已核实结果', async kind => {
  const f = reviewFixture(), p = f.extraction.segments[0]!.points[0]!
  const source = { ...f.source, sourceId: kind === '实际来源错绑' ? 'S-0002' : 'S-0001' }
  if (kind === '正文摘要错绑') f.extraction.source_hash = '错误摘要'
  if (kind === '缺少证据') p.evidence = []
  if (kind === '非法定位') p.evidence[0]!.locator = 'L0-L999'
  expect(await reviewExtraction(f.extraction, source, f.options, 100000)).toBe(0)
  expect(f.call).not.toHaveBeenCalled()
  expect(p.verification).toMatchObject({ status: 'unverified', missing: expect.stringContaining('核对证据无效：') })
  expect(f.extraction.segments[0]!.points).toHaveLength(1)
})

it('同批非法证据只留该项缺口，不阻断合法要点的正常核对', async () => {
  const bad = point(), good = point('结果提高。', '方法', 'P2'), f = reviewFixture([bad, good])
  bad.evidence[0]!.source_id = 'S-0002'
  expect(await reviewExtraction(f.extraction, f.source, f.options, 100000)).toBe(1)
  expect(f.call).toHaveBeenCalledTimes(1)
  expect(JSON.parse(f.call.mock.calls[0]![2]).points.map((item: any) => item.id)).toEqual(['P2'])
  expect(bad.verification?.status).toBe('unverified')
  expect(good.verification?.status).toBe('verified')
  expect(f.extraction.gaps).toMatchObject([{ kind: 'unverified_claim', item: { point_id: bad.point_id } }])
})
