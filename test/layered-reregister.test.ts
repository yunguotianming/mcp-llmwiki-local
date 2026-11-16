import { cp, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { inspectDirectory } from '../src/host/directory-inspection.js'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { findLayeredLibrary } from '../src/wiki/query.js'
import { cleanupLayeredFixtures, layeredTopicFixture, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
const copies: string[] = []
afterEach(async () => { cleanupLayeredFixtures(); for (const dir of copies.splice(0)) await rm(dir, { recursive: true, force: true }) })

it('复制到别处的分层库按已发布版本识别页数，资料根与 .llmwiki 两种登记方式都可识别', async () => {
  const f = await layeredTopicFixture()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 甲\n\n甲组的研究结果。')
  await buildLayeredLibrary(f.options)
  const published = await snapshotManifest(f.root)
  const target = await mkdtemp(path.join(tmpdir(), 'dsh-layered-copy-')); copies.push(target)
  await cp(f.knowledgeRoot, target, { recursive: true })
  for (const input of [target, path.join(target, '.llmwiki')]) {
    const result = await inspectDirectory(input)
    expect(result).toMatchObject({ layered: true, version: published.version, pageCount: Object.keys(published.pages!).length })
    expect(result.pageCount).toBeGreaterThan(0)
    expect(result.locks).toBeUndefined()
  }
  // 复制后的库可被只读查询入口找到。
  expect((await findLayeredLibrary(target))?.card.format_version).toBeDefined()
})

it('复制进来的写入锁只报告不删除', async () => {
  const f = await layeredTopicFixture()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 甲\n\n甲组的研究结果。')
  await buildLayeredLibrary(f.options)
  const target = await mkdtemp(path.join(tmpdir(), 'dsh-layered-copy-')); copies.push(target)
  await cp(f.knowledgeRoot, target, { recursive: true })
  await writeFile(path.join(target, '.llmwiki-build.lock'), '{}')
  const result = await inspectDirectory(target)
  expect(result.locks).toEqual(['.llmwiki-build.lock'])
  expect((await inspectDirectory(target)).locks).toEqual(['.llmwiki-build.lock'])
})
