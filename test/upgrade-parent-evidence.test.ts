import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { hash } from '../src/layered/files.js'
import { upgradeLibrary } from '../src/layered/upgrade.js'
import { child, evidenceFixture as fixture, leaf, parent } from './upgrade-evidence-fixture.js'

beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('父页证据回归禁止网络') })))
afterEach(() => vi.unstubAllGlobals())

it('父页核对恢复显式后代成员及原文证据，已核对子页和旁支均不额外审核', async () => {
  const f = await fixture(), bytes = await readFile(path.join(f.root, 'versions/v000001.json')), done = (await upgradeLibrary(f.root, f.client().upgradeOptions))!
  expect(done.status).toBe('complete'); expect(done.steps[0]!.unitIds).toHaveLength(1)
  expect(f.calls).toHaveLength(1); expect(f.calls[0]!.topic).toBe('T-父'); expect(f.calls[0]!.members).toHaveLength(1)
  expect(f.calls[0]!.members[0]!.text).toBe(f.points[0]!.text)
  expect(f.calls[0]!.members.some(member => member.text === f.points[1]!.text)).toBe(false)
  expect(f.points[0]!.text).not.toBe(f.raw); expect(hash(f.points[0]!.text)).not.toBe(f.points[0]!.text_hash)
  expect(f.calls[0]!.members[0]!.evidence[0]).toMatchObject({ quote: f.points[0]!.evidence[0]!.quote, locator: 'L1-L1', source_version: f.source.source_version, context: f.raw })
  expect(f.calls[0]!.source_versions).toEqual([{ source_id: f.source.source_id, source_version: f.source.source_version }])
  expect(await readFile(path.join(f.root, 'versions/v000001.json'))).toEqual(bytes)
})

it('父页引用缺失子页明确拒绝，零模型且旧清单保持', async () => {
  const f = await fixture(); delete f.manifest.pages![leaf]; await f.save()
  const before = await readFile(path.join(f.root, 'versions/v000001.json'))
  await expect(upgradeLibrary(f.root, f.client().upgradeOptions)).rejects.toMatchObject({ code: 'UPGRADE_ROOT_INCOMPLETE' })
  expect(f.calls).toEqual([]); expect(await readFile(path.join(f.root, 'versions/v000001.json'))).toEqual(before)
})

it('父子同一成员摘要冲突拒绝，不以任一方覆盖另一方', async () => {
  const f = await fixture(); f.manifest.deps!.pages[parent]!.points = [{ point_id: f.points[0]!.point_id, text_hash: hash('冲突正文') }]; await f.save()
  await expect(upgradeLibrary(f.root, f.client().upgradeOptions)).rejects.toMatchObject({ code: 'UPGRADE_ROOT_INCOMPLETE' })
  expect(f.calls).toEqual([])
})

it('父子依赖成环拒绝，不能递归扩展或派发模型', async () => {
  const f = await fixture(); f.manifest.deps!.pages[leaf]!.children = [{ page: parent, version: 'v000001' }]; await f.save()
  await expect(upgradeLibrary(f.root, f.client().upgradeOptions)).rejects.toMatchObject({ code: 'UPGRADE_ROOT_INCOMPLETE' })
  expect(f.calls).toEqual([])
})

it('显式子页版本的来源与父页绑定不符拒绝，不能替换成当前来源', async () => {
  const f = await fixture(), other = structuredClone(f.manifest)
  other.version = 'v000002'; other.sources[0]!.source_version = hash('另一来源版本'); await f.save(other)
  f.manifest.deps!.pages[parent]!.children = [{ page: child, version: 'v000002' }]; await f.save()
  await expect(upgradeLibrary(f.root, f.client().upgradeOptions)).rejects.toMatchObject({ code: 'UPGRADE_ROOT_INCOMPLETE' })
  expect(f.calls).toEqual([])
})
