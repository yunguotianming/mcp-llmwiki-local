// 子进程运行真实源码；钩子只补齐项目的 .js → .ts 解析和 TypeScript 编译。
import { registerHooks, stripTypeScriptTypes, syncBuiltinESMExports } from 'node:module'
import filesystem from 'node:fs/promises'
import * as native from 'node:fs'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const [mode, root, version, compilationCache] = process.argv.slice(2)
// 与父进程夹具一致：保留真实字节、描述符、改名和 SQLite 锁，省去线程池排队与刷盘。
const fixtureRoot = path.resolve(root)
const inFixture = value => typeof value === 'string' && (value === fixtureRoot || value.startsWith(fixtureRoot + path.sep))
for (const name of ['readFile', 'writeFile', 'stat', 'lstat', 'readdir', 'mkdir', 'unlink', 'rename']) {
  const original = filesystem[name]
  filesystem[name] = async (...args) => inFixture(args[0]) && (name !== 'rename' || inFixture(args[1])) ? native[name + 'Sync'](...args) : original(...args)
}
const realpath = filesystem.realpath, open = filesystem.open
filesystem.realpath = async (file, options) => inFixture(file) && !options ? path.resolve(file) : realpath(file, options)
filesystem.open = async (file, flags, mode) => {
  if (!inFixture(file)) return open(file, flags, mode)
  const fd = native.openSync(file, flags, mode)
  return { fd, sync: async () => {}, close: async () => native.closeSync(fd),
    writeFile: async (value, options) => native.writeFileSync(fd, value, options),
    readFile: async options => native.readFileSync(fd, options), stat: async () => native.fstatSync(fd) }
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
    if (url.endsWith('.ts')) {
      const input = readFileSync(fileURLToPath(url), 'utf8')
      // 同一源码的转换字节在子进程间复用；仍执行真实模块、文件 IO 和跨进程锁。
      const cache = path.join(compilationCache, createHash('sha256').update(url).update(input).digest('hex') + '.mjs')
      let source
      if (existsSync(cache)) source = readFileSync(cache, 'utf8')
      else {
        source = stripTypeScriptTypes(input, { mode: 'transform', sourceUrl: url })
        writeFileSync(cache, source)
      }
      return { format: 'module', shortCircuit: true, source }
    }
    return next(url, context)
  },
})
try {
  if (mode === 'crash') {
    const unlink = filesystem.unlink
    filesystem.unlink = async file => {
      if (String(file).replaceAll('\\', '/').includes('/objects/snapshots/S-0001/') && String(file).endsWith('source.md')) process.exit(73)
      return unlink(file)
    }
    syncBuiltinESMExports()
    const { revokeSourcesAtRoot } = await import('../src/layered/revocations.ts')
    await revokeSourcesAtRoot(root, ['S-0001'], '撤回收录')
    throw new Error('崩溃注入没有命中')
  } else if (mode === 'pin') {
    const { pinVersion } = await import('../src/layered/retention.ts')
    const reader = await pinVersion(root, version)
    process.send({ type: 'ready', pid: process.pid })
    process.on('message', async message => {
      if (message === 'release') { await reader.release(); process.disconnect() }
    })
  } else {
    const { withLayeredRead } = await import('../src/layered/revocations.ts')
    const go = mode === 'read' ? new Promise(resolve => process.once('message', resolve)) : Promise.resolve()
    let ready = false
    const value = await withLayeredRead(root, async view => {
      if (!ready) { ready = true; process.send({ type: 'ready', pid: process.pid }) }
      await go
      return { document: await view.document('S-0001'), source: await view.source('S-0001') }
    }, version ? { version } : {})
    process.send({ type: 'result', value }); process.disconnect()
  }
} catch (error) {
  process.send({ type: 'error', error: String(error) }); process.disconnect(); process.exitCode = 1
}
