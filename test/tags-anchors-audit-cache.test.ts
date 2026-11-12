import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { cleanupLayeredFixtures, snapshotManifest } from './layered-fixture.js'
import { built, replaceExtraction } from './tags-anchors-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
beforeAll(async () => { await built() })

it('C01 旧指纹无标签重提，旧字节、手改页、已有冲突及升级创建时间保留', async () => {
  const f = await built(), manual = '# 人工页面\n人工内容不可覆盖。'
  delete f.entry.created_at; delete f.manifest.page_created
  f.entry.updated_at = '2020-01-02T03:04:05.000Z'
  const old = await replaceExtraction(f, value => { delete value.tags; delete value.tag_version }, true)
  await mkdir(path.join(f.root, 'conflicts'), { recursive: true })
  await writeFile(path.join(f.root, 'conflicts/tags-anchors-audit.json'), '{"reason":"人工冲突留存"}')
  await writeFile(path.join(f.root, 'wiki/sources/S-0001.md'), manual)
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ unchanged: false })
  expect(f.call).toHaveBeenCalled()
  expect(await old.read()).toBe(old.bytes)
  expect(await readFile(path.join(f.root, 'wiki/sources/S-0001.md'), 'utf8')).toBe(manual)
  expect(await readFile(path.join(f.root, 'conflicts/tags-anchors-audit.json'), 'utf8')).toContain('人工冲突留存')
  expect((await snapshotManifest(f.root)).page_created!['sources/S-0001.md']).toBe(f.entry.updated_at)
})

it('C02 新指纹但缺 tags 的缓存必须重提', async () => {
  const f = await built()
  await replaceExtraction(f, value => { delete value.tags })
  await buildLayeredLibrary(f.options)
  expect(f.call).toHaveBeenCalled()
})

it('C03 新指纹但 tags 为字符串的缓存必须重提', async () => {
  const f = await built()
  await replaceExtraction(f, value => { value.tags = '研究方法' })
  await buildLayeredLibrary(f.options)
  expect(f.call).toHaveBeenCalled()
})

it('C04 新指纹但 tags 数组成员类型错误的缓存必须重提', async () => {
  const f = await built()
  await replaceExtraction(f, value => { value.tags = [42, null, {}] })
  await buildLayeredLibrary(f.options)
  expect(f.call).toHaveBeenCalled()
})

it('C05 新指纹但空标签数组及元数据字段缺失不能被当成完整缓存', async () => {
  const f = await built()
  await replaceExtraction(f, value => { value.tags = []; delete value.metadata.credibility_reason })
  await buildLayeredLibrary(f.options)
  expect(f.call).toHaveBeenCalled()
  const next = await snapshotManifest(f.root)
  expect(next.sources[0]!.tags!.length).toBeGreaterThanOrEqual(3)
})
