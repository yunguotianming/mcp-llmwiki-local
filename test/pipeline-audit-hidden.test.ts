import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { cleanupLayeredFixtures, layeredFixture, mockFixtureSync } from './layered-fixture.js'

const injected = vi.hoisted(() => ({ fail: false, calls: 0 }))
vi.mock('node:child_process', async original => {
  const real = await original<typeof import('node:child_process')>()
  const wrapped = (...args: any[]) => {
    if (args[0] === 'attrib.exe') {
      injected.calls++
      if (injected.fail) { args.at(-1)(Object.assign(new Error('清除Hidden被拒绝'), { code: 'EACCES' }), '', ''); return {} }
    }
    return Reflect.apply(real.execFile, undefined, args)
  }
  Object.defineProperty(wrapped, Symbol.for('nodejs.util.promisify.custom'), { value: (...args: any[]) => new Promise((resolve, reject) => {
    wrapped(...args, (error: unknown, stdout: string, stderr: string) => error ? reject(error) : resolve({ stdout, stderr }))
  }) })
  return { ...real, execFile: wrapped }
})
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
const platform = process.platform
afterEach(() => { injected.fail = false; injected.calls = 0; Object.defineProperty(process, 'platform', { value: platform }); cleanupLayeredFixtures() })
async function attributes(root: string) {
  const { stdout } = await promisify(execFile)('attrib.exe', [root], { windowsHide: true })
  return stdout.match(/^([A-Z ]+)(?:[A-Za-z]:\\|\\\\)/)?.[1]
}

it('H01 Windows新建库无Hidden，已有Hidden再次建库清除', async () => {
  const f = await layeredFixture()
  mockFixtureSync(f.knowledgeRoot, true)
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '正文证据。')
  await buildLayeredLibrary(f.options)
  if (platform === 'win32') {
    expect(await attributes(f.root)).not.toContain('H')
    await promisify(execFile)('attrib.exe', ['+H', f.root], { windowsHide: true })
    expect(await attributes(f.root)).toContain('H')
    await buildLayeredLibrary(f.options)
    expect(await attributes(f.root)).not.toContain('H')
  }
})

it('H02 分层建库清除Hidden权限失败仍完成并记日志', async () => {
  const f = await layeredFixture()
  mockFixtureSync(f.knowledgeRoot, true)
  Object.defineProperty(process, 'platform', { value: 'win32' }); injected.fail = true
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '正文证据。')
  await expect(buildLayeredLibrary(f.options)).resolves.toHaveProperty('version')
  const files = await readdir(path.join(f.root, 'logs'))
  const logs = await Promise.all(files.map(file => readFile(path.join(f.root, 'logs', file), 'utf8')))
  expect(logs.join('\n')).toMatch(/Hidden|隐藏|EACCES/)
})

it('H03 库登记初始化清除Hidden权限失败仍可完成', async () => {
  const f = await layeredFixture(), registry = emptyRegistry(), library = newLibrary('pipeline-audit')
  mockFixtureSync(f.knowledgeRoot, true)
  library.wikiPath = f.root; registry.libraries.push(library)
  Object.defineProperty(process, 'platform', { value: 'win32' }); injected.fail = true
  await expect(new LibraryStore(() => registry).initialize(library.id)).resolves.toMatchObject({ initialized: true })
})

it('H04 非Windows建库不调用attrib且不中止', async () => {
  const f = await layeredFixture()
  mockFixtureSync(f.knowledgeRoot, true)
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '正文证据。')
  Object.defineProperty(process, 'platform', { value: 'linux' }); injected.fail = true
  await expect(buildLayeredLibrary(f.options)).resolves.toHaveProperty('version')
  expect(injected.calls).toBe(0)
})
