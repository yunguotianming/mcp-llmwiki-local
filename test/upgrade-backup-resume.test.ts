import * as fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { hash } from '../src/layered/files.js'
import { canonicalJson, readProtocol, writeProtocol } from '../src/layered/models.js'
import { readUpgradeStatus, upgradeLibrary, verifyUpgradeBackup } from '../src/layered/upgrade.js'
import type { UpgradeOptions } from '../src/layered/upgrade.js'
import { legacyFixture } from './b3-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('升级备份回归禁止网络') })))
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

const metadata = '.llmwiki-upgrade-backup.json'
type Backup = Awaited<ReturnType<typeof verifyUpgradeBackup>>
const options = (): UpgradeOptions => ({ upgrade: { maxCalls: 0 }, steps: [{ id: '待补元数据', kind: 'metadata', stage: 'extract',
  unitIds: ['库'], inputDigest: hash('原输入'), estimatedInputTokens: 10, maxOutputTokens: 10 }],
runStep: vi.fn(async () => { throw new Error('备份阶段不允许执行模型步骤') }) })

async function backups(root: string) {
  const prefix = path.basename(root) + '.backup-before-0.3.0-'
  return (await fs.readdir(path.dirname(root))).filter(name => name.startsWith(prefix)).map(name => path.join(path.dirname(root), name))
}
async function interrupted() {
  const f = await legacyFixture(), config = options(), copy = fs.copyFile, copied: string[] = []
  const spy = vi.spyOn(fs, 'copyFile').mockImplementation(async (...args) => {
    if (copied.length === 2) throw new Error('备份复制中断')
    await copy(...args); copied.push(String(args[1]))
  })
  await expect(upgradeLibrary(f.root, config)).rejects.toThrow('备份复制中断')
  spy.mockRestore()
  const [backup] = await backups(f.root), meta = (await readProtocol<Backup>(backup!, metadata, 'UPGRADE_BACKUP_CORRUPT'))!
  expect(meta.complete).toBe(false); expect(await readUpgradeStatus(f.root)).toBeUndefined()
  return { ...f, config, backup: backup!, meta, copied }
}

it('同一备份连续中断后沿原身份续拷，已有字节不重写且完整后才写检查点', async () => {
  const f = await interrupted(), before = await Promise.all(f.copied.map(async file => ({ file, bytes: await fs.readFile(file), mtime: (await fs.stat(file)).mtimeMs })))
  const controller = new AbortController(), copy = fs.copyFile, resumed: string[] = [], statusIds: string[] = []
  const remaining = Object.keys(f.meta.files).length - f.copied.length
  const spy = vi.spyOn(fs, 'copyFile').mockImplementation(async (...args) => {
    await copy(...args); resumed.push(String(args[1]))
    if (resumed.length === remaining) controller.abort(new Error('最后一项复制后暂停'))
  })
  await expect(upgradeLibrary(f.root, { ...f.config, signal: controller.signal, onStatus: status => { statusIds.push(status.id) } })).rejects.toThrow('最后一项复制后暂停')
  expect(resumed).toHaveLength(remaining); expect(resumed.some(file => f.copied.includes(file))).toBe(false)
  expect((await readProtocol<Backup>(f.backup, metadata, 'UPGRADE_BACKUP_CORRUPT'))!.complete).toBe(false)
  expect(await readUpgradeStatus(f.root)).toBeUndefined()
  spy.mockClear()
  const done = (await upgradeLibrary(f.root, { ...f.config, onStatus: status => { statusIds.push(status.id) } }))!
  expect(spy).not.toHaveBeenCalled(); expect(new Set(statusIds)).toEqual(new Set([f.meta.id]))
  expect(done).toMatchObject({ id: f.meta.id, backupPath: f.backup, status: 'paused', steps: f.meta.upgrade.steps,
    actual: { calls: 0, tokens: 0, unknownUsage: 0 }, accepted: {} })
  expect((await verifyUpgradeBackup(f.backup)).complete).toBe(true)
  expect((await readUpgradeStatus(f.root))!.id).toBe(f.meta.id)
  expect(await backups(f.root)).toEqual([f.backup])
  for (const previous of before) {
    expect(await fs.readFile(previous.file)).toEqual(previous.bytes)
    expect((await fs.stat(previous.file)).mtimeMs).toBe(previous.mtime)
  }
  expect(f.config.runStep).not.toHaveBeenCalled()
})

it('备份已有字节损坏时拒绝且不覆盖损坏证据或另建整库备份', async () => {
  const f = await interrupted(), file = f.copied[0]!
  await fs.writeFile(file, '损坏的已拷贝字节')
  const copy = vi.spyOn(fs, 'copyFile')
  await expect(upgradeLibrary(f.root, f.config)).rejects.toMatchObject({ code: 'UPGRADE_BACKUP_CORRUPT' })
  expect(copy).not.toHaveBeenCalled(); expect(await fs.readFile(file, 'utf8')).toBe('损坏的已拷贝字节')
  expect(await backups(f.root)).toEqual([f.backup]); expect(await readUpgradeStatus(f.root)).toBeUndefined()
  await expect(verifyUpgradeBackup(f.backup)).rejects.toMatchObject({ code: 'UPGRADE_BACKUP_CORRUPT' })
})

it('未完成备份的原库清单变化时拒绝，不另复制或迁签原计划', async () => {
  const f = await interrupted(), before = await fs.readFile(path.join(f.backup, metadata))
  await fs.writeFile(path.join(f.root, '用户新增资料.md'), '新的库内输入')
  const copy = vi.spyOn(fs, 'copyFile')
  await expect(upgradeLibrary(f.root, f.config)).rejects.toMatchObject({ code: 'UPGRADE_INPUT_CHANGED' })
  expect(copy).not.toHaveBeenCalled(); expect(await backups(f.root)).toEqual([f.backup])
  expect(await fs.readFile(path.join(f.backup, metadata))).toEqual(before)
  expect(await readUpgradeStatus(f.root)).toBeUndefined()
})

it('首次备份复制后源文件变化仍拒绝完整标记和正式检查点', async () => {
  const f = await legacyFixture(), config = options(), file = path.join(f.root, '用户资料.md')
  await fs.writeFile(file, '复制前的原字节')
  const copy = fs.copyFile
  vi.spyOn(fs, 'copyFile').mockImplementation(async (...args) => {
    await copy(...args)
    if (String(args[0]) === file) await fs.writeFile(file, '复制后的外部修改')
  })
  await expect(upgradeLibrary(f.root, config)).rejects.toMatchObject({ code: 'UPGRADE_INPUT_CHANGED' })
  const [backup] = await backups(f.root), meta = (await readProtocol<Backup>(backup!, metadata, 'UPGRADE_BACKUP_CORRUPT'))!
  expect(meta.complete).toBe(false); expect(await readUpgradeStatus(f.root)).toBeUndefined()
  expect(config.runStep).not.toHaveBeenCalled()
})

it('多个可承接备份时拒绝自动选取原升级身份', async () => {
  const f = await interrupted(), second = path.join(f.parent, path.basename(f.root) + '.backup-before-0.3.0-duplicate-' + f.meta.id)
  await fs.cp(f.backup, second, { recursive: true })
  const meta = structuredClone(f.meta); meta.upgrade.backupPath = second
  await writeProtocol(second, metadata, meta)
  const copy = vi.spyOn(fs, 'copyFile')
  await expect(upgradeLibrary(f.root, f.config)).rejects.toMatchObject({ code: 'UPGRADE_BACKUP_AMBIGUOUS' })
  expect(copy).not.toHaveBeenCalled(); expect(await backups(f.root)).toHaveLength(2)
  expect(await readUpgradeStatus(f.root)).toBeUndefined()
})

it('完整备份已标记但检查点缺失时损坏仍拒绝，不降级为续拷', async () => {
  const f = await interrupted()
  for (const file of Object.keys(f.meta.files)) {
    const target = path.join(f.backup, file)
    if (f.copied.includes(target)) continue
    await fs.mkdir(path.dirname(target), { recursive: true }); await fs.copyFile(path.join(f.root, file), target)
  }
  f.meta.complete = true
  await writeProtocol(f.backup, metadata, f.meta)
  await fs.writeFile(f.copied[0]!, '完整标记之后损坏')
  const before = await fs.readFile(path.join(f.backup, metadata)), copy = vi.spyOn(fs, 'copyFile')
  await expect(upgradeLibrary(f.root, f.config)).rejects.toMatchObject({ code: 'UPGRADE_BACKUP_CORRUPT' })
  expect(copy).not.toHaveBeenCalled(); expect(await fs.readFile(path.join(f.backup, metadata))).toEqual(before)
  expect(await backups(f.root)).toEqual([f.backup]); expect(await readUpgradeStatus(f.root)).toBeUndefined()
})

it('未完成备份中的未知临时文件拒绝且保留，不清理或另建备份', async () => {
  const f = await interrupted(), unknown = path.join(f.backup, 'unknown.tmp')
  await fs.writeFile(unknown, '不属于本次备份的证据')
  const copy = vi.spyOn(fs, 'copyFile')
  await expect(upgradeLibrary(f.root, f.config)).rejects.toMatchObject({ code: 'UPGRADE_BACKUP_CORRUPT' })
  expect(copy).not.toHaveBeenCalled(); expect(await fs.readFile(unknown, 'utf8')).toBe('不属于本次备份的证据')
  expect(await backups(f.root)).toEqual([f.backup]); expect(await readUpgradeStatus(f.root)).toBeUndefined()
})

it.each(['身份', '清单摘要', '原计划', '零调用状态', '规范编码'])('备份元数据%s不符时拒绝且不回退为新建备份', async kind => {
  const f = await interrupted(), meta = structuredClone(f.meta)
  if (kind === '身份') meta.upgrade.id = '00000000-0000-4000-8000-000000000000'
  else if (kind === '清单摘要') meta.inputDigest = hash('伪造的清单')
  else if (kind === '原计划') meta.upgrade.steps[0]!.unitIds = ['扩大的目标']
  else if (kind === '零调用状态') meta.upgrade.actual.calls = 1
  const bytes = kind === '规范编码' ? JSON.stringify(meta, null, 2) + '\n' : canonicalJson(meta) + '\n'
  await fs.writeFile(path.join(f.backup, metadata), bytes)
  const copy = vi.spyOn(fs, 'copyFile')
  await expect(upgradeLibrary(f.root, f.config)).rejects.toMatchObject({ code: 'UPGRADE_BACKUP_CORRUPT' })
  expect(copy).not.toHaveBeenCalled(); expect(await backups(f.root)).toEqual([f.backup])
  expect(await readUpgradeStatus(f.root)).toBeUndefined()
})
