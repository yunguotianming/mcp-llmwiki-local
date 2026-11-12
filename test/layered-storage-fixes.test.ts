// 同路径内容修改夹具保留稳定标题，使段哈希重合率达到 50%；存储、恢复及冲突断言保持。
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { buildLayeredLibrary, readLayeredDocument, revokeLayeredSources } from '../src/layered/index.js'
import { writeJson } from '../src/layered/files.js'
import { pageObjectPath, readVersion, writeVersion } from '../src/layered/objects.js'
import { collectGarbage, pinVersion, readerLeaseMs, readerRenewMs } from '../src/layered/retention.js'
import { refreshReadingCopy } from '../src/layered/reading-copy.js'
import { cleanupLayeredFixtures, layeredFixture, shareLayeredFixture, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
let template: Awaited<ReturnType<typeof shareLayeredFixture>>, reuseRoot: string
beforeAll(async () => {
  const f = await layeredFixture(); reuseRoot = f.knowledgeRoot
  await fs.writeFile(path.join(reuseRoot, 'a.md'), '# 资料a\n\n旧版正文。')
  await buildLayeredLibrary(f.options)
  await fs.writeFile(path.join(reuseRoot, 'a.md'), '# 资料a\n\n新版正文。')
  await buildLayeredLibrary(f.options)
  template = await shareLayeredFixture(f)
})
afterEach(() => { vi.useRealTimers(); cleanupLayeredFixtures() })
const fixture = () => layeredFixture(template, reuseRoot)

it('验齐缓存遇无关对象删除、篡改和重新到达时失效，阅读副本回退并标注', async () => {
  const f = await fixture(), manifest = await snapshotManifest(f.root)
  expect((await readLayeredDocument(reuseRoot)).version).toBe('v000002')
  const file = path.join(f.root, pageObjectPath(manifest.pages!['sources/S-0001.md']!)), bytes = await fs.readFile(file)
  await fs.unlink(file)
  expect(await readLayeredDocument(reuseRoot)).toMatchObject({ version: 'v000001', warning: expect.stringContaining('更新未完整') })
  const reading = JSON.parse(await fs.readFile(path.join(f.root, 'state/reading-copy.json'), 'utf8'))
  await writeJson(f.root, 'state/reading-copy.json', { ...reading, target: 'v000002' })
  await refreshReadingCopy(f.root, manifest)
  expect(await fs.readFile(path.join(f.root, 'wiki/index.md'), 'utf8')).toContain('更新未完整')
  expect(await fs.readFile(path.join(f.root, 'wiki/sources/S-0001.md'), 'utf8')).toContain('旧版正文')
  await fs.writeFile(file, bytes)
  expect((await readLayeredDocument(reuseRoot)).version).toBe('v000002')
  await fs.writeFile(file, '篡改正文')
  expect((await readLayeredDocument(reuseRoot)).version).toBe('v000001')
  await fs.writeFile(file, bytes)
  expect((await readLayeredDocument(reuseRoot)).version).toBe('v000002')
  await refreshReadingCopy(f.root, manifest)
  expect(await fs.readFile(path.join(f.root, 'wiki/index.md'), 'utf8')).not.toContain('更新未完整')
})

it('当前读者跨发布后补租约，默认宽限到期及释放后才回收', async () => {
  const f = await fixture()
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  const pinned = await pinVersion(f.root)
  expect(await fs.readdir(path.join(f.root, 'state/readers')).catch(() => [])).toEqual([])
  for (const [version, previous] of [['v000003', 'v000002'], ['v000004', 'v000003']]) {
    const manifest = await snapshotManifest(f.root); manifest.version = version!
    await writeVersion(f.root, manifest)
    await writeJson(f.root, 'state/current.json', { version, history: [previous], revocation_generation: 0 })
  }
  await refreshReadingCopy(f.root, await snapshotManifest(f.root))
  await collectGarbage(f.root, readerLeaseMs)
  expect((await readVersion(f.root, 'v000002')).version).toBe('v000002')
  await vi.advanceTimersByTimeAsync(readerRenewMs)
  await pinned.assert()
  const leases = await fs.readdir(path.join(f.root, 'state/readers'))
  expect(leases).toHaveLength(1)
  await vi.advanceTimersByTimeAsync(readerLeaseMs)
  await collectGarbage(f.root, readerLeaseMs)
  expect((await readVersion(f.root, 'v000002')).version).toBe('v000002')
  await pinned.release()
  await collectGarbage(f.root, readerLeaseMs)
  await expect(readVersion(f.root, 'v000002')).rejects.toMatchObject({ code: 'ENOENT' })
})

it('旧多行日志、未知日志和撤权原因中的正文在撤权后全部清除', async () => {
  const f = await fixture(), secret = '旧日志正文Q739'
  await fs.writeFile(path.join(f.root, 'logs/build.md'), '- 导出缺口 S-0001（failed）：错误\n' + secret + '\n- 下一条\n')
  await fs.writeFile(path.join(f.root, 'logs/legacy-error.json'), JSON.stringify({ raw_output: secret }))
  await revokeLayeredSources(reuseRoot, ['S-0001'], secret)
  for (const file of await fs.readdir(path.join(f.root, 'logs'), { recursive: true, withFileTypes: true })) if (file.isFile()) {
    expect(await fs.readFile(path.join(file.parentPath, file.name), 'utf8')).not.toContain(secret)
  }
  expect(await fs.readFile(path.join(f.root, 'logs/build.md'), 'utf8')).toContain('sha256:')
})

it('显式备份保留旧库整棵目录且同秒重名不覆盖已有备份', async () => {
  const f = await layeredFixture()
  await fs.unlink(path.join(f.root, 'library.yaml'))
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date(2026, 10, 9, 12, 34, 56))
  const backup = '.llmwiki.bak-20261109-123456'
  await fs.mkdir(path.join(f.knowledgeRoot, backup)); await fs.writeFile(path.join(f.knowledgeRoot, backup, 'sentinel'), '已有备份')
  for (const name of ['entities', 'concepts', 'sources', 'state/jobs']) {
    await fs.mkdir(path.join(f.root, name), { recursive: true }); await fs.writeFile(path.join(f.root, name, 'old.bin'), Buffer.from([0, 1, 255]))
  }
  await expect(buildLayeredLibrary(f.options)).rejects.toThrow('legacyLibraryAction')
  await buildLayeredLibrary({ ...f.options, legacyLibraryAction: 'backup' })
  for (const name of ['entities', 'concepts', 'sources', 'state/jobs']) expect(await fs.readFile(path.join(f.knowledgeRoot, backup + '-1', name, 'old.bin'))).toEqual(Buffer.from([0, 1, 255]))
  expect(await fs.readFile(path.join(f.knowledgeRoot, backup, 'sentinel'), 'utf8')).toBe('已有备份')
  expect((await snapshotManifest(f.root)).version).toBe('v000001')
})

it('暖查询不逐次写租约或扫描全库对象', async () => {
  const f = await fixture()
  await readLayeredDocument(reuseRoot)
  const opens = vi.spyOn(fs, 'open'), reads = vi.spyOn(fs, 'readFile'), stats = vi.spyOn(fs, 'stat')
  expect((await readLayeredDocument(reuseRoot)).version).toBe('v000002')
  expect(opens).not.toHaveBeenCalled()
  expect([...reads.mock.calls, ...stats.mock.calls].some(([file]) => String(file).includes(path.sep + 'snapshots' + path.sep))).toBe(false)
})
