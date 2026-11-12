import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { safePath } from './paths.js'
const processInstance = randomUUID()
export interface LockInfo { protocolVersion: 1; ownerToken: string; pid: number; processInstance: string; operation: string; startedAt: string }
export async function withLibraryLock<T>(root: string, operation: string, action: () => Promise<T>, recovering = false): Promise<T> {
  const file = await safePath(root, '.llmwiki/coordination/write.lock')
  await mkdir(path.dirname(file), { recursive: true })
  const info: LockInfo = { protocolVersion: 1, ownerToken: randomUUID(), pid: process.pid, processInstance, operation, startedAt: new Date().toISOString() }
  let handle
  try { handle = await open(file, 'wx') }
  catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') throw new Error('数据库有写锁。请等待当前操作，异常退出的锁需要先诊断恢复。')
    throw error
  }
  try {
    await handle.writeFile(JSON.stringify(info)); await handle.sync()
    if (!recovering) {
      try {
        const marker = JSON.parse(await readFile(await safePath(root, '.llmwiki/coordination/recovery.json'), 'utf8')) as { writer?: string }
        throw new Error(marker.writer === 'obsidian-llm-wiki-local' ? 'Obsidian Wiki 有未完成提交，请回 Obsidian 核对恢复记录后继续。' : '数据库有未完成提交，请先诊断恢复。')
      }
      catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    }
    return await action()
  } finally {
    await handle.close()
    const current = JSON.parse(await readFile(file, 'utf8')) as LockInfo
    if (current.ownerToken !== info.ownerToken) throw new Error('写锁持有者已变化，已保留锁供诊断。')
    await unlink(file)
  }
}
export async function inspectLock(root: string): Promise<LockInfo | null> {
  try { return JSON.parse(await readFile(await safePath(root, '.llmwiki/coordination/write.lock'), 'utf8')) as LockInfo }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error }
}
export async function releaseExitedLock(root: string, ownerToken: string): Promise<void> {
  const info = await inspectLock(root)
  if (!info || info.ownerToken !== ownerToken || !Number.isInteger(info.pid) || info.pid < 1) throw new Error('锁身份已变化或无效，保留现场。')
  try { process.kill(info.pid, 0) }
  catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw new Error('无法确认原持有者退出，请先停止写入端。')
    const current = await inspectLock(root)
    if (current?.ownerToken !== ownerToken) throw new Error('锁身份已变化，保留现场。')
    await unlink(await safePath(root, '.llmwiki/coordination/write.lock')); return
  }
  throw new Error('持有者进程仍然存在，请先停止对应写入端。')
}
