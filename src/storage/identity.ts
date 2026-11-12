import { safePath, stateDirectory } from './paths.js'
import path from 'node:path'
import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

// 身份文件共享一个提交点；提交前的读者始终读暂存的旧身份。
export const identityFiles = ['.llmwiki/library.json', 'state/library.json', 'state/writer.json'] as const
const journal = 'state/identity-transaction.json'
const filesFor = async (root: string) => await stateDirectory(root) === 'data/state' ? ['state/library.json', 'state/writer.json'] : [...identityFiles]
const fileAt = (root: string, relative: string) => safePath(root, relative, false)
interface Transaction { token: string; committed: boolean; previous: (string | null)[] }
async function transaction(root: string): Promise<Transaction | undefined> {
  let raw: string
  try { raw = await readFile(await fileAt(root, journal), 'utf8') }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error }
  const value = JSON.parse(raw) as Transaction
  if (!/^[a-f0-9-]{36}$/.test(value.token) || typeof value.committed !== 'boolean' || !Array.isArray(value.previous)
    || value.previous.length !== (await filesFor(root)).length || value.previous.some(item => item !== null && typeof item !== 'string')) throw new Error('库身份事务记录无效，请先恢复。')
  return value
}
async function staged(root: string, token: string, index: number, kind: string) {
  return fileAt(root, `state/identity-${token}-${index}.${kind}`)
}
async function durable(file: string, content: string) {
  await mkdir(path.dirname(file), { recursive: true })
  const handle = await open(file, 'wx')
  try { await handle.writeFile(content, 'utf8'); await handle.sync() } finally { await handle.close() }
}
async function remove(file: string) {
  await unlink(file).catch(error => { if (error.code !== 'ENOENT') throw error })
}
export async function identityReadPath(root: string, relative: string): Promise<string | undefined> {
  if (!['state/library.json', 'state/writer.json', '.llmwiki/library.json'].includes(relative.replace(/^data\//, ''))) return
  const index = (await filesFor(root)).indexOf(relative.replace(/^data\//, ''))
  if (index < 0) return
  const value = await transaction(root)
  if (value && !value.committed) return await staged(root, value.token, index, 'old')
}
// 调用方持有登记与建库写锁。进程中断后再次操作时恢复；不接管或删除遗留锁。
export async function recoverIdentity(root: string): Promise<void> {
  const value = await transaction(root)
  if (!value) return
  if (!value.committed) for (const [index, relative] of (await filesFor(root)).entries()) {
    const file = await fileAt(root, relative), previous = value.previous[index]!
    if (previous === null) await remove(file)
    else {
      const temp = await staged(root, value.token, index, 'restore')
      await remove(temp); await durable(temp, previous); await rename(temp, file)
    }
  }
  await remove(await fileAt(root, journal))
  // 已取得旧路径的并发读者可能尚未打开文件，保留小型身份备份供其完成读取。
  for (let index = 0; index < (await filesFor(root)).length; index++) for (const kind of ['new', 'restore']) await remove(await staged(root, value.token, index, kind))
}
export async function replaceIdentity(root: string, values: (unknown | undefined)[], beforeCommit: () => void): Promise<void> {
  if (await stateDirectory(root) === 'data/state') values = [values[1] ?? values[0], values[2]]
  await recoverIdentity(root)
  const token = randomUUID(), previous = await Promise.all((await filesFor(root)).map(async relative => readFile(await fileAt(root, relative), 'utf8').catch(error => {
    if (error.code === 'ENOENT') return null
    throw error
  })))
  const value: Transaction = { token, committed: false, previous }, marker = await fileAt(root, journal), temp = marker + '.' + token + '.tmp'
  let installed = false, committed = false
  try {
    for (const [index, content] of previous.entries()) {
      if (content !== null) await durable(await staged(root, token, index, 'old'), content)
      if (values[index] !== undefined) await durable(await staged(root, token, index, 'new'), JSON.stringify(values[index], null, 2) + '\n')
    }
    await durable(temp, JSON.stringify(value)); await rename(temp, marker); installed = true
    for (const [index, relative] of (await filesFor(root)).entries()) if (values[index] !== undefined) {
      await mkdir(path.dirname(await fileAt(root, relative)), { recursive: true })
      await rename(await staged(root, token, index, 'new'), await fileAt(root, relative))
    }
    beforeCommit()
    await durable(temp, JSON.stringify({ ...value, committed: true })); await rename(temp, marker); committed = true
  } catch (error) {
    if (installed) await recoverIdentity(root)
    throw error
  } finally {
    await remove(temp)
    if (!installed) for (let index = 0; index < (await filesFor(root)).length; index++) for (const kind of ['old', 'new']) await remove(await staged(root, token, index, kind))
  }
  // 提交点之后清理失败不回报签发失败；下次操作重试清理。
  if (committed) await recoverIdentity(root).catch(() => {})
}
