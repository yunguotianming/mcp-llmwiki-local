import * as fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it } from 'vitest'
import { atomicWrite, immutableWrite } from '../src/layered/files.js'
import { safePath, within } from '../src/storage/paths.js'
import { scanSourceFiles } from '../src/ingest/scanner.js'

// 路径边界用例保留真实 realpath，不使用流程夹具的路径加速替身。
const owned: string[] = []
async function fixture() {
  const base = await fs.mkdtemp(path.join(tmpdir(), 'storage-audit-path-'))
  owned.push(base)
  const root = path.join(base, '.llmwiki')
  await fs.mkdir(root)
  await fs.writeFile(path.join(base, 'outside.sentinel'), '库外哨兵')
  return { base, root }
}
afterEach(async () => {
  for (const base of owned.splice(0)) {
    if (path.dirname(base) !== path.resolve(tmpdir()) || !path.basename(base).startsWith('storage-audit-path-')) throw new Error('临时夹具清理路径无效')
    await fs.rm(base, { recursive: true, force: true })
  }
})
it('A36 点点路径不能通过原子写入和不可变对象写到库外', async () => {
  const f = await fixture()
  for (const relative of ['../outside.sentinel', '..\\outside.sentinel', 'objects/../../outside.sentinel']) {
    await expect(atomicWrite(f.root, relative, '被覆盖')).rejects.toThrow('越出')
    await expect(immutableWrite(f.root, relative, Buffer.from('被覆盖'))).rejects.toThrow('越出')
  }
  expect(await fs.readFile(path.join(f.base, 'outside.sentinel'), 'utf8')).toBe('库外哨兵')
})
it('A37 绝对路径和盘符路径不能绕过库内路径边界', async () => {
  const f = await fixture()
  await expect(atomicWrite(f.root, path.join(f.base, 'outside.sentinel'), '被覆盖')).rejects.toThrow()
  await expect(atomicWrite(f.root, path.parse(f.root).root + 'outside.sentinel', '被覆盖')).rejects.toThrow()
  expect(await fs.readFile(path.join(f.base, 'outside.sentinel'), 'utf8')).toBe('库外哨兵')
})
it('A38 Windows 保留名被拒绝或限定在库内而不触及库外', async () => {
  const f = await fixture()
  for (const name of ['CON', 'NUL', 'COM1', 'LPT1', 'AUX']) {
    const relative = 'wiki/' + name + '.md'
    try { await atomicWrite(f.root, relative, '设备名路径反例') }
    catch (error) { expect(error).toBeInstanceOf(Error) }
  }
  expect(await fs.readFile(path.join(f.base, 'outside.sentinel'), 'utf8')).toBe('库外哨兵')
  expect((await fs.readdir(f.base)).sort()).toEqual(['.llmwiki', 'outside.sentinel'])
})
it('A39 超长来源路径只允许落在库内或明确拒绝', async () => {
  const f = await fixture(), relative = 'objects/' + '长目录/'.repeat(70) + 'source.md'
  let written = false
  try { await atomicWrite(f.root, relative, '长路径正文'); written = true }
  catch (error) { expect(error).toBeInstanceOf(Error) }
  if (written) {
    expect(within(f.root, await safePath(f.root, relative))).toBe(true)
    expect(await fs.readFile(path.join(f.root, relative), 'utf8')).toBe('长路径正文')
  }
  expect(await fs.readFile(path.join(f.base, 'outside.sentinel'), 'utf8')).toBe('库外哨兵')
})
it('A40 大小写重复来源根只扫描一个来源且输出不回灌', async () => {
  const f = await fixture()
  await fs.writeFile(path.join(f.base, 'Case.md'), '真实来源')
  await fs.writeFile(path.join(f.root, 'Output.md'), '不能回灌')
  const roots = process.platform === 'win32' ? [f.base, f.base.toUpperCase()] : [f.base, f.base]
  const result = await scanSourceFiles(roots, f.root)
  expect(result.errors).toEqual([]); expect(result.inputs).toHaveLength(1)
  expect(path.basename(result.inputs[0]!.actual).toLowerCase()).toBe('case.md')
})
