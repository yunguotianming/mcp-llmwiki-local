import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import type { ModelRuntime } from '../llm/client.js'
import { LibraryStore } from '../storage/libraries.js'
import { ChangeStore } from '../storage/changes.js'
import { safePath } from '../storage/paths.js'
import { readOptional } from '../storage/files.js'
import { readCurrent, readManifest, readVersion } from '../layered/objects.js'
import { readExtraction } from '../layered/publication.js'
import { withBuildLock } from '../layered/files.js'
import type { PendingBuild, CostReport } from '../layered/schema.js'
import { generateLocalLayered, scanLocalLayered } from './local-layered.js'
import { copyLibraryWithEmbedding } from './query-vectors.js'
import { redactSecrets } from './runtime.js'
import type { LocalConfigStore } from './config.js'
import type { CopyEmbeddingTarget } from '../layered/query-vectors.js'

export interface LocalJob {
  jobId: string; libraryId: string; kind: 'generate' | 'copy'; status: 'running' | 'preview' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'committed'
  startedAt: string; updatedAt: string; ownerPid: number; batchId?: string; result?: unknown; error?: string
}
export interface GenerateInput { libraryId: string; action?: 'generate' | 'scan' | undefined; legacyLibraryAction?: 'backup' | undefined; reextract?: 'all' | 'gaps' | string[] | undefined }
export function localError(error: unknown): string {
  const message = redactSecrets(error instanceof Error ? error.message : String(error))
  return /已有分层建库正在运行|已有处理任务|写入锁/.test(message) ? '数据库正在被占用：' + message : message
}

export class LocalJobs {
  private active = new Map<string, { abort: AbortController; done: Promise<void> }>()
  private reservations = new Set<string>()
  readonly store: LibraryStore
  readonly changes: ChangeStore
  constructor(private readonly config: LocalConfigStore, private readonly runtime: ModelRuntime) {
    this.store = new LibraryStore(config.registry); this.changes = new ChangeStore(this.store)
  }
  private jobPath(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('作业 ID 无效。')
    return path.join(this.config.home, 'jobs', id + '.json')
  }
  private async save(job: LocalJob) {
    await mkdir(path.join(this.config.home, 'jobs'), { recursive: true })
    job.updatedAt = new Date().toISOString()
    const target = this.jobPath(job.jobId), temporary = target + '.' + randomUUID() + '.tmp'
    await writeFile(temporary, JSON.stringify(job, null, 2) + '\n', { mode: 0o600 })
    await rename(temporary, target)
  }
  private async read(id: string): Promise<LocalJob> {
    try { return JSON.parse(await readFile(this.jobPath(id), 'utf8')) as LocalJob }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new Error('未找到作业：' + id); throw error }
  }
  private async start(libraryId: string, kind: LocalJob['kind'], action: (signal: AbortSignal) => Promise<unknown>) {
    const library = this.store.registration(libraryId)
    await this.store.root(libraryId, true)
    if (library.kind !== 'local') throw new Error('本地建库和复制目前要求 kind=local 的资料库。')
    const key = path.resolve(library.sourceRoots[0] ?? '').toLowerCase()
    if (!library.sourceRoots.length) throw new Error('数据库尚未配置资料目录。')
    if (this.reservations.has(key)) throw new Error('数据库正在被占用：本服务已有运行中的作业。')
    this.reservations.add(key)
    try {
      // 使用源库同一锁协议预检；核心执行时再次持锁，竞争窗口中的冲突也会记录为失败。
      await withBuildLock(library.sourceRoots[0]!, async () => {})
      const job: LocalJob = { jobId: randomUUID(), libraryId, kind, status: 'running', startedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), ownerPid: process.pid }
      await this.save(job)
      const abort = new AbortController()
      const done = new Promise<void>(resolve => setImmediate(resolve)).then(async () => {
        try {
          abort.signal.throwIfAborted()
          const result = await action(abort.signal) as { status?: string; batchId?: string }
          job.result = result
          if (result.batchId) job.batchId = result.batchId
          job.status = result.status === 'preview' ? 'preview' : 'completed'
        } catch (error) { job.status = abort.signal.aborted ? 'cancelled' : 'failed'; job.error = localError(error) }
        finally {
          try { await this.save(job) } finally { this.reservations.delete(key); this.active.delete(job.jobId) }
        }
      })
      this.active.set(job.jobId, { abort, done })
      // 落盘失败也不产生未处理拒绝；调用 status 会明确报告遗留运行态。
      void done.catch(error => console.error(localError(error)))
      return { jobId: job.jobId, libraryId, status: 'running', message: '作业已启动，请调用 wiki_status 轮询。' }
    } catch (error) { this.reservations.delete(key); throw new Error(localError(error)) }
  }
  generate(input: GenerateInput) {
    return this.start(input.libraryId, 'generate', signal => input.action === 'scan'
      ? scanLocalLayered(this.store, input.libraryId, signal)
      : generateLocalLayered(this.store, input.libraryId, this.runtime, signal, input.legacyLibraryAction, input.reextract))
  }
  copy(input: { libraryId: string; target: CopyEmbeddingTarget; confirm: true }) {
    return this.start(input.libraryId, 'copy', signal => copyLibraryWithEmbedding(this.store, input, signal, this.config.writeRegistry))
  }
  async status(id: string, includePreview = false) {
    let job = await this.read(id)
    if (job.status === 'running' && !this.active.has(id)) {
      // 读取期间作业可能刚刚落盘并退出内存表，先重读避免误判中断。
      job = await this.read(id)
      if (job.status === 'running') {
        let alive = false
        if (job.ownerPid !== process.pid) try { process.kill(job.ownerPid, 0); alive = true } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') alive = true }
        if (!alive) job.status = 'interrupted'
      }
    }
    const result = job.result as { version?: string; path?: string; modelCalls?: number; generation_calls?: number; generation_tokens?: number; vectors?: number } | undefined
    const root = job.kind === 'copy' && result?.path ? result.path : await this.store.root(job.libraryId)
    let pending: PendingBuild | undefined, costs: Record<string, CostReport> | undefined
    let manifest: Awaited<ReturnType<typeof readManifest>> | undefined
    let preview: Awaited<ReturnType<ChangeStore['preview']>> | undefined
    try {
      pending = await readOptional<PendingBuild>(await safePath(root, 'work/pending.json'))
        ?? await readOptional<PendingBuild>(await safePath(root, 'work/preview.json'))
      costs = await readOptional<Record<string, CostReport>>(await safePath(root, 'logs/costs.json'))
      if (result?.version) {
        if (pending?.version !== result.version) pending = undefined
        manifest = await readVersion(root, result.version)
      } else manifest = await readManifest(root, await readCurrent(root))
      if (job.batchId) { preview = await this.changes.preview(job.libraryId, job.batchId); job.status = preview.batch.status === 'committed' ? 'committed' : preview.batch.status === 'cancelled' ? 'cancelled' : job.status }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const view = pending?.manifest ?? manifest
    const extractionGaps: { stage: string; sourceId: string; details: unknown }[] = []
    if (view && job.status !== 'running') for (const source of view.sources) {
      const extraction = await readExtraction(root, source.extract.path)
      for (const gap of extraction.gaps ?? []) extractionGaps.push({ stage: 'extraction', sourceId: source.source_id, details: gap })
    }
    return { ...job, progress: { completedSources: view?.sources.length ?? 0, modelCalls: result?.modelCalls ?? result?.generation_calls ?? pending?.model_calls ?? null,
      phase: pending?.paused?.reason ?? job.status, message: pending?.paused?.message ?? '' },
      gaps: [...(view?.gaps ?? []), ...extractionGaps, ...(view?.topic_gaps ?? []), ...(view?.term_gaps ?? []), ...(view?.point_label_gaps ?? [])],
      costs: job.kind === 'copy' ? { generationCalls: result?.generation_calls ?? 0, generationTokens: result?.generation_tokens ?? 0, vectors: result?.vectors ?? null }
        : pending?.costs ?? (result?.version ? costs?.[result.version] : Object.values(costs ?? {}).at(-1)) ?? null,
      ...(preview ? { batchId: preview.batch.id, digest: preview.batch.digest, changedPages: preview.batch.pages.map(page => page.path),
        ...(includePreview ? { preview: preview.pages } : {}) } : {}),
      ...(job.status === 'interrupted' ? { message: '服务已重启；可再次 wiki_generate，核心会复用持久化检查点。' } : {}) }
  }
  async commit(id: string, digest: string, signal?: AbortSignal) {
    const job = await this.read(id)
    if (this.active.has(id) || !job.batchId) throw new Error('作业尚未形成可提交预览，请先调用 wiki_status。')
    const batch = await this.changes.commit(job.libraryId, job.batchId, digest, signal)
    job.status = 'committed'; await this.save(job)
    return { jobId: id, libraryId: job.libraryId, batchId: batch.id, status: batch.status }
  }
  async cancel(id: string) {
    const active = this.active.get(id)
    if (active) { active.abort.abort(new Error('用户取消作业。')); return { jobId: id, status: 'cancelling', message: '已发出取消信号，请轮询直到取消完成。' } }
    const job = await this.read(id)
    if (job.status === 'running' && job.ownerPid !== process.pid) {
      try { process.kill(job.ownerPid, 0); throw new Error('作业由另一个 MCP 进程运行，请在原服务取消。') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error }
    }
    if (job.batchId) { const { batch } = await this.changes.preview(job.libraryId, job.batchId); await this.changes.cancel(job.libraryId, batch.id, batch.digest) }
    else if (job.status === 'completed' || job.status === 'committed') throw new Error('已完成作业不能取消。')
    job.status = 'cancelled'; await this.save(job)
    return { jobId: id, status: job.status }
  }
  async close() {
    for (const { abort } of this.active.values()) abort.abort(new Error('MCP 服务关闭。'))
    await Promise.allSettled([...this.active.values()].map(task => task.done))
  }
}
