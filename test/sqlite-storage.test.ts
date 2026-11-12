import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { readGenerateJobs, readGenerateJobSummaries, writeGenerateJob, restoreFileJobStorage } from '../src/storage/jobs.js'
import { writeState } from '../src/storage/files.js'
import { scanLibrary } from '../src/ingest/scanner.js'
import { generateWiki } from '../src/wiki/generation.js'
import type { GenerateJob } from '../src/wiki/generation.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { temporaryWorkspace } from './temp.js'

async function fixture() {
  const temp = await temporaryWorkspace(), library = newLibrary('sqlite-test')
  library.wikiPath = path.join(temp.root, 'wiki'); library.sourceRoots = [path.join(temp.root, 'source')]
  library.models.unified = { provider: 'fake', model: 'test' }
  await mkdir(library.sourceRoots[0]!); await writeFile(path.join(library.sourceRoots[0]!, 'a.md'), '青松流程先登记资料，再进行复核。')
  const registry = emptyRegistry(); registry.libraries = [library]
  const store = new LibraryStore(() => registry); await store.initialize(library.id)
  const job: GenerateJob = { kind: 'generate', id: randomUUID(), libraryId: library.id, fingerprint: '验证指纹', createdAt: '2026-11-06', updatedAt: '2026-11-06', status: 'cancelled', chunks: [], attempts: [], synthesis: [{ key: '旧检查点', output: '完整证据'.repeat(10000) }], pendingImages: 0 }
  return { ...temp, store, library, job }
}
describe('SQLite细粒度作业存储', () => {
  it('导入保留原文件与全部证据，后续只更新新增行', async () => {
    const f = await fixture()
    try {
      await writeState(f.library.wikiPath, `.llmwiki/jobs/${f.job.id}.json`, f.job)
      const before = await readFile(path.join(f.library.wikiPath, '.llmwiki/jobs', f.job.id + '.json'), 'utf8')
      expect(await f.store.migrateStorage(f.library.id)).toMatchObject({ jobs: 1, checkpoints: 1, imported: true })
      expect(await readGenerateJobs(f.library.wikiPath)).toEqual([f.job])
      expect((await readGenerateJobSummaries(f.library.wikiPath))[0]).toMatchObject({id:f.job.id,status:f.job.status,chunks:[],attempts:[]})
      f.job.synthesis!.push({ key: '新检查点', output: '新证据' }); f.job.sourcesCompleted = 1
      const written = await writeGenerateJob(f.library.wikiPath, f.job)
      expect(written.rows).toBe(2); expect(written.bytes).toBeLessThan(1000)
      expect(await readGenerateJobs(f.library.wikiPath)).toEqual([f.job])
      expect(await readFile(path.join(f.library.wikiPath, '.llmwiki/jobs', f.job.id + '.json'), 'utf8')).toBe(before)
      expect((await f.store.migrateStorage(f.library.id)).imported).toBe(false)
      await restoreFileJobStorage(f.library.wikiPath,f.library.id)
      expect(await readGenerateJobs(f.library.wikiPath)).toEqual([f.job])
    } finally { await f.cleanup() }
  }, 30000)
  it('运行中拒绝迁移且不创建切换标记', async () => {
    const f = await fixture()
    try {
      f.job.status = 'running'; await writeState(f.library.wikiPath, `.llmwiki/jobs/${f.job.id}.json`, f.job)
      await expect(f.store.migrateStorage(f.library.id)).rejects.toThrow('运行中')
      await expect(readFile(path.join(f.library.wikiPath, '.llmwiki/storage.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await f.cleanup() }
  })
  it('事务约束失败保留前次检查点及作业状态', async () => {
    const f = await fixture()
    try {
      await writeState(f.library.wikiPath, `.llmwiki/jobs/${f.job.id}.json`, f.job); await f.store.migrateStorage(f.library.id)
      const before = await readGenerateJobs(f.library.wikiPath)
      f.job.status = 'failed'; f.job.synthesis!.push({ key: '旧检查点', output: '重复身份' })
      await expect(writeGenerateJob(f.library.wikiPath, f.job)).rejects.toMatchObject({message:expect.stringContaining('UNIQUE'),ioDiagnostic:{operation:'save',writerPid:process.pid,file:path.join(f.library.wikiPath,'.llmwiki','wiki.sqlite')}})
      expect(await readGenerateJobs(f.library.wikiPath)).toEqual(before)
    } finally { await f.cleanup() }
  }, 30000)
  it('SQLite生成可恢复取消任务，运行状态同样阻止重扫', async () => {
    const f = await fixture(), controller = new AbortController()
    try {
      await scanLibrary(f.store, f.library.id); await f.store.migrateStorage(f.library.id)
      let entered!: () => void
      const started = new Promise<void>(resolve => { entered = resolve })
      const hanging: ModelRuntime = { async resolveModelInfo(provider, id) { return { provider, id, name: id } }, async *stream(options) {
        entered(); await new Promise<void>(resolve => options.signal!.addEventListener('abort', () => resolve(), { once: true })); yield { type: 'finish', reason: { kind: 'stop' } }
      } }
      const running = generateWiki(f.store, f.library.id, hanging, controller.signal).catch(error => error)
      await started
      await expect(scanLibrary(f.store, f.library.id)).rejects.toThrow('运行中')
      controller.abort(new Error('用户取消')); await running
      const cancelled = (await readGenerateJobs(f.library.wikiPath))[0]!
      expect(cancelled.status).toBe('cancelled')
      const runtime: ModelRuntime = { ...hanging, async *stream(options) {
        const input = JSON.parse((options.messages[0]!.content[0] as { text: string }).text)
        const output = input.candidates ? { groups: input.candidates.map((item: { id: string; type: string; title: string; identity: string }) => ({ ...item, members: [item.id], conflicts: [], aliases: [], tags: [], claims: undefined, id: undefined })) }
          : { candidates: [{ type: 'concept', title: '资料复核流程', identity: '青松资料复核流程', aliases: [], tags: [], mentionOnly: false, claims: [{ text: input.text, quote: input.text }] }], images: [] }
        yield { type: 'text-delta', index: 0, text: JSON.stringify(output) }; yield { type: 'finish', reason: { kind: 'stop' } }
      } }
      const resumed = await generateWiki(f.store, f.library.id, runtime, new AbortController().signal, cancelled.id)
      expect(resumed.status).toBe('preview'); expect(resumed.chunks.filter(chunk => chunk.status === 'complete')).toHaveLength(1)
    } finally { controller.abort(); await f.cleanup() }
  }, 30000)
  it('只读登记拒绝迁移，新建中文默认不会改写已有语言', async () => {
    const f = await fixture()
    try {
      const view = await f.store.policy(f.library.id); expect(view.policy.wikiLanguage).toBe('zh-CN')
      await f.store.savePolicy(f.library.id, { ...view.policy, wikiLanguage: 'en' }, view.revision)
      expect((await f.store.policy(f.library.id)).policy.wikiLanguage).toBe('en')
      f.library.mode = 'readonly'
      await expect(f.store.migrateStorage(f.library.id)).rejects.toThrow('只读')
    } finally { await f.cleanup() }
  })
})
