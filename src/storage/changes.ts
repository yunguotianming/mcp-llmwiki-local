import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, readdir, rm, stat, unlink } from 'node:fs/promises'
import path from 'node:path'
import type { LibraryStore } from './libraries.js'
import { readOptional, saveObject, signature, writeState } from './files.js'
import { actualPath, safePath, validateRoots, within } from './paths.js'
import { withLibraryLock } from './lock.js'
import { readCurrent, readPageObject, readVersion } from '../layered/objects.js'
import { activatePublication, finishPublication, validatePublication } from '../layered/publication.js'
import { collectGarbage, validateCompleteVersion, withInventoryLock } from '../layered/retention.js'
import { advanceStorageGeneration, withBuildLock, withStorageGeneration } from '../layered/files.js'
import { hydrateVectors } from '../layered/vectors.js'
import type { PendingBuild } from '../layered/schema.js'
import { readRevocations, revokeSourcesAtRoot } from '../layered/revocations.js'
import { refreshReadingCopy } from '../layered/reading-copy.js'
import { scanSourceFiles } from '../ingest/scanner.js'

type Area='state'|'schema-backup'
export interface PageChange { path: string; before: string | null; after: string | null; area?: Area }
export interface Dependency { path: string; hash: string | null; source?: true; directory?: true }
export interface ChangeSet {
  version: 1; id: string; libraryId: string; registrationKey: string; policyRevision: string; generation: number
  createdAt: string; reason: string; digest: string; pages: PageChange[]; dependencies: Dependency[]
  status: 'preview' | 'committing' | 'committed' | 'recovery' | 'rolled-back' | 'cancelled'
  written: string[]; error?: string; message?: string
  layered?: { version: string; baseVersion: string | null; deletedSources?: string[]; backupPath?: string }
}
export interface PageProposal { path: string; content: string | null; expectedBefore: string | null; area?: Area }
export interface PageWriter {
  // 实现必须在实际写入边界复核 before；Obsidian 端使用 vault.process 的 current。
  write(root: string, page: PageChange, bytes: Buffer | null): Promise<void>
}
async function bytesAt(root: string, relative: string): Promise<Buffer | null> {
  try { return await readFile(await safePath(root, relative)) }
  catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error }
}
const hashOf = (bytes: Buffer | null) => bytes === null ? null : signature(bytes)
function pagePath(relative: string, area?: Area): string {
  const normalized = relative.replaceAll('\\', '/')
  if (normalized.split('/').some(part => !part || part === '.' || part === '..') || normalized.includes(':')) throw new Error('变更目标路径无效。')
  if (area === 'state') {
    if (!['.llmwiki/sources/catalog.json','.llmwiki/knowledge/catalog.json'].includes(normalized)) throw new Error('该机器状态不允许通过内容批次变更。')
  } else if(area==='schema-backup'){
    if(!/^schema\/config\.md\.bak\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/.test(normalized))throw new Error('Schema 备份路径无效。')
  } else if (/^(?:\.llmwiki|state)\//i.test(normalized) || !/\.md$/i.test(normalized)) throw new Error('变更目标必须是库内 Markdown 页面，不能写入状态区。')
  return normalized
}
function digest(batch: ChangeSet): string {
  return signature(JSON.stringify([batch.version, batch.id, batch.libraryId, batch.registrationKey, batch.policyRevision,
    batch.generation, batch.reason, batch.pages, batch.dependencies, ...(batch.layered ? [batch.layered] : [])]))
}
async function generation(root: string): Promise<number> {
  return (await readOptional<{ value: number }>(await safePath(root, '.llmwiki/coordination/generation.json')))?.value ?? 0
}
async function getBatch(root: string, id: string): Promise<ChangeSet> {
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('批次身份无效。')
  const batch = await readOptional<ChangeSet>(await safePath(root, `.llmwiki/changes/${id}.json`))
  if (!batch || batch.digest !== digest(batch)) throw new Error('批次不存在或内容签名不匹配。')
  return batch
}
async function objectBytes(root: string, hash: string | null): Promise<Buffer | null> {
  if (hash === null) return null
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('对象签名无效。')
  const bytes = await readFile(await safePath(root, '.llmwiki/objects/' + hash))
  if (signature(bytes) !== hash) throw new Error('批次内容对象已损坏。')
  return bytes
}
async function saveBatch(root: string, batch: ChangeSet): Promise<void> { await writeState(root, `.llmwiki/changes/${batch.id}.json`, batch) }
async function checkDependencies(root: string, batch: ChangeSet, sourceRoots: string[]): Promise<void> {
  const sources = await Promise.all(sourceRoots.map(actualPath))
  for (const dependency of batch.dependencies) {
    let bytes: Buffer | null
    if (dependency.directory) {
      if (dependency.source || await directoryRevision(root, dependency.path) !== dependency.hash) throw new Error('生成依据目录已变化，请重新生成预览。')
      continue
    }
    if (dependency.source) {
      const file = await actualPath(dependency.path)
      if (!sources.some(source => within(source,file)) || within(root,file)) throw new Error('来源范围已变化。')
      try { bytes = await readFile(file) }
      catch(error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') bytes = null; else throw error }
    } else { bytes = await bytesAt(root, dependency.path) }
    if (hashOf(bytes) !== dependency.hash) throw new Error('生成依据已变化，请重新生成预览。')
  }
}

async function checkLayeredInputs(root: string, batch: ChangeSet, sourceRoots: string[], signal?: AbortSignal): Promise<void> {
  const revoked = await readRevocations(root)
  if (revoked.generation !== batch.generation) throw new Error('来源撤权状态已变化，请取消后重新生成预览。')
  const scanned = await scanSourceFiles(sourceRoots, root, signal)
  const key = (file: string) => process.platform === 'win32' ? file.toLowerCase() : file
  const excluded = new Set(revoked.sources.filter(source => !source.deleted).flatMap(source => [source.current_path, ...(source.alias_paths ?? [])].map(file => key(path.resolve(path.dirname(root), file)))))
  const actual = scanned.inputs.filter(input => /\.(md|markdown)$/i.test(input.actual) && !excluded.has(key(input.actual))).map(input => key(input.actual)).sort()
  const expected = batch.dependencies.filter(input => input.source).map(input => key(input.path)).sort()
  if (scanned.errors.length || JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error('资料来源集合已变化或无法读取，请取消后重新生成预览。')
  await checkDependencies(root, batch, sourceRoots)
}

export async function directoryRevision(root: string, relative: string): Promise<string | null> {
  try {
    const entries = await readdir(await safePath(root, relative), { withFileTypes: true })
    return signature(JSON.stringify(entries.map(entry => [entry.name, entry.isSymbolicLink() ? 'link' : entry.isDirectory() ? 'directory' : 'file']).sort((a, b) => a[0]!.localeCompare(b[0]!))))
  } catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error }
}

// 仅与遵守同一锁协议的写入方互斥；人工编辑和第三方写入另做签名检查。
export const nativePageWriter: PageWriter = {
  async write(root, page, bytes) {
    const file = await safePath(root, page.path)
    await mkdir(path.dirname(file), { recursive: true })
    if (page.before === null) {
      if (bytes === null) throw new Error('不能删除不存在的页面。')
      const handle = await open(file, 'wx')
      try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    } else {
      const handle = await open(file, 'r+')
      try {
        if (signature(await handle.readFile()) !== page.before) throw new Error('页面在写入前已变化：' + page.path)
        const [held, current] = await Promise.all([handle.stat(), stat(file)])
        if (held.ino !== current.ino || held.dev !== current.dev) throw new Error('页面文件已被替换：' + page.path)
        if (bytes !== null) {
          let offset = 0
          while (offset < bytes.length) { const { bytesWritten } = await handle.write(bytes, offset, bytes.length - offset, offset); if (!bytesWritten) throw new Error('页面写入未推进。'); offset += bytesWritten }
          await handle.truncate(bytes.length); await handle.sync()
        }
      } finally { await handle.close() }
      if (bytes === null) {
        if (hashOf(await bytesAt(root, page.path)) !== page.before) throw new Error('页面在删除前已变化：' + page.path)
        await unlink(file)
      }
    }
    if (hashOf(await bytesAt(root, page.path)) !== page.after) throw new Error('写后核验失败，停止后续提交：' + page.path)
  },
}

export class ChangeStore {
  constructor(private readonly libraries: LibraryStore, private readonly writer: PageWriter = nativePageWriter) {}
  async prepareLayered(libraryId: string, version: string, registrationKey: string, policyRevision: string): Promise<ChangeSet> {
    const root = await this.libraries.root(libraryId, true)
    return withBuildLock(path.dirname(root), async () => {
      const pending = await readOptional<PendingBuild>(await safePath(root, 'work/pending.json'))
      if (pending?.version !== version) throw new Error('分层预览作业已变化。')
      // 续做身份不含模型；提交预览仍锁定生成完成时的完整登记与策略修订。
      const existing = (await this.list(libraryId)).find(batch => batch.layered?.version === version && batch.status === 'preview')
      if (existing) return existing
      const next = await readVersion(root, version), before = pending.base_version ? await readVersion(root, pending.base_version) : undefined
      const backup = await readOptional<{ backupPath: string }>(await safePath(root, 'state/legacy-backup.json'))
      const pages = [...new Set([...Object.keys(before?.pages ?? {}), ...Object.keys(next.pages!)])].sort()
        .filter(page => before?.pages?.[page] !== next.pages![page])
        .map(page => ({ path: page, before: before?.pages?.[page] ?? null, after: next.pages![page] ?? null }))
      const batch: ChangeSet = { version: 1, id: randomUUID(), libraryId, registrationKey, policyRevision, generation: next.revocation_generation,
        createdAt: new Date().toISOString(), reason: '资料提取与跨文档综合', digest: '', pages,
        dependencies: next.sources.flatMap(source => [source.current_path, ...(source.alias_paths ?? [])].map(file => ({ path: path.resolve(path.dirname(root), file), hash: source.content_hash.replace(/^sha256:/, ''), source: true as const }))), status: 'preview', written: [],
        ...(backup ? { message: `旧库已备份到 ${backup.backupPath}。取消预览不会自动恢复；如需手动恢复，请先停止生成，将新库 ${root} 移走，再把备份目录改回原名 .llmwiki。` } : {}),
        layered: { version, baseVersion: pending.base_version, ...(backup ?? {}), ...(pending.deleted_sources?.length ? { deletedSources: pending.deleted_sources } : {}) } }
      batch.digest = digest(batch)
      await saveBatch(root, batch)
      return batch
    })
  }
  private async applyLayered(libraryId: string, id: string, approvedDigest: string, cancel: boolean, signal?: AbortSignal): Promise<ChangeSet> {
    const root = await this.libraries.root(libraryId, true)
    return withBuildLock(path.dirname(root), () => withLibraryLock(root, 'layered-preview', () => withStorageGeneration(root, async () => {
      signal?.throwIfAborted()
      const batch = await getBatch(root, id)
      if (!batch.layered || batch.libraryId !== libraryId || batch.digest !== approvedDigest) throw new Error('确认与批次不匹配。')
      if (batch.status === (cancel ? 'cancelled' : 'committed')) return batch
      if (batch.status !== 'preview') throw new Error('批次当前不能提交或取消。')
      const current = await readCurrent(root)
      const pending = await hydrateVectors(root, await readOptional<PendingBuild>(await safePath(root, 'work/pending.json')))
      if (cancel) {
        if (current?.version === batch.layered.version) throw new Error('该版本已激活，请继续提交以完成阅读目录刷新。')
        if (pending && pending.version !== batch.layered.version) throw new Error('分层作业已变化，不能取消其他作业。')
        // 只移除本次未激活版本；已发布版本、读者与其他固定对象继续由 GC 保留。
        await withInventoryLock(root, async () => {
          for (const relative of [`versions/${batch.layered!.version}.json`, 'work/pending.json', 'work/preview.json'])
            await unlink(await safePath(root, relative)).catch(error => { if (error.code !== 'ENOENT') throw error })
          await rm(await safePath(root, 'work/extractions'), { recursive: true, force: true })
        })
        await collectGarbage(root)
        batch.status = 'cancelled'
      } else {
        if (current?.version === batch.layered.version) {
          if (pending) await finishPublication(root, pending)
        } else {
          const library = this.libraries.registration(libraryId, batch.registrationKey)
          if ((await this.libraries.policy(libraryId)).revision !== batch.policyRevision) throw new Error('配置已变化，请取消后重新生成预览。')
          await checkLayeredInputs(root, batch, library.sourceRoots, signal)
          if (!pending || pending.version !== batch.layered.version || (current?.version ?? null) !== batch.layered.baseVersion) throw new Error('分层预览基线已变化，请取消后重新生成预览。')
          await validatePublication(root, batch.layered.version)
          await validateCompleteVersion(root, await readVersion(root, batch.layered.version))
          this.libraries.registration(libraryId, batch.registrationKey)
          if ((await this.libraries.policy(libraryId)).revision !== batch.policyRevision) throw new Error('配置已变化，请取消后重新生成预览。')
          await checkLayeredInputs(root, batch, library.sourceRoots, signal)
          await activatePublication(root, pending, signal)
        }
        await unlink(await safePath(root, 'work/preview.json')).catch(error => { if (error.code !== 'ENOENT') throw error })
        if (batch.layered.deletedSources?.length) {
          const revoked = await revokeSourcesAtRoot(root, batch.layered.deletedSources, '本地来源删除预览已确认提交', true)
          advanceStorageGeneration(root, revoked.generation)
          await refreshReadingCopy(root, await readVersion(root, batch.layered.version))
        }
        batch.status = 'committed'
      }
      await saveBatch(root, batch)
      return batch
    })))
  }
  private async reconcileLayered(libraryId: string, root: string, batch: ChangeSet): Promise<ChangeSet> {
    // 指针替换是提交边界；重启后完成已激活批次的收尾，再展示其状态。
    if (batch.status === 'preview' && batch.layered && batch.layered.version === (await readCurrent(root))?.version)
      return this.applyLayered(libraryId, batch.id, batch.digest, false)
    return batch
  }
  async prepare(libraryId: string, reason: string, proposals: PageProposal[], dependencies: Dependency[] = [], signal?: AbortSignal): Promise<ChangeSet> {
    signal?.throwIfAborted()
    if (!proposals.length) throw new Error('变更批次不能为空。')
    const library = this.libraries.registration(libraryId), root = await this.libraries.root(libraryId, true)
    await validateRoots(root, library.sourceRoots)
    const policy = await this.libraries.policy(libraryId)
    if (!policy.initialized) throw new Error('请先初始化随库状态。')
    return await withLibraryLock(root, 'prepare', async () => {
      signal?.throwIfAborted()
      this.libraries.assertUnchanged(library)
      await this.libraries.root(libraryId, true)
      const batch: ChangeSet = { version: 1, id: randomUUID(), libraryId, registrationKey: JSON.stringify(library),
        policyRevision: policy.revision, generation: await generation(root), createdAt: new Date().toISOString(), reason,
        digest: '', pages: [], dependencies, status: 'preview', written: [] }
      const seen = new Set<string>()
      for (const proposal of proposals) {
        signal?.throwIfAborted()
        const relative = pagePath(proposal.path,proposal.area), key = relative.toLowerCase()
        if(proposal.area === 'state'&&proposal.content!==null)JSON.parse(proposal.content)
        if (seen.has(key)) throw new Error('批次有重复目标：' + relative)
        seen.add(key)
        const before = await bytesAt(root, relative), after = proposal.content === null ? null : Buffer.from(proposal.content)
        if (hashOf(before) !== proposal.expectedBefore) throw new Error('分析期间页面已变化，请重新生成：' + relative)
        if (hashOf(before) === hashOf(after)) continue
        batch.pages.push({ path: relative, before: before === null ? null : await saveObject(root, before), after: after === null ? null : await saveObject(root, after),...(proposal.area?{area:proposal.area}:{}) })
      }
      if (!batch.pages.length) throw new Error('页面内容没有变化。')
      await checkDependencies(root, batch, library.sourceRoots)
      this.libraries.assertUnchanged(library)
      signal?.throwIfAborted()
      batch.digest = digest(batch); await saveBatch(root, batch)
      return batch
    })
  }
  async list(libraryId: string): Promise<ChangeSet[]> {
    const root = await this.libraries.root(libraryId)
    let files: string[]
    try { files = await readdir(await safePath(root, '.llmwiki/changes')) }
    catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []; throw error }
    const batches = await Promise.all(files.filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).map(async name => this.reconcileLayered(libraryId, root, await getBatch(root, name.slice(0, -5)))))
    return batches.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }
  async preview(libraryId: string, id: string) {
    const root = await this.libraries.root(libraryId), batch = await this.reconcileLayered(libraryId, root, await getBatch(root, id))
    if (batch.libraryId !== libraryId) throw new Error('批次属于其他数据库。')
    if (batch.layered) return { batch, pages: batch.status === 'cancelled' ? [] : await Promise.all(batch.pages.map(async page => ({ path: page.path,
      before: page.before === null ? null : await readPageObject(root, page.before), after: page.after === null ? null : await readPageObject(root, page.after) }))) }
    return { batch, pages: await Promise.all(batch.pages.map(async page => ({ path: page.path,
      before: (await objectBytes(root, page.before))?.toString('utf8') ?? null,
      after: (await objectBytes(root, page.after))?.toString('utf8') ?? null }))) }
  }
  async commit(libraryId: string, id: string, approvedDigest: string, signal?: AbortSignal): Promise<ChangeSet> {
    const root = await this.libraries.root(libraryId, true)
    if ((await getBatch(root, id)).layered) return this.applyLayered(libraryId, id, approvedDigest, false, signal)
    return await withLibraryLock(root, 'commit', async () => {
      await this.libraries.root(libraryId, true)
      const batch = await getBatch(root, id)
      if (batch.libraryId !== libraryId || batch.digest !== approvedDigest) throw new Error('确认与批次不匹配。')
      if (batch.status === 'committed') return batch
      if (batch.status !== 'preview') throw new Error('批次当前不能提交，请先检查恢复状态。')
      this.libraries.registration(libraryId, batch.registrationKey)
      if ((await this.libraries.policy(libraryId)).revision !== batch.policyRevision || await generation(root) !== batch.generation) throw new Error('配置或库版本已变化，请重新生成预览。')
      const library = this.libraries.registration(libraryId); await validateRoots(root, library.sourceRoots)
      await checkDependencies(root, batch, library.sourceRoots)
      for (const page of batch.pages) {
        signal?.throwIfAborted()
        if (hashOf(await bytesAt(root, page.path)) !== page.before) throw new Error('页面已变化，整个批次失效：' + page.path)
        await objectBytes(root, page.after)
      }
      signal?.throwIfAborted()
      // 在第一笔页面写入前留下恢复标记，崩溃后禁止后续普通写入。
      await writeState(root, '.llmwiki/coordination/recovery.json', { batchId: batch.id })
      batch.status = 'committing'; await saveBatch(root, batch)
      let writeStarted = false
      try {
        for (const page of batch.pages) {
          signal?.throwIfAborted(); this.libraries.registration(libraryId, batch.registrationKey)
          const bytes = await objectBytes(root, page.after)
          signal?.throwIfAborted(); this.libraries.registration(libraryId, batch.registrationKey)
          await this.libraries.root(libraryId, true)
          signal?.throwIfAborted()
          // 写入器可能改过文件后再抛错，不能根据 written 为空判断尚未写入。
          writeStarted = true
          await this.writer.write(root, page, bytes)
          batch.written.push(page.path); await saveBatch(root, batch)
        }
        await writeState(root, '.llmwiki/coordination/generation.json', { value: batch.generation + 1, batchId: batch.id })
        batch.status = 'committed'; await saveBatch(root, batch)
        await unlink(await safePath(root, '.llmwiki/coordination/recovery.json'))
        return batch
      } catch (error) {
        if (signal?.aborted && !writeStarted) {
          batch.status = 'preview'; batch.error = '提交在页面写入前取消，批次仍待确认。'
          await saveBatch(root, batch)
          await unlink(await safePath(root, '.llmwiki/coordination/recovery.json'))
          throw error
        }
        batch.status = 'recovery'; batch.error = error instanceof Error ? error.message : '提交中断。'
        await saveBatch(root, batch); throw error
      }
    })
  }
  async recover(libraryId: string, id: string, approvedDigest: string): Promise<ChangeSet> {
    const root = await this.libraries.root(libraryId, true)
    return await withLibraryLock(root, 'recover', async () => {
      await this.libraries.root(libraryId, true)
      const batch = await getBatch(root, id), marker = await readOptional<{batchId: string}>(await safePath(root, '.llmwiki/coordination/recovery.json'))
      if (batch.libraryId !== libraryId || batch.digest !== approvedDigest || marker?.batchId !== id) throw new Error('恢复确认与当前提交不匹配。')
      this.libraries.registration(libraryId, batch.registrationKey)
      // 先核对整个批次；人工修改的页面保留现场，不能覆盖。
      for (const page of batch.pages) {
        const current = hashOf(await bytesAt(root, page.path))
        if (current !== page.before && current !== page.after) throw new Error('发现外部修改，停止自动恢复：' + page.path)
      }
      for (const page of [...batch.pages].reverse()) if (hashOf(await bytesAt(root, page.path)) === page.after) {
        this.libraries.registration(libraryId, batch.registrationKey)
        await this.libraries.root(libraryId, true)
        await this.writer.write(root, { ...page, before: page.after, after: page.before }, await objectBytes(root, page.before))
      }
      // 回滚也推进代次，使所有旧预览失效。
      await writeState(root, '.llmwiki/coordination/generation.json', { value: Math.max(await generation(root), batch.generation) + 1, batchId: batch.id })
      batch.status = 'rolled-back'; await saveBatch(root, batch)
      await unlink(await safePath(root, '.llmwiki/coordination/recovery.json'))
      return batch
    }, true)
  }
  async prepareRevert(libraryId:string,id:string,approvedDigest:string):Promise<ChangeSet>{
    const library=this.libraries.registration(libraryId)
    const root=await this.libraries.root(libraryId,true),batch=await getBatch(root,id)
    if(batch.layered)throw new Error('分层版本不使用旧页面撤销批次；请修改来源后重新生成预览。')
    if(batch.libraryId!==libraryId||batch.digest!==approvedDigest||batch.status!=='committed')throw new Error('只能为已确认提交的批次生成撤销预览。')
    const proposals:PageProposal[]=[]
    for(const page of batch.pages){
      if(hashOf(await bytesAt(root,page.path))!==page.after)throw new Error('页面已有后续修改，不能撤销旧批次：'+page.path)
      proposals.push({path:page.path,...(page.area?{area:page.area}:{}),expectedBefore:page.after,content:(await objectBytes(root,page.before))?.toString('utf8')??null})
    }
    this.libraries.assertUnchanged(library)
    return await this.prepare(libraryId,'撤销已提交批次 '+id,proposals)
  }
  async cancel(libraryId:string,id:string,approvedDigest:string):Promise<ChangeSet>{
    const library=this.libraries.registration(libraryId)
    const root=await this.libraries.root(libraryId,true)
    if ((await getBatch(root, id)).layered) return this.applyLayered(libraryId, id, approvedDigest, true)
    return await withLibraryLock(root,'cancel-preview',async()=>{
      const batch=await getBatch(root,id)
      this.libraries.assertUnchanged(library)
      if(batch.libraryId!==libraryId||batch.digest!==approvedDigest||batch.status!=='preview')throw new Error('只能取消仍在等待确认的批次。')
      batch.status='cancelled';await saveBatch(root,batch);return batch
    })
  }
}
