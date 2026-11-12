// 标题和正文同时修改时保留两段固定章节，使 4 段中 2 段相同；全部撤权清除断言保持。
import { fork, type ChildProcess } from 'node:child_process'
import * as filesystem from 'node:fs/promises'
import { readFile, writeFile, readdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { buildLayeredLibrary, readLayeredDocument, revokeLayeredSources } from '../src/layered/index.js'
import { hash, immutableWrite, withStorageGeneration, writeJson } from '../src/layered/files.js'
import { pageObjectPath, putPage, readVersion, writeVersion } from '../src/layered/objects.js'
import { collectGarbage, listFiles, pinVersion, readerRenewMs, withInventoryLock } from '../src/layered/retention.js'
import { storageJson, vectorPath } from '../src/layered/vectors.js'
import type { SourceEntry } from '../src/layered/schema.js'
import { layeredIndex } from '../src/storage/jobs.js'
import { cleanupLayeredFixtures, layeredTopicFixture, mockFixtureSync, shareLayeredFixture, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
const children = new Set<ChildProcess>()
let compilationCache: string
afterAll(async () => { if (compilationCache) await rm(compilationCache, { recursive: true, force: true }) })
afterEach(async () => {
  for (const child of children) if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited
  }
  children.clear(); await cleanupLayeredFixtures()
})
function child(mode: string, root: string, version?: string) {
  const process = fork(fileURLToPath(new URL('./layered-reader-process.mjs', import.meta.url)), [mode, root, version ?? '', compilationCache], { execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  children.add(process)
  const messages: any[] = [], listeners: (() => void)[] = []
  let ended = false, stderr = ''
  process.stderr!.on('data', data => { stderr += String(data) })
  process.on('message', message => { messages.push(message); for (const notify of listeners.splice(0)) notify() })
  const exited = new Promise<number | null>(resolve => process.on('exit', code => { ended = true; for (const notify of listeners.splice(0)) notify(); resolve(code) }))
  return { process, exited, async wait(type: string): Promise<any> {
    for (;;) {
      const error = messages.find(message => message.type === 'error')
      if (error) throw new Error(error.error)
      const result = messages.find(message => message.type === type)
      if (result) return result
      if (ended) throw new Error('子进程提前退出：' + stderr)
      await new Promise<void>(resolve => listeners.push(resolve))
    }
  } }
}
const secret = '撤权专属机密字节'
let template: Awaited<ReturnType<typeof shareLayeredFixture>>
let reuseRoot: string
let crashed: Awaited<ReturnType<typeof layeredTopicFixture>>
let crashExit: number | null
let crashedEntry: SourceEntry
beforeAll(async () => {
  compilationCache = await mkdtemp(path.join(tmpdir(), 'storage-reader-compile-'))
  const f = await layeredTopicFixture()
  reuseRoot = f.knowledgeRoot
  await writeFile(path.join(f.knowledgeRoot, 'asset.bin'), secret)
  await writeFile(path.join(f.knowledgeRoot, '0.md'), '# 私密标题\n\n## 固定范围\n\n## 固定对象\n\n甲组' + secret + '。[附件](asset.bin)')
  await writeFile(path.join(f.knowledgeRoot, '1.md'), '# 合法标题\n\n乙组公开结论。')
  await buildLayeredLibrary(f.options)
  await writeFile(path.join(f.knowledgeRoot, '0.md'), '# 私密新版标题\n\n## 固定范围\n\n## 固定对象\n\n甲组' + secret + '新版。[附件](asset.bin)')
  await buildLayeredLibrary(f.options)
  template = await shareLayeredFixture(f)
  // 真实崩溃状态属于共用准备；累计 tests 时间仍包含这次子进程启动。
  crashed = await layeredTopicFixture(template)
  crashedEntry = (await snapshotManifest(crashed.root)).sources[0]!
  crashExit = await child('crash', crashed.root).exited
})
const fixture = () => layeredTopicFixture(template, reuseRoot)
const absent = async (root: string, file: string) => expect(readFile(path.join(root, file))).rejects.toMatchObject({ code: 'ENOENT' })

it('撤权物理清除当前与上一版、快照附件、向量、SQLite、草稿及用户手改阅读页', async () => {
  const f = await fixture(), old = await readVersion(f.root, 'v000001'), current = await snapshotManifest(f.root)
  for (const version of ['v000001', 'v000002']) {
    await layeredIndex(f.root, 'index-read', {}, version)
    await layeredIndex(f.root, 'index-save', { pages: [{ path: 'sources/S-0001.md', stamp: '旧代次', data: secret, title: secret, aliases: '', identity: '', body: secret }] }, version)
  }
  await writeJson(f.root, 'work/interrupted.json', { body: secret })
  await writeFile(path.join(f.root, 'wiki/sources/S-0001.md'), secret + '用户手改')
  await writeFile(path.join(f.root, 'wiki/index.md'), secret + '手改导航')
  await withStorageGeneration(f.root, async () => {
    await revokeLayeredSources(f.knowledgeRoot, ['S-0001'], '撤回收录')
    await expect(immutableWrite(f.root, old.sources[0]!.files.source, Buffer.from(secret))).rejects.toThrow('撤权代次变化')
    await expect(writeJson(f.root, 'work/retry.json', { body: secret })).rejects.toThrow('撤权代次变化')
  })
  for (const manifest of [old, current]) {
    const entry = manifest.sources.find(source => source.source_id === 'S-0001')!
    await absent(f.root, entry.files.source); await absent(f.root, entry.extract.path)
    for (const asset of entry.files.assets) await absent(f.root, asset.path)
    for (const [id, value] of Object.entries(manifest.topics!.vectors)) if (id.startsWith('S-0001:')) await absent(f.root, vectorPath(value.vector_id!))
    await absent(f.root, pageObjectPath(manifest.pages!['sources/S-0001.md']!))
    const cleaned = await readVersion(f.root, manifest.version!)
    expect(cleaned.sources.map(source => source.source_id)).toEqual(['S-0002'])
    expect(cleaned.pages!['sources/S-0001.md']).toBeUndefined()
    expect(cleaned.rebuild_pages).toContain('topics/T-0001.md')
    expect(JSON.stringify(cleaned)).not.toContain(secret)
    expect(await layeredIndex(f.root, 'index-read', {}, manifest.version!)).toEqual([])
  }
  expect(await listFiles(f.root, 'work')).toEqual([])
  await absent(f.root, 'wiki/sources/S-0001.md'); await absent(f.root, 'wiki/topics/T-0001.md')
  for (const location of ['versions', 'objects', 'wiki', 'cache', 'state']) for (const file of await listFiles(f.root, location)) expect((await readFile(path.join(f.root, file))).includes(Buffer.from(secret))).toBe(false)
  const conflicts = await Promise.all((await listFiles(f.root, 'conflicts')).map(file => readFile(path.join(f.root, file), 'utf8')))
  expect(conflicts.some(value => value.includes('sources/S-0001.md') && value.includes('因撤权移除'))).toBe(true)
  const reads = vi.spyOn(filesystem, 'readFile'), opens = vi.spyOn(filesystem, 'open'), scans = vi.spyOn(filesystem, 'readdir')
  expect(await readLayeredDocument(f.knowledgeRoot, 'S-0002')).toMatchObject({ status: 'ok' })
  expect(opens).not.toHaveBeenCalled(); expect(scans).not.toHaveBeenCalled()
  expect(reads.mock.calls.filter(([file]) => String(file).replaceAll('\\', '/').includes('/objects/snapshots/'))
    .every(([file]) => String(file).replaceAll('\\', '/').includes('/S-0002/'))).toBe(true)
})

it('撤权中断留下持久待办，新进程首次读取继续完成物理清除', async () => {
  const f = crashed
  mockFixtureSync(f.knowledgeRoot)
  const entry = crashedEntry
  expect(crashExit).toBe(73)
  expect(JSON.parse(await readFile(path.join(f.root, 'state/revocations.json'), 'utf8')).generation).toBe(1)
  expect(await readFile(path.join(f.root, 'state/revocation-pending.json'), 'utf8')).not.toContain(secret)
  const readers = [child('recover', f.root), child('recover', f.root)]
  for (const reader of readers) expect((await reader.wait('result')).value).toMatchObject({ document: { status: 'updating' }, source: { status: 'updating' } })
  await absent(f.root, entry.files.source); await absent(f.root, entry.extract.path); await absent(f.root, 'state/revocation-pending.json')
  expect((await revokeLayeredSources(f.knowledgeRoot, ['S-0001'], '重复撤回')).generation).toBe(1)
})

it('共用页面对象与向量只去掉被撤来源引用，仍被授权来源引用的字节保留', async () => {
  const f = await fixture(), shared = await putPage(f.root, '# 合法共用正文\n'), vectors: string[] = []
  for (const version of ['v000001', 'v000002']) {
    const manifest = await readVersion(f.root, version)
    manifest.pages!['sources/S-0001.md'] = shared; manifest.pages!['sources/S-0002.md'] = shared
    const allowed = Object.entries(manifest.topics!.vectors).find(([id]) => id.startsWith('S-0002:'))![1]
    vectors.push(allowed.vector_id!)
    for (const id of Object.keys(manifest.topics!.vectors)) if (id.startsWith('S-0001:')) manifest.topics!.vectors[id] = allowed
    await writeJson(f.root, `versions/${version}.json`, { checksum: hash(storageJson(manifest)), manifest })
  }
  await revokeLayeredSources(f.knowledgeRoot, ['S-0001'], '撤回共用内容中的一个来源')
  expect(await readFile(path.join(f.root, pageObjectPath(shared)), 'utf8')).toContain('合法共用正文')
  for (const id of vectors) expect((await readFile(path.join(f.root, vectorPath(id)))).length).toBeGreaterThan(0)
  expect(await readLayeredDocument(f.knowledgeRoot, 'S-0002')).toMatchObject({ status: 'ok', content: '# 合法共用正文\n' })
  expect(await readLayeredDocument(f.knowledgeRoot, 'S-0001')).toMatchObject({ status: 'updating' })
})

it('另一进程持有租约时 GC 保留旧版，崩溃后的过期租约自动失效', async () => {
  const f = await fixture(), reader = child('pin', f.root, 'v000001')
  const ready = await reader.wait('ready')
  expect(ready.pid).not.toBe(process.pid)
  const manifest = await snapshotManifest(f.root); manifest.version = 'v000003'
  await writeVersion(f.root, manifest)
  await writeJson(f.root, 'state/current.json', { version: 'v000003', revocation_generation: 0, history: ['v000002'] })
  await collectGarbage(f.root)
  expect((await readVersion(f.root, 'v000001')).version).toBe('v000001')
  const leases = await readdir(path.join(f.root, 'state/readers'))
  expect(leases).toHaveLength(1)
  const file = 'state/readers/' + leases[0], lease = JSON.parse(await readFile(path.join(f.root, file), 'utf8'))
  expect(lease).toMatchObject({ pid: ready.pid, version: 'v000001' }); expect(lease.expires_at).toBeGreaterThan(Date.now())
  const exited = new Promise(resolve => reader.process.once('exit', resolve)); reader.process.kill(); await exited
  await collectGarbage(f.root)
  expect((await readVersion(f.root, 'v000001')).version).toBe('v000001')
  await writeJson(f.root, file, { ...lease, expires_at: Date.now() - 1 })
  await collectGarbage(f.root)
  await absent(f.root, 'versions/v000001.json'); await absent(f.root, file)
  const lockFile = path.join(f.root, 'state/inventory-lock.sqlite'), lockBefore = await filesystem.stat(lockFile)
  await withInventoryLock(f.root, async () => {})
  const lockAfter = await filesystem.stat(lockFile)
  expect(lockAfter.size).toBeGreaterThan(0); expect(lockAfter.mtimeMs).toBe(lockBefore.mtimeMs)
  // 续租使用虚拟时钟，保留真实租约落盘和跨进程锁，不增加等待时间。
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  const local = await pinVersion(f.root, 'v000003')
  try {
    const file = 'state/readers/' + (await readdir(path.join(f.root, 'state/readers')))[0]
    const before = JSON.parse(await readFile(path.join(f.root, file), 'utf8')).expires_at
    await vi.advanceTimersByTimeAsync(readerRenewMs)
    await withInventoryLock(f.root, async () => expect(JSON.parse(await readFile(path.join(f.root, file), 'utf8')).expires_at).toBeGreaterThan(before))
    await local.assert()
  } finally { await local.release(); vi.useRealTimers() }
})

it('撤权优先于另一进程的旧版租约，读者不返回撤权正文且旧查询不能写回 SQLite', async () => {
  const f = await fixture(), reader = child('read', f.root, 'v000001')
  await reader.wait('ready')
  const old = await readVersion(f.root, 'v000001'), entry = old.sources[0]!
  await revokeLayeredSources(f.knowledgeRoot, ['S-0001'], '读取期间撤权')
  await absent(f.root, entry.files.source); await absent(f.root, pageObjectPath(old.pages!['sources/S-0001.md']!))
  reader.process.send('continue')
  const result = (await reader.wait('result')).value
  expect(result).toMatchObject({ document: { status: 'updating', content: '更新中' }, source: { status: 'updating', content: '更新中' } })
  expect(JSON.stringify(result)).not.toContain(secret)
  await expect(layeredIndex(f.root, 'index-save', { pages: [{ path: 'sources/S-0001.md', stamp: '旧代次', data: secret, title: secret, aliases: '', identity: '', body: secret }] }, 'v000001', 0)).rejects.toThrow('撤权代次变化')
  expect(await layeredIndex(f.root, 'index-read', {}, 'v000001', 1)).toEqual([])
})
