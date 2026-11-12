import { mkdtemp } from 'node:fs/promises'
import { promises, realpathSync, rmSync } from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import path from 'node:path'
import os from 'node:os'
import { afterAll } from 'vitest'
const roots = new Set<string>()
const originalRealpath = promises.realpath
// 保留真实链接解析和存在性校验，只省去测试目录反复解析时的线程池排队。
const fixtureRealpath = (async (file, options) => {
  if (typeof file === 'string' && options === undefined) {
    const target = path.resolve(file)
    if ([...roots].some(root => target === root || target.startsWith(root + path.sep))) return realpathSync.native(file)
  }
  return originalRealpath(file, options as never)
}) as typeof originalRealpath
afterAll(() => {
  promises.realpath = originalRealpath
  syncBuiltinESMExports()
})
export async function temporaryWorkspace() {
  const parent = path.resolve(os.tmpdir())
  const root = await mkdtemp(path.join(parent, 'wiki-unit-test-'))
  roots.add(root)
  if (promises.realpath !== fixtureRealpath) { promises.realpath = fixtureRealpath; syncBuiltinESMExports() }
  return { root, async cleanup() {
    const target = path.resolve(root)
    if (path.dirname(target) !== parent || !path.basename(target).startsWith('wiki-unit-test-')) throw new Error('临时测试目录边界校验失败。')
    // 小型夹具直接清理，避免默认并发下递归删除持续占用异步 IO 线程池。
    rmSync(target, { recursive: true, force: true })
    roots.delete(root)
  } }
}
