import { Worker } from 'node:worker_threads'
import { mkdir, readdir, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'
import { withRevocationLock } from '../layered/files.js'
import { checkGeneration, readRevocations } from '../layered/revocations.js'
import type { GenerateJob } from '../wiki/generation.js'
import { readOptional, signature, writeState } from './files.js'
import { safePath } from './paths.js'
import { withLibraryLock } from './lock.js'

interface StorageMarker { version: 1; backend: 'sqlite'; libraryId: string; imported: { id: string; hash: string }[] }
interface Row { ordinal: number; key: string; json: string }
interface Patch { id: string; header: string; chunks: Row[]; attempts: Row[]; checkpoints: Row[] }
export interface IndexRow { path: string; stamp: string; data: string; title: string; aliases: string; identity: string; body: string }
interface Rpc { file: string; operation: 'initialize' | 'read' | 'summary' | 'save' | 'verify' | 'index-read' | 'index-save' | 'index-search'; libraryId?: string; patches?: Patch[]; pages?: IndexRow[]; removed?: string[]; query?: string }
let worker: Worker | undefined, sequence = 0, idle: ReturnType<typeof setTimeout> | undefined
const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
function rpc<T>(request: Rpc): Promise<T> {
  if (idle) clearTimeout(idle)
  if (!worker) {
    const current = new Worker(new URL(import.meta.url.endsWith('.ts') ? './sqlite-worker.ts' : './sqlite-worker.js', import.meta.url), { execArgv: process.execArgv.filter(value => !value.startsWith('--input-type')) })
    worker = current
    const failed = (error: Error) => {
      if (worker === current) worker = undefined
      for (const item of pending.values()) item.reject(error)
      pending.clear()
    }
    current.on('error', failed)
    current.on('exit', code => { if (worker === current) failed(new Error('SQLite 工作线程退出：' + code)) })
    current.on('message', (message: { id: number; value?: unknown; error?: string|{message:string;code:string;operation:string;file:string} }) => {
      const item = pending.get(message.id); pending.delete(message.id)
      if (message.error) item?.reject(typeof message.error==='string'?new Error(message.error):Object.assign(new Error(message.error.message),{code:message.error.code,ioDiagnostic:{operation:message.error.operation,file:message.error.file,writerPid:process.pid}})); else item?.resolve(message.value)
      if (!pending.size) {
        current.unref()
        idle = setTimeout(() => { if (!pending.size && worker === current) { worker = undefined; void current.terminate() } }, 1000)
        idle.unref()
      }
    })
  }
  worker.ref()
  const id = ++sequence
  return new Promise<T>((resolve, reject) => { pending.set(id, { resolve: value => resolve(value as T), reject }); worker!.postMessage({ ...request, id }) })
}
export async function sqliteIndex<T>(root: string, operation: 'index-read' | 'index-save' | 'index-search', input: { pages?: IndexRow[]; removed?: string[]; query?: string } = {}): Promise<T> {
  const marker = await jobStorage(root)
  if (!marker) throw new Error('当前库未启用 SQLite。')
  return rpc<T>({ file: await database(root), operation, libraryId: marker.libraryId, ...input })
}
// 分层库只复用派生检索表和 FTS，不创建旧格式的存储迁移标记。
export function layeredCacheDirectory(root: string): string {
  return path.join(process.env.LOCALAPPDATA ?? path.join(homedir(), '.cache'), 'dsh-llmwiki', 'query-cache', signature(path.resolve(root)))
}
export async function invalidateLayeredIndex(root: string): Promise<void> {
  const folder = layeredCacheDirectory(root)
  const entries = await readdir(folder).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  for (const entry of entries) if (/^v\d+-g\d+\.sqlite(?:-wal|-shm)?$/.test(entry)) await unlink(path.join(folder, entry)).catch(error => { if (error.code !== 'ENOENT') throw error })
}
export async function layeredIndex<T>(root: string, operation: 'index-read' | 'index-save' | 'index-search', input: { pages?: IndexRow[]; removed?: string[]; query?: string } = {}, version?: string, generation?: number): Promise<T> {
  return withRevocationLock(root, async () => {
  if (generation !== undefined) await checkGeneration(root, generation)
  else generation = (await readRevocations(root)).generation
  version ??= (await readOptional<{ version: string }>(await safePath(root, 'state/current.json')))?.version
  if (!version || !/^v\d{6,}$/.test(version)) throw new Error('查询索引缺少固定版本。')
  const folder = layeredCacheDirectory(root)
  await mkdir(folder, { recursive: true })
  // 撤权代次变化先清除本机旧缓存；库路径哈希隔离不同资料库。
  for (const entry of await readdir(folder)) if (/^v\d+-g\d+\.sqlite(?:-wal|-shm)?$/.test(entry) && !entry.includes(`-g${generation}.sqlite`)) await unlink(path.join(folder, entry)).catch(error => { if (error.code !== 'ENOENT') throw error })
  const file = path.join(folder, `${version}-g${generation}.sqlite`), libraryId = 'layered-query-v3:' + version + ':' + generation
  await mkdir(path.dirname(file), { recursive: true })
  if (operation === 'index-read') {
    // 已有索引直接只读打开，身份仍由工作线程核验；删除派生库后才重新建表。
    try { await stat(file) }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      await rpc({ file, libraryId, operation: 'initialize' })
    }
  }
  return rpc<T>({ file, libraryId, operation, ...input })
  })
}
const database = (root: string) => safePath(root, '.llmwiki/wiki.sqlite')
export async function jobStorage(root: string): Promise<StorageMarker | undefined> {
  const marker = await readOptional<StorageMarker>(await safePath(root, '.llmwiki/storage.json'))
  if (marker && (marker.version !== 1 || marker.backend !== 'sqlite' || !marker.libraryId)) throw new Error('状态存储标记不兼容。')
  return marker
}
async function legacyJobs(root: string): Promise<GenerateJob[]> {
  let names: string[]
  try { names = await readdir(await safePath(root, '.llmwiki/jobs')) }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []; throw error }
  const values = await Promise.all(names.filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(async name => readOptional<GenerateJob>(await safeJobPath(root, name))))
  return values.filter((value): value is GenerateJob => value?.kind === 'generate')
}
// 异步路径解析保持在每个读写边界，不能用字符串拼接绕过目录检查。
async function safeJobPath(root: string, name: string): Promise<string> { return safePath(root, '.llmwiki/jobs/' + name) }
export async function readGenerateJobs(root: string): Promise<GenerateJob[]> {
  const marker = await jobStorage(root)
  const values = marker ? await rpc<GenerateJob[]>({ file: await database(root), operation: 'read', libraryId: marker.libraryId }) : await legacyJobs(root)
  return values.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}
export async function readGenerateJobSummaries(root: string): Promise<GenerateJob[]> {
  const marker=await jobStorage(root)
  const jobs=marker?await rpc<GenerateJob[]>({file:await database(root),operation:'summary',libraryId:marker.libraryId}):await legacyJobs(root)
  return jobs.sort((a,b)=>b.createdAt.localeCompare(a.createdAt))
}
const snapshots = new WeakMap<GenerateJob, Map<string, string>>()
const immutableRows = new WeakMap<object, { key: string; json: string }>()
function patchFor(job: GenerateJob, previous: Map<string, string>): Patch {
  const { chunks, attempts, synthesis, ...header } = job
  const changed = <T>(items: T[], collection: string, key: (item: T, ordinal: number) => string): Row[] => items.flatMap((item, ordinal) => {
    const logicalKey = key(item, ordinal), cached = typeof item === 'object' && item ? immutableRows.get(item) : undefined
    const json = cached?.key === logicalKey ? cached.json : JSON.stringify(item), identity = collection + ':' + ordinal
    // 生成器完成的片段与综合检查点不再原地修改；在途尝试仍逐次记录完整状态。
    const row = item as { status?: string; finish?: string; durationMs?: number }
    if (typeof item === 'object' && item && (collection === 'checkpoints' || collection === 'chunks' && ['complete', 'split'].includes(row.status ?? '') || collection === 'attempts' && row.finish !== 'pending' && (row.durationMs ?? 0) > 0)) immutableRows.set(item, { key: logicalKey, json })
    return previous.get(identity) === json ? [] : [{ ordinal, key: key(item, ordinal), json }]
  })
  return { id: job.id, header: JSON.stringify(header), chunks: changed(chunks, 'chunks', item => item.key),
    attempts: changed(attempts, 'attempts', (_item, index) => String(index)), checkpoints: changed(synthesis ?? [], 'checkpoints', item => item.key) }
}
export async function writeGenerateJob(root: string, job: GenerateJob): Promise<{ bytes: number; rows: number }> {
  const marker = await jobStorage(root)
  if (!marker) { await writeState(root, `.llmwiki/jobs/${job.id}.json`, job); return { bytes: Buffer.byteLength(JSON.stringify(job)), rows: 1 } }
  if (marker.libraryId !== job.libraryId) throw new Error('SQLite 作业库身份不匹配。')
  let previous = snapshots.get(job)
  if (!previous) {
    // 接续读取后第一次保存先对照数据库；只传输实际变化的行。
    previous = new Map<string, string>()
    const persisted = (await readGenerateJobs(root)).find(item => item.id === job.id)
    if (persisted) for (const [collection, items] of [['chunks', persisted.chunks], ['attempts', persisted.attempts], ['checkpoints', persisted.synthesis ?? []]] as const)
      items.forEach((item, index) => previous!.set(collection + ':' + index, JSON.stringify(item)))
    snapshots.set(job, previous)
  }
  const patch = patchFor(job, previous), result = await rpc<{ bytes: number; rows: number }>({ file: await database(root), operation: 'save', libraryId: marker.libraryId, patches: [patch] })
  for (const collection of ['chunks', 'attempts', 'checkpoints'] as const) for (const row of patch[collection]) previous.set(collection + ':' + row.ordinal, row.json)
  return result
}
// 回退先导出当前全部状态再撤销路由标记，保留 SQLite 文件供核对；不能直接启用冻结的旧 JSON。
export async function restoreFileJobStorage(root: string, libraryId: string): Promise<void> {
  await withLibraryLock(root, 'restore-json-storage', async () => {
    const marker = await jobStorage(root)
    if (!marker || marker.libraryId !== libraryId) throw new Error('SQLite 回退身份不匹配。')
    const jobs = await readGenerateJobs(root)
    if (jobs.some(job => job.status === 'running')) throw new Error('请先正常停止运行作业。')
    for (const job of jobs) await writeState(root, `.llmwiki/jobs/${job.id}.json`, job)
    const restored = await legacyJobs(root)
    if (jobs.some(job => JSON.stringify(job) !== JSON.stringify(restored.find(item => item.id === job.id)))) throw new Error('回退导出核对失败，保留 SQLite 路由。')
    await unlink(await safePath(root, '.llmwiki/storage.json'))
  })
}
// 调用方先确认所有旧执行器退出。导入不改旧文件，校验后最后写标记，切换后只有 SQLite 写入。
export async function migrateJobStorage(root: string, libraryId: string): Promise<{ jobs: number; chunks: number; checkpoints: number; imported: boolean }> {
  return withLibraryLock(root, 'migrate-sqlite', async () => {
    const marker = await jobStorage(root)
    if (marker) { if (marker.libraryId !== libraryId) throw new Error('状态存储库身份不匹配。'); return { jobs: 0, chunks: 0, checkpoints: 0, imported: false } }
    const metadata = await readOptional<{ libraryId: string }>(await safePath(root, '.llmwiki/library.json'))
    if (metadata?.libraryId !== libraryId) throw new Error('库身份不匹配，拒绝迁移。')
    if (await readOptional(await safePath(root, '.llmwiki/coordination/obsidian.json'))) throw new Error('共管库尚未支持 SQLite，保持原协议。')
    const jobs = await legacyJobs(root)
    if (jobs.some(job => job.status === 'running')) throw new Error('还有运行中的生成任务，请先正常停止。')
    if (jobs.some(job => job.libraryId !== libraryId)) throw new Error('旧作业含其他库身份，拒绝迁移。')
    const file = await database(root)
    await rpc({ file, operation: 'initialize', libraryId })
    // 重复导入覆盖同一位置；尚未切换时仍以旧文件为真值。
    for (const job of jobs) await rpc({ file, operation: 'save', patches: [patchFor(job, new Map())] })
    const imported = await rpc<GenerateJob[]>({ file, operation: 'read' })
    const ordered = (value: unknown): unknown => Array.isArray(value) ? value.map(ordered) : value && typeof value === 'object'
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, ordered(item)])) : value
    const canonical = (job: GenerateJob) => JSON.stringify(ordered({ ...job, synthesis: job.synthesis ?? [] }))
    if (imported.length !== jobs.length || jobs.some(job => canonical(job) !== canonical(imported.find(item => item.id === job.id)!))) throw new Error('SQLite 导入逐项校验失败，继续使用旧存储。')
    const check = await rpc<{ integrity: { integrity_check: string }; foreignKeys: unknown[] }>({ file, operation: 'verify' })
    if (check.integrity.integrity_check !== 'ok' || check.foreignKeys.length) throw new Error('SQLite 完整性校验失败，未切换。')
    await writeState(root, '.llmwiki/storage.json', { version: 1, backend: 'sqlite', libraryId, imported: jobs.map(job => ({ id: job.id, hash: signature(canonical(job)) })) } satisfies StorageMarker)
    return { jobs: jobs.length, chunks: jobs.reduce((sum, job) => sum + job.chunks.length, 0), checkpoints: jobs.reduce((sum, job) => sum + (job.synthesis?.length ?? 0), 0), imported: true }
  })
}
