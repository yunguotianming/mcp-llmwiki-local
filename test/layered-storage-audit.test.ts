// 更新夹具保留私密资料标题，按 50% 段重合认修改；发布故障与手改冲突断言保持。
import { mockSupportReview } from './layered-fixture.js'
import { fork, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { buildLayeredLibrary, readLayeredDocument, revokeLayeredSources } from '../src/layered/index.js'
import { hash, withBuildLock, withStorageGeneration, writeJson } from '../src/layered/files.js'
import { pageObjectPath, putPage, readPageObject, readVersion, writeVersion } from '../src/layered/objects.js'
import { collectGarbage, listFiles, pinVersion, readerRenewMs, withInventoryLock } from '../src/layered/retention.js'
import { refreshReadingCopy } from '../src/layered/reading-copy.js'
import { checkWriter, claimWriter, localDevice } from '../src/layered/devices.js'
import { initializeLibrary, publishLibrary } from '../src/layered/publication.js'
import { indexDependencies, withLayeredRead } from '../src/layered/revocations.js'
import { embedInputs } from '../src/layered/embedding.js'
import { layeredSettings } from '../src/domain/config.js'
import { decodeVector, readVector, storageJson, vectorPath } from '../src/layered/vectors.js'
import { layeredCacheDirectory, layeredIndex } from '../src/storage/jobs.js'
import { LayeredQuery } from '../src/wiki/layered-query.js'
import { initializeStateLayout } from '../src/storage/paths.js'
import type { SnapshotManifest } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, layeredIncrementalFixture, shareLayeredFixture, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
const secret = '撤权反例独有正文ZXQ731'
let template: Awaited<ReturnType<typeof shareLayeredFixture>>
let storageTemplate: typeof template, storageRoot: string
let compilationCache: string
let reuseRoot: string
const workers: ReturnType<typeof worker>[] = []
let sequence = 0
function worker() {
  const child: ChildProcess = fork(fileURLToPath(new URL('./layered-storage-audit-worker.mjs', import.meta.url)), [compilationCache], { execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  let stderr = ''
  child.stderr!.on('data', bytes => { stderr += String(bytes) })
  let readyResolve: () => void, readyReject: (error: Error) => void
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject })
  child.on('message', (message: any) => {
    if (message.ready) { readyResolve(); return }
    const waiting = pending.get(message.id)
    if (!waiting) return
    pending.delete(message.id)
    if (message.error) waiting.reject(new Error(message.error)); else waiting.resolve(message.value)
  })
  child.on('exit', () => {
    const error = new Error('审查子进程退出：' + stderr)
    readyReject(error)
    for (const waiting of pending.values()) waiting.reject(error)
    pending.clear()
  })
  return { child, ready, async run(action: string, root: string, version?: string): Promise<any> {
    await ready
    const id = ++sequence
    return new Promise((resolve, reject) => { pending.set(id, { resolve, reject }); child.send({ id, action, root, version }) })
  } }
}
beforeAll(async () => {
  compilationCache = await fs.mkdtemp(path.join(tmpdir(), 'storage-audit-compile-'))
  workers.push(worker(), worker())
  await Promise.all([Promise.all(workers.map(item => item.ready)), (async () => {
  const f = await layeredIncrementalFixture()
  reuseRoot = f.knowledgeRoot
  await fs.writeFile(path.join(f.knowledgeRoot, 'asset.bin'), secret)
  await fs.writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 私密资料\n\n甲组' + secret + '第一版。[附件](asset.bin)')
  await fs.writeFile(path.join(f.knowledgeRoot, 'b.md'), '# 公开资料\n\n乙组公开研究结论。')
  await buildLayeredLibrary(f.options)
  await fs.writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 私密资料\n\n甲组' + secret + '第二版。[附件](asset.bin)')
  await buildLayeredLibrary(f.options)
  template = await shareLayeredFixture(f)
  // 租约、去重、写锁和格式边界只需完整空库，正文撤权与发布用例保留两来源模板。
  const storage = await layeredIncrementalFixture(); storageRoot = storage.knowledgeRoot
  await buildLayeredLibrary(storage.options); await advance(storage.root, 'v000002')
  storageTemplate = await shareLayeredFixture(storage)
  })()])
})
afterEach(() => { vi.useRealTimers(); cleanupLayeredFixtures() })
afterAll(async () => {
  for (const { child } of workers) if (child.exitCode === null && child.signalCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited
  }
  // 仅删除本文件创建且路径核对通过的转换缓存。
  if (compilationCache && path.dirname(compilationCache) === path.resolve(tmpdir()) && path.basename(compilationCache).startsWith('storage-audit-compile-')) await fs.rm(compilationCache, { recursive: true, force: true })
})
const fixture = (storageOnly = false) => layeredIncrementalFixture(storageOnly ? storageTemplate : template, storageOnly ? storageRoot : reuseRoot)
const absent = async (root: string, file: string) => expect(fs.readFile(path.join(root, file))).rejects.toMatchObject({ code: 'ENOENT' })
const revoke = (f: Awaited<ReturnType<typeof fixture>>) => revokeLayeredSources(f.knowledgeRoot, ['S-0001'], '撤回审查资料')
async function cleanBytes(root: string) {
  for (const area of ['versions', 'objects', 'cache', 'work', 'wiki', 'conflicts', 'logs', 'state']) {
    for (const file of await listFiles(root, area)) expect((await fs.readFile(path.join(root, file))).includes(Buffer.from(secret)), file).toBe(false)
  }
}
async function replaceManifest(root: string, manifest: SnapshotManifest) {
  await writeJson(root, `versions/${manifest.version}.json`, { checksum: hash(storageJson(manifest)), manifest })
}
async function advance(root: string, version = 'v000003') {
  const manifest = await snapshotManifest(root), old = manifest.version!
  manifest.version = version
  await writeVersion(root, manifest)
  await writeJson(root, 'state/current.json', { version, revocation_generation: 0, history: [old] })
  await refreshReadingCopy(root, manifest)
}

it('A01 撤权清除两版原字节附件向量索引草稿及主题术语导航', async () => {
  const f = await fixture(), before = [await readVersion(f.root, 'v000001'), await snapshotManifest(f.root)]
  for (const manifest of before) {
    const page = 'terms/TM-0001.md'
    manifest.pages![page] = await putPage(f.root, '# 术语\n' + secret)
    manifest.deps!.pages[page] = { sources: ['S-0001'], points: [] }
    indexDependencies(manifest.deps!)
    await replaceManifest(f.root, manifest)
    await layeredIndex(f.root, 'index-read', {}, manifest.version!)
    await layeredIndex(f.root, 'index-save', { pages: [{ path: page, stamp: '撤前', data: secret, title: secret, aliases: '', identity: '', body: secret }] }, manifest.version!)
  }
  await fs.mkdir(path.join(f.root, 'wiki/terms'), { recursive: true })
  await fs.writeFile(path.join(f.root, 'wiki/terms/TM-0001.md'), secret)
  await writeJson(f.root, 'work/audit-draft.json', { body: secret })
  await fs.writeFile(path.join(f.root, 'wiki/sources/S-0001.md'), secret + '手改')
  await revoke(f)
  await cleanBytes(f.root)
  for (const manifest of before) {
    const source = manifest.sources[0]!
    await absent(f.root, source.files.source); await absent(f.root, source.extract.path)
    for (const asset of source.files.assets) await absent(f.root, asset.path)
    for (const [point, value] of Object.entries(manifest.topics!.vectors)) if (point.startsWith('S-0001:')) await absent(f.root, vectorPath(value.vector_id!))
    expect((await readVersion(f.root, manifest.version!)).sources.map(source => source.source_id)).toEqual(['S-0002'])
    expect(await layeredIndex(f.root, 'index-read', {}, manifest.version!)).toEqual([])
  }
  const conflicts = await Promise.all((await listFiles(f.root, 'conflicts')).map(file => fs.readFile(path.join(f.root, file), 'utf8')))
  expect(conflicts.some(text => text.includes('因撤权移除') && text.includes('sources/S-0001.md'))).toBe(true)
})

it('A02 撤权共用页面与向量不误删且重建不复活', async () => {
  const f = await fixture(), shared = await putPage(f.root, '# 两来源均授权的公共正文\n')
  let vector = ''
  for (const version of ['v000001', 'v000002']) {
    const manifest = await readVersion(f.root, version)
    manifest.pages!['sources/S-0001.md'] = shared; manifest.pages!['sources/S-0002.md'] = shared
    const allowed = Object.entries(manifest.topics!.vectors).find(([id]) => id.startsWith('S-0002:'))![1]
    vector = allowed.vector_id!
    for (const id of Object.keys(manifest.topics!.vectors)) if (id.startsWith('S-0001:')) manifest.topics!.vectors[id] = allowed
    await replaceManifest(f.root, manifest)
  }
  await revoke(f)
  expect(await readPageObject(f.root, shared)).toContain('公共正文'); expect(await readVector(f.root, vector)).toEqual([0, 1])
  await buildLayeredLibrary(f.options)
  expect((await snapshotManifest(f.root)).sources.map(source => source.source_id)).toEqual(['S-0002'])
  await cleanBytes(f.root)
})

// 在每类持久化边界抛错，随后交由已启动的独立进程恢复。
const revocationStages = [
  ['A03', '撤权表', 'rename', '/state/revocations.json'],
  ['A04', '版本清单', 'rename', '/versions/v000001.json'],
  ['A05', '派生状态', 'rename', '/state/topics.json'],
  ['A06', '中间产物', 'unlink', '/work/audit-draft.json'],
  ['A07', '阅读页面', 'unlink', '/wiki/sources/S-0001.md'],
  ['A08', '查询缓存', 'unlink', '/cache/audit.sqlite'],
  ['A09', '不可达对象', 'unlink', '/objects/snapshots/S-0001/'],
  ['A10', '清除完成标记', 'unlink', '/state/revocation-pending.json'],
  ['A43', '阅读状态', 'rename', '/state/reading-copy.json'],
  ['A44', '手改冲突记录', 'rename', '/conflicts/'],
  ['A45', '向量缓存映射', 'rename', '/state/embeddings.json'],
  ['A46', '构建日志', 'rename', '/logs/build.md'],
  ['A47', '失败现场', 'unlink', '/logs/failures/audit.json'],
  ['A48', '崩溃遗留临时文件', 'unlink', '/versions/v000001.json.11111111-1111-1111-1111-111111111111.tmp'],
] as const
for (const [id, label, operation, suffix] of revocationStages) it(`${id} 撤权在${label}阶段中断后独立进程续做`, async () => {
  const f = await fixture()
  await writeJson(f.root, 'work/audit-draft.json', { body: secret })
  await writeJson(f.root, 'logs/failures/audit.json', { body: secret })
  await fs.mkdir(path.join(f.root, 'cache'), { recursive: true })
  await fs.writeFile(path.join(f.root, 'cache/audit.sqlite'), secret)
  await fs.writeFile(path.join(f.root, 'wiki/sources/S-0001.md'), secret + '用户手改')
  await fs.writeFile(path.join(f.root, 'versions/v000001.json.11111111-1111-1111-1111-111111111111.tmp'), secret)
  const original = fs[operation]
  let hit = false
  const fault = vi.spyOn(fs, operation).mockImplementation((async (...args: any[]) => {
    const file = String(args[operation === 'rename' ? 1 : 0]).replaceAll('\\', '/')
    if (!hit && file.includes(suffix)) { hit = true; throw new Error('审查模拟崩溃') }
    return (original as any)(...args)
  }) as any)
  try { await expect(revoke(f)).rejects.toThrow('审查模拟崩溃') } finally { fault.mockRestore() }
  expect(hit).toBe(true)
  const result = await workers[0]!.run('read', f.root)
  expect(result.document.status).toBe('updating'); expect(result.source.status).toBe('updating')
  await absent(f.root, 'state/revocation-pending.json'); await cleanBytes(f.root)
})

it('A11 撤权日志多行导出错误不能残留正文', async () => {
  const f = await fixture(), manifest = await snapshotManifest(f.root)
  // 让真实发布器生成多行导出错误日志，再检查撤权清除。
  manifest.gaps = [{ source_id: 'S-0001', status: 'failed', message: '导出失败\n' + secret }]
  await publishLibrary(f.root, { format_version: 2, base_version: 'v000002', version: null, manifest,
    card: manifest.card!, added: [], model_calls: 0, started_at: new Date().toISOString() })
  await revoke(f)
  await cleanBytes(f.root)
})

it('A12 旧版持租约与旧代次写回遇撤权必须屏蔽', async () => {
  const f = await fixture()
  let revoked = false
  await withLayeredRead(f.root, async view => {
    if (!revoked) await withStorageGeneration(f.root, async () => {
      await revoke(f); revoked = true
      await expect(writeJson(f.root, 'work/audit-late.json', { body: secret })).rejects.toThrow('撤权代次变化')
    })
    expect((await view.document('S-0001')).status).toBe('updating')
    expect((await view.source('S-0001')).status).toBe('updating')
  }, { version: 'v000001' })
  await expect(layeredIndex(f.root, 'index-save', { pages: [] }, 'v000001', 0)).rejects.toThrow('撤权代次变化')
})

it('A13 默认当前版的跨进程读者应固定版本直至释放', async () => {
  const f = await fixture(true), reader = workers[0]!
  await reader.run('pin', f.root)
  try {
    await advance(f.root); await advance(f.root, 'v000004'); await collectGarbage(f.root, 30000)
    expect(await listFiles(f.root, 'versions')).toContain('versions/v000002.json')
  } finally { await reader.run('release', f.root) }
})

it('A14 显式旧版跨进程租约保留版本且过期孤儿租约可回收', async () => {
  const f = await fixture(true), reader = workers[0]!, ready = await reader.run('pin', f.root, 'v000001')
  try {
    expect(ready.pid).not.toBe(process.pid)
    await advance(f.root); await collectGarbage(f.root)
    expect(await listFiles(f.root, 'versions')).toContain('versions/v000001.json')
  } finally { await reader.run('release', f.root) }
  await writeJson(f.root, 'state/readers/audit-orphan.json', { pid: 2147483000, device: '已退出设备', version: 'v000001', expires_at: Date.now() - 1 })
  await collectGarbage(f.root)
  await absent(f.root, 'versions/v000001.json'); await absent(f.root, 'state/readers/audit-orphan.json')
})

it('A15 续租失败后读者拒绝继续读而不是无限沿用内存租约', async () => {
  const f = await fixture(true)
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  const pinned = await pinVersion(f.root, 'v000001')
  const rename = fs.rename
  const fault = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).includes(`${path.sep}readers${path.sep}`)) throw new Error('模拟续租失败')
    return rename(from, to)
  })
  try {
    await vi.advanceTimersByTimeAsync(readerRenewMs)
    await withInventoryLock(f.root, async () => {})
    await expect(pinned.assert()).rejects.toThrow('租约已失效')
  } finally { fault.mockRestore(); await pinned.release() }
})

it('A16 GC 保留活跃作业版本与 work conflicts 引用对象', async () => {
  const f = await fixture(true), draft = await putPage(f.root, '# 活跃草稿'), conflict = await putPage(f.root, '# 待解决冲突')
  await writeJson(f.root, 'work/audit-active.json', { base_version: 'v000001', content_id: draft })
  await writeJson(f.root, 'conflicts/audit.json', { new_object: conflict })
  await advance(f.root); await collectGarbage(f.root)
  expect(await listFiles(f.root, 'versions')).toContain('versions/v000001.json')
  expect(await readPageObject(f.root, draft)).toContain('活跃草稿'); expect(await readPageObject(f.root, conflict)).toContain('待解决冲突')
})

it('A17 两进程同时 GC 与主进程发布互斥后仍保留完整两版', async () => {
  const f = await fixture()
  await fs.writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组第三版公开研究。')
  const original = f.call.getMockImplementation()!
  let collected = false
  // 模型调用前源文快照已落盘，pending 尚未加入新来源引用；此时放行两个真实 GC 进程。
  f.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
    if (!collected) {
      collected = true
      await Promise.all([workers[0]!.run('gc', f.root), workers[1]!.run('gc', f.root)])
    }
    return original(...args)
  })
  const results = await Promise.allSettled([buildLayeredLibrary(f.options)])
  expect(collected).toBe(true)
  for (const result of results) expect(result.status, result.status === 'rejected' ? String(result.reason) : '').toBe('fulfilled')
  const pinned = await pinVersion(f.root)
  try { expect(pinned.manifest.version).toBe('v000003') } finally { await pinned.release() }
  expect(await listFiles(f.root, 'versions')).toHaveLength(2)
})

const publicationStages = [
  ['A18', '对象写入', '/objects/pages/', false],
  ['A19', '清单写入', '/versions/v000003.json', false],
  ['A20', '指针替换', '/state/current.json', false],
  ['A21', '阅读刷新', '/wiki/index.md', true],
  ['A22', '旧版回收', '/versions/v000001.json', true],
] as const
for (const [id, label, suffix, published] of publicationStages) it(`${id} 发布${label}中断只能读完整旧版或新版且可恢复`, async () => {
  const f = await fixture(), operation = id === 'A22' ? 'unlink' : 'rename'
  await fs.writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 私密资料\n\n甲组第三版新正文。')
  const original = fs[operation]
  let hit = false
  const fault = vi.spyOn(fs, operation).mockImplementation((async (...args: any[]) => {
    if (!hit && String(args[operation === 'rename' ? 1 : 0]).replaceAll('\\', '/').includes(suffix)) { hit = true; throw new Error('发布模拟崩溃') }
    return (original as any)(...args)
  }) as any)
  try { await expect(buildLayeredLibrary(f.options)).rejects.toThrow('发布模拟崩溃') } finally { fault.mockRestore() }
  expect(hit).toBe(true)
  const result = await withLayeredRead(f.root, async view => [await view.document('S-0001'), await view.document('S-0002')])
  expect(new Set(result.map(page => page.version)).size).toBe(1)
  expect(result[0]!.content).toContain(published ? '第三版新正文' : '第二版')
  await buildLayeredLibrary(f.options)
  expect((await readLayeredDocument(f.knowledgeRoot, 'S-0001')).content).toContain('第三版新正文')
  const pinned = await pinVersion(f.root)
  await pinned.release()
})

it('A23 当前页面对象缺失时整次请求回退上一完整版本', async () => {
  const f = await fixture(), manifest = await snapshotManifest(f.root)
  await fs.unlink(path.join(f.root, pageObjectPath(manifest.pages!['sources/S-0001.md']!)))
  const result = await withLayeredRead(f.root, async view => [await view.document('S-0001'), await view.document('S-0002')])
  expect(result.map(page => page.version)).toEqual(['v000001', 'v000001'])
  expect(result[0]!.warning).toContain('更新未完整')
})

it('A24 无关对象缺失时不得先激活当前半版并返回其导航', async () => {
  const f = await fixture(), manifest = await snapshotManifest(f.root)
  await fs.unlink(path.join(f.root, pageObjectPath(manifest.pages!['sources/S-0001.md']!)))
  const result = await readLayeredDocument(f.knowledgeRoot)
  expect(result.version).toBe('v000001')
  expect(result.warning).toContain('更新未完整')
})

for (const [id, damaged] of [['A25', '清单'], ['A26', '页面哈希']] as const) it(`${id} ${damaged}被篡改时拒绝坏版本并回退`, async () => {
  const f = await fixture(), manifest = await snapshotManifest(f.root)
  const file = damaged === '清单' ? 'versions/v000002.json' : pageObjectPath(manifest.pages!['sources/S-0001.md']!)
  await fs.writeFile(path.join(f.root, file), '损坏内容')
  const result = await readLayeredDocument(f.knowledgeRoot, 'S-0001')
  expect(result.version).toBe('v000001'); expect(result.content).not.toContain('损坏内容')
})

it('A27 用户手改新增删除阅读页均保留冲突且不进入检索', async () => {
  const f = await fixture(), manual = '人工专属KLM982'
  await fs.writeFile(path.join(f.root, 'wiki/sources/S-0001.md'), manual)
  await fs.unlink(path.join(f.root, 'wiki/sources/S-0002.md'))
  await fs.writeFile(path.join(f.root, 'wiki/sources/自建.md'), manual)
  await fs.mkdir(path.join(f.root, 'wiki/.obsidian'))
  await fs.writeFile(path.join(f.root, 'wiki/.obsidian/settings.json'), '{"用户":true}')
  await fs.writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 私密资料\n\n甲组第三版正文。')
  await buildLayeredLibrary(f.options)
  expect(await fs.readFile(path.join(f.root, 'wiki/sources/S-0001.md'), 'utf8')).toBe(manual)
  await absent(f.root, 'wiki/sources/S-0002.md')
  expect(await fs.readFile(path.join(f.root, 'wiki/sources/自建.md'), 'utf8')).toBe(manual)
  expect(await fs.readFile(path.join(f.root, 'wiki/.obsidian/settings.json'), 'utf8')).toContain('用户')
  expect(await listFiles(f.root, 'conflicts')).toHaveLength(2)
  const results = await query(f, manual)
  expect(JSON.stringify(results)).not.toContain(manual)
})

async function query(f: Awaited<ReturnType<typeof fixture>>, text: string) {
  const card = (await snapshotManifest(f.root)).card!
  return (await new LayeredQuery(f.options.embeddingClient).search({ ...f.library, wikiPath: f.root }, { root: f.root, card }, text)).value
}

it('A28 同文页面去重且其中一页变化不影响另一页', async () => {
  const f = await fixture(true), first = await putPage(f.root, '# 相同正文'), second = await putPage(f.root, '# 相同正文')
  expect(first).toBe(second)
  const changed = await putPage(f.root, '# 修改正文')
  expect(changed).not.toBe(first); expect(await readPageObject(f.root, second)).toBe('# 相同正文')
})

it('A29 向量 ID 二进制偏移与 float16 切换的缓存身份一致', async () => {
  const f = await fixture(true), input = ['独立向量输入', '独立向量输入']
  const client = { identity: async () => '不可变权重', embed: vi.fn(async (texts: string[]) => texts.map(() => [0.6, 0.8])) }
  const a = await embedInputs(f.root, input, layeredSettings({ vectorPrecision: 'float32' }), client)
  const b = await embedInputs(f.root, input, layeredSettings({ vectorPrecision: 'float16' }), client)
  expect(a[0]!.vector_id).toBe(a[1]!.vector_id); expect(b[0]!.vector_id).toBe(b[1]!.vector_id)
  expect(a[0]!.vector_id).not.toBe(b[0]!.vector_id); expect(client.embed).toHaveBeenCalledTimes(2)
  for (const [reference, precision, width] of [[a[0]!, 'float32', 4], [b[0]!, 'float16', 2]] as const) {
    const bytes = await fs.readFile(path.join(f.root, vectorPath(reference.vector_id)))
    const length = bytes.readUInt32LE(4), header = JSON.parse(bytes.subarray(8, 8 + length).toString())
    expect(header.precision).toBe(precision); expect(bytes.length - 8 - length).toBe(2 * width)
    expect(await readVector(f.root, reference.vector_id)).toEqual(decodeVector(bytes.subarray(8 + length), precision))
    const broken = Buffer.from(bytes); broken[broken.length - 1]! ^= 1
    await fs.writeFile(path.join(f.root, vectorPath(reference.vector_id)), broken)
    await expect(readVector(f.root, reference.vector_id)).rejects.toThrow('校验和')
  }
})

it('A30 删除全部查询缓存后重建查询结果一致且 JSON SQLite 不落向量数组', async () => {
  const f = await fixture(), before = await query(f, '公开研究')
  const cacheRoot = layeredCacheDirectory(f.root), cache = await fs.readdir(cacheRoot)
  expect(cache.some(file => file.endsWith('.sqlite'))).toBe(true)
  for (const file of cache) await fs.unlink(path.join(cacheRoot, file))
  expect(await query(f, '公开研究')).toEqual(before)
  for (const area of ['state', 'versions', 'work']) for (const file of await listFiles(f.root, area)) if (file.endsWith('.json')) {
    expect(await fs.readFile(path.join(f.root, file), 'utf8')).not.toMatch(/"(?:vector|centroid)"\s*:\s*\[/)
  }
  const rows = await layeredIndex<{ data: string }[]>(f.root, 'index-read', {}, 'v000002')
  expect(rows.length).toBeGreaterThan(0)
  for (const row of rows) expect(row.data).not.toMatch(/"(?:vector|pointVectors)"\s*:\s*\[/)
})

it('A31 第二设备拒写但可读且接管令牌不能重放', async () => {
  const f = await fixture(), local = await localDevice()
  await writeJson(f.root, 'state/writer.json', { id: '第二设备', name: '远端设备', consumed_takeovers: ['旧令牌'] })
  await expect(buildLayeredLibrary(f.options)).rejects.toThrow('当前设备仅可查询')
  expect((await readLayeredDocument(f.knowledgeRoot, 'S-0002')).status).toBe('ok')
  await expect(checkWriter(f.root, '旧令牌')).rejects.toThrow('当前设备仅可查询')
  await claimWriter(f.root, '新令牌')
  expect(JSON.parse(await fs.readFile(path.join(f.root, 'state/writer.json'), 'utf8')).id).toBe(local.id)
  await writeJson(f.root, 'state/writer.json', { id: '再接管设备', name: '远端设备', consumed_takeovers: ['旧令牌', '新令牌'] })
  await expect(claimWriter(f.root, '新令牌')).rejects.toThrow('当前设备仅可查询')
})

it('A32 第二写者进程在同机建库锁占用期间被拒', async () => {
  const f = await fixture(true)
  await withBuildLock(f.knowledgeRoot, async () => {
    await expect(workers[0]!.run('lock', f.knowledgeRoot)).rejects.toThrow('已有分层建库正在运行')
  })
})

it('A33 旧分层格式拒绝重建并保持原字节', async () => {
  const f = await fixture(true), original = 'format_version: 1\nname: 旧分层库\n'
  await fs.writeFile(path.join(f.root, 'library.yaml'), original)
  await expect(initializeLibrary(f.knowledgeRoot, (await snapshotManifest(f.root)).card!)).rejects.toThrow('请重建')
  expect(await fs.readFile(path.join(f.root, 'library.yaml'), 'utf8')).toBe(original)
})

it('A34 旧流程 state 作业库必须提示备份迁移且不能静默搬走', async () => {
  const f = await layeredIncrementalFixture()
  await fs.unlink(path.join(f.root, 'library.yaml'))
  await fs.mkdir(path.join(f.root, 'state/jobs'), { recursive: true })
  await fs.writeFile(path.join(f.root, 'state/layout.json'), '{"version":1,"directory":"state"}')
  await fs.writeFile(path.join(f.root, 'state/library.json'), '{"protocolVersion":1,"libraryId":"audit-legacy"}')
  await fs.writeFile(path.join(f.root, 'state/jobs/legacy.json'), '{"旧流程作业":"保留"}')
  let error: unknown
  try { await buildLayeredLibrary(f.options) } catch (cause) { error = cause }
  expect.soft(String(error)).toMatch(/备份|迁移|旧.*库|不兼容/)
  expect.soft(await fs.readFile(path.join(f.root, 'state/jobs/legacy.json'), 'utf8').catch(() => '已被搬走')).toContain('旧流程作业')
})

it('A35 旧流程初始化不能把新分层 state 当成迁移目标', async () => {
  const f = await fixture(true), before = await fs.readFile(path.join(f.root, 'state/current.json'))
  await expect(initializeStateLayout(f.root)).rejects.toThrow('分层 Wiki 库')
  expect(await fs.readFile(path.join(f.root, 'state/current.json'))).toEqual(before)
})

it('A41 独立进程已经固定的旧版视图遇撤权后不返回正文', async () => {
  const f = await fixture(), reader = workers[0]!
  expect((await reader.run('hold-read', f.root, 'v000001')).pid).not.toBe(process.pid)
  await revoke(f)
  const result = await reader.run('finish-read', f.root)
  expect(result.document.status).toBe('updating'); expect(result.source.status).toBe('updating')
  expect(JSON.stringify(result)).not.toContain(secret)
})

it('A42 撤权意图尚未提交即崩溃时保持原版且重试可完成', async () => {
  const f = await fixture(), rename = fs.rename
  const fault = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith('revocation-pending.json')) throw new Error('意图提交前崩溃')
    return rename(from, to)
  })
  try { await expect(revoke(f)).rejects.toThrow('意图提交前崩溃') } finally { fault.mockRestore() }
  expect((await readLayeredDocument(f.knowledgeRoot, 'S-0001')).content).toContain(secret)
  expect(JSON.parse(await fs.readFile(path.join(f.root, 'state/revocations.json'), 'utf8')).generation).toBe(0)
  await revoke(f); await cleanBytes(f.root)
})
