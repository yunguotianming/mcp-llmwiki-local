// 仅供反例测试：复用源码转换缓存，以真实独立进程运行存储操作。
import { registerHooks, stripTypeScriptTypes, syncBuiltinESMExports } from 'node:module'
import filesystem from 'node:fs/promises'
import * as native from 'node:fs'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const [cache] = process.argv.slice(2)
const fixtureRoots = new Set()
// 只对收到的独立夹具路径同步执行真实 IO，避免全量并发时线程池排队。
// 路径解析、原子替换、SQLite 跨进程锁均仍使用真实实现。
const inFixture = value => typeof value === 'string' && [...fixtureRoots].some(root => value === root || value.startsWith(root + path.sep))
for (const name of ['readFile', 'writeFile', 'stat', 'lstat', 'readdir', 'mkdir', 'unlink', 'rename']) {
  const original = filesystem[name]
  filesystem[name] = async (...args) => {
    if (inFixture(args[0]) && (name !== 'rename' || inFixture(args[1]))) return native[name + 'Sync'](...args)
    return original(...args)
  }
}
// 夹具只包含普通文件；与父进程一致地省去重复 realpath，路径专项仍使用真实解析。
const realpath = filesystem.realpath
filesystem.realpath = async (file, options) => inFixture(file) && !options ? path.resolve(file) : realpath(file, options)
const open = filesystem.open
filesystem.open = async (file, flags, mode) => {
  if (!inFixture(file)) return open(file, flags, mode)
  const fd = native.openSync(file, flags, mode)
  // 与父进程已有流程夹具保持一致：真实描述符和写入，省去刷盘；不据此证明断电持久性。
  return { fd, sync: async () => {}, close: async () => native.closeSync(fd),
    writeFile: async (value, options) => native.writeFileSync(fd, value, options),
    readFile: async options => native.readFileSync(fd, options), stat: async () => native.fstatSync(fd),
  }
}
syncBuiltinESMExports()
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL) {
      const url = new URL(specifier.slice(0, -3) + '.ts', context.parentURL)
      if (existsSync(url)) return { url: url.href, shortCircuit: true }
    }
    return next(specifier, context)
  },
  load(url, context, next) {
    if (!url.endsWith('.ts')) return next(url, context)
    const input = readFileSync(fileURLToPath(url), 'utf8')
    const file = path.join(cache, createHash('sha256').update(url).update(input).digest('hex') + '.mjs')
    let source
    if (existsSync(file)) source = readFileSync(file, 'utf8')
    else {
      source = stripTypeScriptTypes(input, { mode: 'transform', sourceUrl: url })
      const temporary = file + '.' + process.pid + '.tmp'
      writeFileSync(temporary, source)
      try { renameSync(temporary, file) }
      catch (error) {
        // 两个 worker 可能同时编译同一源码；接受另一进程已经完整写出的相同缓存。
        if (!['EPERM', 'EACCES', 'EEXIST'].includes(error.code) || !existsSync(file) || readFileSync(file, 'utf8') !== source) throw error
      } finally { if (existsSync(temporary)) native.unlinkSync(temporary) }
    }
    return { format: 'module', shortCircuit: true, source }
  },
})
const { withBuildLock } = await import('../src/layered/files.ts')
let reader
let reading, resume
let building, releaseBuild
process.on('message', async ({ id, action, root, version }) => {
  try {
    fixtureRoots.add(path.resolve(root))
    // 写锁专项只加载存储锁；读者与回收用例首次请求时再加载对应模块。
    const { pinVersion, collectGarbage } = ['pin', 'gc'].includes(action) ? await import('../src/layered/retention.ts') : {}
    const { withLayeredRead } = ['read', 'hold-read'].includes(action) ? await import('../src/layered/revocations.ts') : {}
    let value
    if (action === 'pin') { reader = await pinVersion(root, version); value = { pid: process.pid, version: reader.manifest.version } }
    if (action === 'release') { await reader?.release(); reader = undefined }
    if (action === 'gc') await collectGarbage(root, 0)
    if (action === 'read') value = await withLayeredRead(root, async view => ({ document: await view.document('S-0001'), source: await view.source('S-0001') }), version ? { version } : {})
    if (action === 'hold-read') {
      let started
      const ready = new Promise(resolve => { started = resolve })
      const gate = new Promise(resolve => { resume = resolve })
      reading = withLayeredRead(root, async view => {
        started(); await gate
        return { document: await view.document('S-0001'), source: await view.source('S-0001') }
      }, { version })
      await ready; value = { pid: process.pid }
    }
    if (action === 'finish-read') { resume(); value = await reading }
    if (action === 'lock') await withBuildLock(root, async () => {})
    if (action === 'hold-lock') {
      let entered
      const ready = new Promise(resolve => { entered = resolve })
      const gate = new Promise(resolve => { releaseBuild = resolve })
      building = withBuildLock(root, async () => { entered(); await gate })
      await Promise.race([ready, building]); value = { pid: process.pid }
    }
    if (action === 'release-lock') { releaseBuild(); await building }
    process.send({ id, value })
  } catch (error) { process.send({ id, error: String(error) }) }
})
process.send({ ready: true })
