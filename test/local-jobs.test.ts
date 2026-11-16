import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { LocalConfigStore } from '../src/local/config.js'
import { LocalJobs } from '../src/local/jobs.js'
import { createLocalHost } from '../src/local/host.js'
import { temporaryWorkspace } from './temp.js'
import type { ModelRuntime } from '../src/llm/client.js'

it('运行中取消释放源协议锁与作业占用，再次扫描成功', async () => {
  const f = await temporaryWorkspace(), entered = Promise.withResolvers<void>()
  const config = new LocalConfigStore(path.join(f.root, 'home')); await config.load()
  const source = path.join(f.root, '资料'); await mkdir(source); await writeFile(path.join(source, 'a.md'), '待提取的样本资料。')
  const library = await config.add(source), old = config.registry(), next = structuredClone(old)
  next.libraries[0]!.layered = { embeddingMode: 'none' }; await config.writeRegistry(next, old)
  const runtime: ModelRuntime = { async resolveModelInfo(provider, id) { return { provider, id, name: id, context: { contextWindow: 32768 }, reasoning: { efforts: [{ id: 'high', name: '高' }] } } },
    async *stream(options) {
      entered.resolve()
      await new Promise<void>((resolve, reject) => {
        if (options.signal?.aborted) { reject(options.signal.reason); return }
        options.signal?.addEventListener('abort', () => reject(options.signal!.reason), { once: true })
      })
    } }
  const jobs = new LocalJobs(config, runtime)
  const host = createLocalHost(config.registry(), { runtime, running: jobs.running, persist: config.writeRegistry })
  try {
    const start = await jobs.generate({ libraryId: library.id }); await entered.promise
    const management = host.operations.libraries!.management, revision = management.view().registryRevision
    await expect(management.update(library.id, { wikiPath: path.join(f.root, '另一个库') }, revision)).rejects.toMatchObject({ code: 'LIBRARY_BUSY' })
    await expect(management.unregister(library.id, revision)).rejects.toMatchObject({ code: 'LIBRARY_BUSY' })
    expect(host.stop(library.id)).toEqual({ stopping: true })
    await expect(jobs.generate({ libraryId: library.id })).rejects.toThrow('正在被占用')
    expect((await jobs.cancel(start.jobId)).status).toBe('cancelling')
    await jobs.close()
    expect((await jobs.status(start.jobId)).status).toBe('cancelled')
    const scan = await jobs.generate({ libraryId: library.id, action: 'scan' })
    for (let i = 0; i < 200; i++) { const status = await jobs.status(scan.jobId); if (status.status !== 'running') { expect(status.status, status.error).toBe('completed'); break }; await new Promise(resolve => setTimeout(resolve, 10)); if (i === 199) throw new Error('扫描未完成') }
  } finally { host.dispose(); await jobs.close(); await f.cleanup() }
}, 15000)

it('服务重建后未持有的运行作业标记中断，保留回执可检查', async () => {
  const f = await temporaryWorkspace(), config = new LocalConfigStore(path.join(f.root, 'home')); await config.load()
  const source = path.join(f.root, '资料'); await mkdir(source); const library = await config.add(source)
  const id = randomUUID(); await mkdir(path.join(config.home, 'jobs'))
  await writeFile(path.join(config.home, 'jobs', id + '.json'), JSON.stringify({ jobId: id, libraryId: library.id, kind: 'generate', status: 'running', ownerPid: process.pid, startedAt: '', updatedAt: '' }))
  const runtime: ModelRuntime = { async resolveModelInfo(): Promise<never> { throw new Error('不应调用模型') }, async *stream() { throw new Error('不应调用模型') } }
  const jobs = new LocalJobs(config, runtime)
  try { const status = await jobs.status(id); expect(status.status).toBe('interrupted'); expect(status.message).toContain('检查点') }
  finally { await jobs.close(); await f.cleanup() }
})
