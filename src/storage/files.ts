import { createHash, randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { promisify } from 'node:util'
import { safePath } from './paths.js'
export const signature = (value: string | Uint8Array): string => createHash('sha256').update(value).digest('hex')
export async function clearHiddenAttribute(root: string, warn: (message: string) => void | Promise<void> = console.warn): Promise<void> {
  if (process.platform !== 'win32' || path.basename(root).toLowerCase() !== '.llmwiki') return
  try { await promisify(execFile)('attrib.exe', ['-H', root], { windowsHide: true }) }
  catch (error) {
    const message = `清除 Hidden 隐藏属性失败，继续初始化 ${root}：${error instanceof Error ? error.message : String(error)}`
    await warn(message)
  }
}
export async function readOptional<T>(file: string): Promise<T | undefined> {
  try { return JSON.parse(await readFile(file, 'utf8')) as T }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined; throw error }
}
// 调用方持有库写锁；暂存文件仅位于随库状态区。
export async function writeState(root: string, relative: string, value: unknown): Promise<void> {
  if (!relative.startsWith('.llmwiki/') || relative.replaceAll('\\', '/').split('/').some(part => part === '..' || part === '.')) throw new Error('机器状态必须写入 .llmwiki/。')
  const file = await safePath(root, relative)
  await mkdir(path.dirname(file), { recursive: true })
  const temp = await safePath(root, '.llmwiki/' + randomUUID() + '.tmp')
  let writeError:unknown
  try {
    const handle = await open(temp, 'wx')
    try { await handle.writeFile(JSON.stringify(value, null, 2)); await handle.sync() } finally { await handle.close() }
    for(let attempt=0;;attempt++){
      try{await rename(temp,file);break}
      catch(error){
        // Windows 读取或扫描造成的短暂占用可使原子替换失败；保留目标文件并有限重试。
        if(process.platform!=='win32'||!(error instanceof Error)||!('code'in error)||
          !['EPERM','EACCES','EBUSY'].includes(String(error.code))||attempt>=6){
          if(error instanceof Error){
            const target=await stat(file).catch(()=>undefined)
            Object.assign(error,{ioDiagnostic:{operation:'rename',file,temp,code:'code'in error?error.code:undefined,attempts:attempt+1,
              writerPid:process.pid,platform:process.platform,holder:'unknown',target:target?{size:target.size,mode:target.mode,modifiedAt:target.mtime.toISOString()}:null}})
            error.message+='；原子替换已尝试'+(attempt+1)+'次，目标：'+file+'；占用进程尚未确定，原目标未删除。'
          }
          throw error
        }
        await delay(25*2**attempt)
      }
    }
  } catch(error) { writeError=error;throw error }
  finally { await unlink(temp).catch(error => {
    if(error.code==='ENOENT')return
    if(writeError instanceof Error){Object.assign(writeError,{cleanupError:{message:String(error.message),code:error.code,file:temp}});return}
    throw error
  }) }
}
export async function saveObject(root: string, bytes: Uint8Array): Promise<string> {
  const hash = signature(bytes)
  const file = await safePath(root, '.llmwiki/objects/' + hash)
  await mkdir(path.dirname(file), { recursive: true })
  try {
    const handle = await open(file, 'wx')
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
    if (signature(await readFile(file)) !== hash) throw new Error('不可变快照对象校验失败，请先检查数据库。')
  }
  return hash
}
