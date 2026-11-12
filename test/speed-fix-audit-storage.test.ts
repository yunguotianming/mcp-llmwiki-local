import { afterEach, expect, it } from 'vitest'
import { mkdtemp, mkdir, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fork } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setImmediate } from 'node:timers/promises'
import { withBuildLock, withRevocationLock, writeJson } from '../src/layered/files.js'

const roots: string[] = []
async function fixture() { const root = await mkdtemp(path.join(tmpdir(), 'speed-fix-audit-')); roots.push(root); return root }
afterEach(async () => {
  for (const root of roots.splice(0)) {
    const target = path.resolve(root)
    if (path.dirname(target) !== path.resolve(tmpdir()) || !path.basename(target).startsWith('speed-fix-audit-')) throw new Error('审查夹具清理越界')
    await rm(target, { recursive: true, force: true })
  }
})

it('A33 真实30路状态与检查点写入期间持续读JSON，无丢更新和半截文件', async ({ onTestFinished }) => {
  const root = await mkdtemp(path.join(tmpdir(), 'speed-fix-audit-'))
  onTestFinished(() => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }), 60_000)
  // 每轮重新置空后施加相同的 30 路竞争，持续读窗口不缩短。
  for (let round = 0; round < 3; round++) {
  const state = { values: [] as number[] }
  await writeJson(root, 'state/audit.json', state); await writeJson(root, 'work/pending.json', state)
  let done = false, reads = 0
  const readUntil = Date.now() + 120
  const reader = (async () => {
    while (!done && Date.now() < readUntil) {
      for (const file of ['state/audit.json', 'work/pending.json']) {
        const value = JSON.parse(await readFile(path.join(root, file), 'utf8'))
        expect(new Set(value.values).size).toBe(value.values.length); reads++
      }
      await setImmediate()
    }
  })()
  let outcomes: PromiseSettledResult<unknown>[] = []
  try {
    outcomes = await Promise.allSettled(Array.from({ length: 30 }, async (_, i) => {
      for (let n = 0; n < i % 4; n++) await setImmediate()
      state.values.push(i)
      const writes = await Promise.allSettled([writeJson(root, 'state/audit.json', state), writeJson(root, 'work/pending.json', state)])
      const rejected = writes.find(r => r.status === 'rejected')
      if (rejected?.status === 'rejected') throw rejected.reason
    }))
  } finally { done = true; await reader }
  expect(outcomes.filter(r => r.status === 'rejected')).toEqual([])
  for (const file of ['state/audit.json', 'work/pending.json']) expect(JSON.parse(await readFile(path.join(root, file), 'utf8')).values.sort((a: number, b: number) => a - b)).toEqual(Array.from({ length: 30 }, (_, i) => i))
  expect(reads).toBeGreaterThan(0)
  expect((await readdir(root, { recursive: true })).filter(file => file.endsWith('.tmp'))).toEqual([])
  }
}, 60_000)

it('A34 真实第二进程被写者锁拒绝，释放后可重新获得锁', async () => {
  const root = await fixture(), cache = path.join(root, 'compile'); await mkdir(cache)
  // 复用现有通用跨进程存储夹具；转换缓存限于本用例新建目录。
  const child = fork(fileURLToPath(new URL('./layered-storage-audit-worker.mjs', import.meta.url)), [cache], { execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const ready = new Promise<void>((resolve, reject) => { child.once('message', () => resolve()); child.once('error', reject) })
  const request = () => new Promise<any>((resolve, reject) => { child.once('message', resolve); child.once('error', reject); child.send({ id: 1, action: 'lock', root }) })
  try {
    await ready
    await withBuildLock(root, async () => { expect((await request()).error).toContain('已有分层建库正在运行') })
    expect((await request()).error).toBeUndefined()
  } finally { const exit = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exit }
})

it('排队检查点合并后全部调用等待最新完整快照实际落盘', async () => {
  const root = await fixture(), state = { values: [] as number[] }
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const held = withRevocationLock(root, async () => { entered.resolve(); await release.promise })
  await entered.promise
  let finished = 0
  const writes = Array.from({ length: 3 }, (_, i) => {
    state.values.push(i)
    return writeJson(root, 'work/pending.json', state).then(() => { finished++ })
  })
  expect(finished).toBe(0)
  release.resolve()
  await Promise.all([held, ...writes])
  expect(finished).toBe(3)
  expect(JSON.parse(await readFile(path.join(root, 'work/pending.json'), 'utf8'))).toEqual(state)
  expect((await readdir(root, { recursive: true })).filter(file => file.endsWith('.tmp'))).toEqual([])
})
