import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { hash } from '../src/layered/files.js'
import { upgradeLibrary } from '../src/layered/upgrade.js'
import { evidenceFixture, leaf } from './upgrade-evidence-fixture.js'

beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('成员完整性回归禁止网络') })))
afterEach(() => vi.unstubAllGlobals())

it('仅篡改后代依赖摘要仍拒绝，不能忽略dep与point的绑定', async () => {
  const f = await evidenceFixture()
  f.manifest.deps!.pages[leaf]!.points[0]!.text_hash = hash('被篡改的依赖摘要'); await f.save()
  await expect(upgradeLibrary(f.root, f.client().upgradeOptions)).rejects.toMatchObject({ code: 'UPGRADE_ROOT_INCOMPLETE' })
  expect(f.calls).toEqual([])
})

it('仅篡改point所属extraction段摘要仍拒绝，dep与point一致不能掩盖错段', async () => {
  const f = await evidenceFixture()
  f.extraction.segments[0]!.text_hash = hash('被篡改的原段摘要'); await f.saveExtraction()
  await expect(upgradeLibrary(f.root, f.client().upgradeOptions)).rejects.toThrow(/原段|片段|所属段|segment/)
  expect(f.calls).toEqual([])
})

it('仅篡改evidence来源版本仍拒绝，point版本正确不能替代引文版本校验', async () => {
  const f = await evidenceFixture()
  f.points[0]!.evidence[0]!.source_version = hash('被篡改的引文版本'); await f.saveExtraction()
  await expect(upgradeLibrary(f.root, f.client().upgradeOptions)).rejects.toThrow(/证据.*版本|引文.*版本/)
  expect(f.calls).toEqual([])
})

it('仅篡改evidence来源ID仍拒绝，不能把未知来源引文当当前成员证据', async () => {
  const f = await evidenceFixture()
  f.points[0]!.evidence[0]!.source_id = 'S-0999'; await f.saveExtraction()
  await expect(upgradeLibrary(f.root, f.client().upgradeOptions)).rejects.toThrow(/证据.*来源|引文.*来源/)
  expect(f.calls).toEqual([])
})
