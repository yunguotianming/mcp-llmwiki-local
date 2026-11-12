import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { realpath, lstat, readFile, mkdir, writeFile, readdir, rename } from 'node:fs/promises'
import { parse } from 'yaml'
import { readFileSync } from 'node:fs'
import { identityReadPath } from './identity.js'
type StateDirectory = '.llmwiki' | 'state' | 'data/state'
const layouts = new AsyncLocalStorage<{ root: string; state: StateDirectory; active: boolean }>()
// 建库与提交持有写锁，布局在操作开始前确定；每个目标仍独立解析真实路径并校验边界。
export async function withStateLayout<T>(root: string, action: () => Promise<T>): Promise<T> {
  const actual = await realpath(root), state = await stateDirectory(actual), context = { root: actual, state, active: true }
  try { return await layouts.run(context, action) }
  finally { context.active = false }
}
export async function isLayeredRoot(root: string): Promise<boolean> {
  try {
    const card = parse(readFileSync(path.join(root, 'library.yaml'), 'utf8'))
    return card?.format_version !== undefined
  } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false; throw error }
}
export function within(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))
}
export async function actualPath(input: string): Promise<string> {
  if (!path.isAbsolute(input)) throw new Error('请使用绝对路径。')
  const missing: string[] = []; let current = path.normalize(input)
  for (;;) {
    try { return path.join(await realpath(current), ...missing.reverse()) }
    catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      const parent = path.dirname(current)
      if (parent === current) throw error
      missing.push(path.basename(current)); current = parent
    }
  }
}
export async function safePath(root: string, relative: string, readIdentity = true): Promise<string> {
  if (!relative || path.isAbsolute(relative) || relative.includes('\0')) throw new Error('库内路径无效。')
  const actualRoot = await realpath(root)
  const normalized = relative.replaceAll('\\', '/')
  // 旧批次继续保存逻辑状态路径，实际目录由随库布局标记决定。
  const legacyPath = normalized === '.llmwiki' || normalized.startsWith('.llmwiki/')
  const state = await stateDirectory(actualRoot)
  const resolved = legacyPath ? state + normalized.slice('.llmwiki'.length)
    : state === 'data/state' && /^(objects|versions|state|work|logs|cache|conflicts)(\/|$)/.test(normalized) ? 'data/' + normalized : normalized
  const identityPath = readIdentity ? await identityReadPath(actualRoot, resolved) : undefined
  const target = await actualPath(identityPath ?? path.resolve(actualRoot, resolved))
  if (!within(actualRoot, target) || target === actualRoot) throw new Error('路径越出了当前数据库。')
  return target
}
export async function stateDirectory(root: string): Promise<StateDirectory> {
  const context = layouts.getStore()
  if (context?.active && context.root === root) return context.state
  const partition = await actualPath(path.join(root, 'data/layout.json'))
  if (!within(root, partition)) throw new Error('库布局越出了当前数据库。')
  try {
    const layout = JSON.parse(await readFile(partition, 'utf8'))
    if (layout.version !== 2 || layout.directory !== 'data') throw new Error('库布局标记无效。')
    return 'data/state'
  } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
  const marker = await actualPath(path.join(root, 'state/layout.json'))
  if (!within(root, marker)) throw new Error('状态布局越出了当前数据库。')
  let content: string
  try { content = await readFile(marker, 'utf8') }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return '.llmwiki'; throw error }
  // 没有旧布局标记时无需探测格式；有标记时优先识别真正的分层库。
  if (await isLayeredRoot(root) || await isLayeredRoot(path.join(root, '.llmwiki'))) return '.llmwiki'
  const layout = JSON.parse(content) as { version?: number; directory?: string }
  if (!layout || layout.version !== 1 || layout.directory !== 'state') throw new Error('状态布局标记无效，请先核对数据库。')
  try { await lstat(path.join(root, '.llmwiki')) }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return 'state'; throw error }
  throw new Error('同时发现两套状态目录，请先核对迁移结果。')
}
export async function initializeStateLayout(root: string): Promise<void> {
  if (await isLayeredRoot(root)) throw new Error('这是分层 Wiki 库，不能用旧生成流程初始化状态目录。')
  if (await stateDirectory(root) === 'data/state') return
  if (/^\.llmwiki-[a-z0-9-]+$/.test(path.basename(root))) {
    if ((await readdir(root)).length === 0) await initializePartitionLayout(root)
    return
  }
  if (path.basename(root).toLowerCase() !== '.llmwiki' || await stateDirectory(root) === 'state') return
  // 已有库保留旧布局；明确选定的库在停止写入后迁移，不在初始化时自动搬动。
  try { await lstat(path.join(root, '.llmwiki')); return }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
  const state = await actualPath(path.join(root, 'state'))
  if (!within(root, state)) throw new Error('状态目录越出了当前数据库。')
  await mkdir(state, { recursive: true })
  const entries = await readdir(state)
  if (entries.length && !entries.includes('layout.json')) throw new Error('已有 state 目录尚未登记为插件状态区，请先核对内容。')
  try { await writeFile(path.join(state, 'layout.json'), JSON.stringify({ version: 1, directory: 'state' }) + '\n', { flag: 'wx' }) }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error }
  if (await stateDirectory(root) !== 'state') throw new Error('状态布局初始化未完成。')
}
export async function initializePartitionLayout(root: string): Promise<void> {
  const data = await actualPath(path.join(root, 'data'))
  if (!within(root, data) || data === root) throw new Error('内部数据目录越界。')
  await mkdir(data, { recursive: true })
  await writeFile(path.join(data, 'layout.json'), JSON.stringify({ version: 2, directory: 'data' }) + '\n', { flag: 'wx' })
  await writeFile(path.join(root, 'README.md'), '# 库目录说明\n\n打开 wiki/ 阅读页面，Obsidian 也应打开此目录。library.yaml 是库卡片。\n\ndata/ 是内部数据，请勿手动修改：objects 保存不可变对象，versions 保存版本清单，state 保存身份、策略和协调状态，work 保存未完成作业，logs 保存运行记录；cache 和 conflicts 在需要时创建。\n\n搬迁前停止写入，完整复制整个库目录，在新位置重新登记并按提示重新签发库 ID。请保留资料目录结构。旧设备停止写入后才可接管。\n\n换模型请使用“复制并切换向量模型”，显式确认后在同一资料根下生成独立副本；主题和页面保留，只重算向量。两个库此后各自更新。\n', { flag: 'wx' })
}
// 调用前必须停止所有写入端；不改动快照、策略和旧批次中的逻辑路径。
export async function migrateDefaultStateLayout(root: string): Promise<boolean> {
  const actual = await realpath(root)
  if (await isLayeredRoot(actual)) throw new Error('这是分层 Wiki 库，不能迁移其 state 目录。')
  if (path.basename(actual).toLowerCase() !== '.llmwiki') throw new Error('只迁移默认 .llmwiki 成果目录。')
  if (await stateDirectory(actual) === 'state') return false
  const legacy = await safePath(actual, '.llmwiki'), target = path.join(actual, 'state')
  if ((await lstat(path.join(actual, '.llmwiki'))).isSymbolicLink()) throw new Error('状态目录是链接，不能迁移。')
  const metadata = JSON.parse(await readFile(path.join(legacy, 'library.json'), 'utf8'))
  if (!metadata.libraryId || metadata.protocolVersion !== 1) throw new Error('旧状态区身份无效，不能迁移。')
  for (const name of ['coordination/write.lock', 'coordination/recovery.json', 'coordination/obsidian.json']) {
    try { await lstat(path.join(legacy, name)) }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') continue; throw error }
    throw new Error('状态区仍有写锁、恢复记录或共管协议，不能迁移。')
  }
  let jobs: string[] = []
  try { jobs = await readdir(path.join(legacy, 'jobs')) }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
  for (const name of jobs.filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
    const job = JSON.parse(await readFile(path.join(legacy, 'jobs', name), 'utf8'))
    if (job.status === 'running') throw new Error('还有运行中的作业，请先停止并保存检查点。')
  }
  try { await lstat(target) }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
    await rename(legacy, target)
    try { await writeFile(path.join(target, 'layout.json'), JSON.stringify({ version: 1, directory: 'state' }) + '\n', { flag: 'wx' }) }
    catch (error) { await rename(target, legacy); throw error }
    return true
  }
  throw new Error('目标 state 已存在，请先核对内容。')
}
export async function directory(input: string): Promise<string> {
  const actual = await actualPath(input)
  if (!(await lstat(actual)).isDirectory()) throw new Error('所选路径不是目录。')
  return actual
}
export async function validateRoots(wikiPath: string, sourceRoots: string[]): Promise<{ wiki: string; sources: string[] }> {
  const wiki = await actualPath(wikiPath)
  const sources: string[] = []
  for (const root of sourceRoots) {
    const source = await directory(root)
    if (within(wiki, source)) throw new Error('原始资料目录不能是 Wiki 目录本身或其子目录。')
    if (!sources.includes(source)) sources.push(source)
  }
  return { wiki, sources }
}
