import { execFile } from 'node:child_process'
import { hostname, homedir } from 'node:os'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { promisify } from 'node:util'
import { safePath } from '../storage/paths.js'
import { readOptional } from '../storage/files.js'
import { hash, hashName, writeJson } from './files.js'

export interface DeviceIdentity { id: string; name: string }
interface WriterIdentity extends DeviceIdentity { takeover?: string; consumed_takeovers?: string[] }
let identity: Promise<DeviceIdentity> | undefined
export function localDevice(): Promise<DeviceIdentity> {
  return identity ??= (async () => {
    let key: string | undefined
    if (process.platform === 'win32') {
      const { stdout } = await promisify(execFile)('reg.exe', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64'], { windowsHide: true })
      key = /MachineGuid\s+REG_SZ\s+(\S+)/i.exec(stdout)?.[1]
      if (!key) throw new Error('无法读取本机 MachineGuid，拒绝登记建库设备。')
    } else {
      key = await readFile('/etc/machine-id', 'utf8').catch(() => undefined)
      if (!key) {
        const file = path.join(homedir(), '.config', 'dsh-llmwiki', 'device-id')
        await mkdir(path.dirname(file), { recursive: true })
        await writeFile(file, randomUUID(), { flag: 'wx' }).catch(error => { if (error.code !== 'EEXIST') throw error })
        key = await readFile(file, 'utf8')
      }
    }
    return { id: hashName(hash('dsh-llmwiki-device-v1:' + key.trim().toLowerCase())), name: hostname() }
  })()
}
export async function checkWriter(root: string, token?: string): Promise<void> {
  const device = await localDevice(), writer = await readOptional<WriterIdentity>(await safePath(root, 'state/writer.json'))
  if (!writer && !token && await readOptional(await safePath(root, 'state/current.json'))) throw new Error('更新未完整：建库设备登记缺失。请等待同步，或停止原设备后在高级设置接管建库设备。')
  if (writer && writer.id !== device.id && (!token || writer.takeover === token || writer.consumed_takeovers?.includes(token))) {
    throw new Error(`本库登记的建库设备为「${writer.name}」。当前设备仅可查询；请先停止原设备建库，再到高级设置点击“接管建库设备”，保存后重新建库。`)
  }
}
export async function claimWriter(root: string, token?: string): Promise<void> {
  await checkWriter(root, token)
  const device = await localDevice(), previous = await readOptional<WriterIdentity>(await safePath(root, 'state/writer.json'))
  if (previous?.id !== device.id || token && token !== previous.takeover) {
    // 同步了旧设置的原设备不能重放早先的接管操作；再次接管须点击按钮生成新令牌。
    const consumed = [...new Set([...(previous?.consumed_takeovers ?? []), ...previous?.takeover ? [previous.takeover] : [], ...token ? [token] : []])]
    await writeJson(root, 'state/writer.json', { ...device, takeover: token ?? previous?.takeover, consumed_takeovers: consumed, registered_at: new Date().toISOString() })
  }
}
