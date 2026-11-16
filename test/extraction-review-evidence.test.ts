import { expect, it } from 'vitest'
import { reviewExtraction, reviewFingerprint } from '../src/layered/review.js'
import { reviewFixture } from './quality-fix2-audit-fixture.js'

function fixture() {
  const f = reviewFixture()
  return { ...f, source: { ...f.source, sourceId: 'S-0001', sourceVersion: 'v1' }, point: f.extraction.segments[0]!.points[0]! }
}

it('实际邻文改变而声明摘要与引文不变时重新核对，随后同证据零调用', async () => {
  const f = fixture()
  await reviewExtraction(f.extraction, f.source, f.options, 100000)
  const previous = f.point.verification!.fingerprint
  f.source.text = f.source.text.replace('前一', '该结果仅适用于实验组，不能推广至对照组。')
  f.source.segments[0]!.end = f.source.text.length
  f.call.mockClear()
  expect(await reviewExtraction(f.extraction, f.source, f.options, 100000)).toBe(1)
  expect(f.call).toHaveBeenCalledTimes(1)
  expect(f.point.verification!.fingerprint).not.toBe(previous)
  f.call.mockClear()
  expect(await reviewExtraction(f.extraction, f.source, f.options, 100000)).toBe(0)
  expect(f.call).not.toHaveBeenCalled()
})

it('逐字引文相同但证据定位改变时重新核对', async () => {
  const f = fixture()
  f.source.text = f.source.text.replace('后一', '结果提高。')
  f.source.segments[0]!.end = f.source.text.length
  await reviewExtraction(f.extraction, f.source, f.options, 100000)
  f.point.locator = f.point.evidence[0]!.locator = 'L5-L5'
  f.call.mockClear()
  expect(await reviewExtraction(f.extraction, f.source, f.options, 100000)).toBe(1)
  expect(f.call).toHaveBeenCalledTimes(1)
})

it('来源版本重绑后补核一次，同一版本续跑零调用', async () => {
  const f = fixture()
  await reviewExtraction(f.extraction, f.source, f.options, 100000)
  f.source.sourceVersion = f.point.source_version = f.point.evidence[0]!.source_version = 'v2'
  f.call.mockClear()
  expect(await reviewExtraction(f.extraction, f.source, f.options, 100000)).toBe(1)
  expect(f.call).toHaveBeenCalledTimes(1)
  f.call.mockClear()
  expect(await reviewExtraction(f.extraction, f.source, f.options, 100000)).toBe(0)
  expect(f.call).not.toHaveBeenCalled()
})

it('同文同版本换来源身份后不能继承原来源的通过状态', async () => {
  const f = fixture()
  await reviewExtraction(f.extraction, f.source, f.options, 100000)
  f.source.sourceId = f.extraction.source_id = f.point.evidence[0]!.source_id = 'S-0002'
  f.call.mockClear()
  expect(await reviewExtraction(f.extraction, f.source, f.options, 100000)).toBe(1)
  expect(f.call).toHaveBeenCalledTimes(1)
})

it('未绑定实际原文的旧指纹不能直接视为已通过', async () => {
  const f = fixture()
  f.point.verification = { status: 'verified', missing: '', fingerprint: reviewFingerprint(f.point) }
  expect(await reviewExtraction(f.extraction, f.source, f.options, 100000)).toBe(1)
  expect(f.call).toHaveBeenCalledTimes(1)
})
