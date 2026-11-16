import { createBuildModelClient } from './models.js'
import { claimWriter } from '../layered/devices.js'
import { sourceRetryRequest } from '../layered/source-recovery.js'
import { randomUUID } from 'node:crypto'
import { mkdir, readdir } from 'node:fs/promises'
import { defaultSourceRoot, defaultWikiPath,newLibrary, parseRegistry } from '../domain/config.js'
import type { Registry, SiyuanSettings, LayeredSettings } from '../domain/config.js'
import type { LibraryStore } from '../storage/libraries.js'
import type { ModelRuntime } from '../llm/client.js'
import { actualPath, safePath, validateRoots } from '../storage/paths.js'
import { readOptional } from '../storage/files.js'
import { scanLibrary } from '../ingest/scanner.js'
import { generateWiki, listGenerateJobs } from '../wiki/generation.js'
import { ChangeStore } from '../storage/changes.js'
import { separateImages } from '../ingest/markdown.js'
import { SiyuanAdapter, validateSiyuanRoot, WikiExportClient } from '../layered/siyuan.js'
import { buildLayeredLibrary } from '../layered/index.js'
import { initializeLibrary } from '../layered/publication.js'
import { generateLocalLayered, scanLocalLayered } from './local-layered.js'
import type { BuildLayeredOptions, PendingBuild } from '../layered/schema.js'
import { copyLibraryWithEmbedding } from './query-vectors.js'
import { libraryProductionStatus } from './library-status.js'
import { readUpgradeStatus, upgradeLibrary } from '../layered/upgrade.js'
import { findLayeredLibrary } from '../wiki/query.js'
import { policySchema } from '../domain/policy-schema.js'
import { bindEmbeddingCredential } from '../llm/credentials.js'
import { isProductionFormat } from '../layered/models.js'
import { createLibraryServices } from './library-management.js'
import type { LibraryServices } from './library-management.js'
import type { DiscoveryBackend } from '../wiki/library-discovery.js'

export type RegistryWriter = (next: Registry, expected: Registry) => Promise<void>
export interface CreateWikiInput { name: string; wikiPath?: string; sourceRoots?: string[]; provider: string; model: string; siyuan?: SiyuanSettings; embedding?: Partial<LayeredSettings> }

// 主会话与设置页共享作业占用表，提交继续使用同一批次和写锁协议。
export class WikiOperations {
  productionStatus(id: string, version?: string) { return libraryProductionStatus(this.store, id, version) }
  async beforeWrite(id: string, signal?: AbortSignal) {
    if (this.running.has(id)) throw new Error('请先暂停并等待在途请求结束，再修改库内设置。')
    const controller = new AbortController(), abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
    this.running.set(id, controller)
    try { return await this.upgradeBeforeWrite(id, controller.signal) }
    finally { this.running.delete(id); signal?.removeEventListener('abort', abort) }
  }
  /** 自动维护已持有运行槽，复用该槽及取消信号进入同一写前升级。 */
  async upgradeForRunningTask(id: string, signal: AbortSignal) {
    if (this.running.get(id)?.signal !== signal) throw new Error('写入前升级需要当前任务的库运行槽。')
    return this.upgradeBeforeWrite(id, signal)
  }
  private async upgradeBeforeWrite(id: string, signal?: AbortSignal) {
    signal?.throwIfAborted()
    const library = this.store.registration(id), root = await this.store.root(id, true)
    const layered = await findLayeredLibrary(root), view = await this.store.policy(id)
    if (!layered || !view.initialized) return
    if (await isProductionFormat(layered.root)) return upgradeLibrary(layered.root, signal ? { signal } : {})
    const runtime = this.runtime()
    if (!runtime) throw new Error('模型运行时尚未连接，无法准备旧库升级。')
    const client = createBuildModelClient(runtime, { ...library, wikiPath: layered.root }, view.policy, this.store.snapshot())
    const status = await upgradeLibrary(layered.root, { ...client.upgradeOptions, ...(signal ? { signal } : {}) })
    if (status && status.status !== 'complete') throw Object.assign(new Error('旧库升级已暂停：' + status.reason + '；备份：' + status.backupPath), { upgrade: status })
    return status
  }
  async savePolicy(id: string, value: unknown, revision: string, expectedKey: string, signal?: AbortSignal) {
    const policy = policySchema.parse(value)
    if (this.running.has(id)) throw new Error('请先暂停并等待在途请求结束，再修改库内设置。')
    const controller = new AbortController(), abort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort()
    this.running.set(id, controller)
    try {
    this.store.registration(id, expectedKey)
    const current = await this.store.policy(id)
    if (current.revision !== revision) throw Object.assign(new Error('随库策略已被修改，请重新加载后再保存。'), { httpStatus: 409 })
    const upgrade = await this.upgradeBeforeWrite(id, controller.signal)
    if (upgrade || current.policy.libraryFormat) policy.libraryFormat = '0.3.0'
    const updated = await this.store.policy(id)
    const { libraryFormat: _old, ...original } = current.policy, { libraryFormat: _new, ...latest } = updated.policy
    if (JSON.stringify(original) !== JSON.stringify(latest)) throw Object.assign(new Error('升级期间策略已变化，请重新读取。'), { httpStatus: 409 })
    return { ...await this.store.savePolicy(id, policy, updated.revision, expectedKey), ...(upgrade ? { upgrade } : {}) }
    } finally { this.running.delete(id); signal?.removeEventListener('abort', abort) }
  }
  copyWithEmbedding(input: unknown, signal?: AbortSignal, env?: NodeJS.ProcessEnv) {
    const service = this.store.snapshot().embeddingService
    if (service) bindEmbeddingCredential(service, env)
    return copyLibraryWithEmbedding(this.store, input, signal, this.writeRegistry)
  }
  readonly libraries: LibraryServices | undefined
  constructor(private readonly store: LibraryStore, private readonly runtime: () => ModelRuntime | undefined,
    readonly running: Map<string, AbortController>, private readonly writeRegistry?: RegistryWriter,
    services: { visible?: DiscoveryBackend['visible']; changed?: () => void | Promise<void> } = {}) {
    this.libraries = writeRegistry ? createLibraryServices(store, writeRegistry, runtime, running, services.visible, services.changed) : undefined
  }

  async create(input: CreateWikiInput, signal: AbortSignal) {
    signal.throwIfAborted()
    if (!this.writeRegistry) throw new Error('宿主配置写入服务尚未连接。')
    const suppliedRoots = input.sourceRoots ?? []
    if (!input.name.trim() || !input.provider.trim() || !input.model.trim()) throw new Error('请提供库名和已登记的供应商/模型。')
    const selectedPath=input.wikiPath?.trim()||defaultWikiPath(suppliedRoots, input.embedding)
    if(!selectedPath)throw new Error('请提供可用的绝对资料目录；多个资料目录建库时须明确指定 Wiki 输出目录。')
    const expected=this.store.snapshot(), root=await actualPath(selectedPath)
    if(input.siyuan)await validateSiyuanRoot(root,input.siyuan)
    const inferredRoot = defaultSourceRoot(root), sourceRoots = suppliedRoots.length ? suppliedRoots : inferredRoot ? [inferredRoot] : []
    if (!input.siyuan && sourceRoots.length !== 1) throw new Error('本地分层库只支持一个原始资料目录；未填写时 Wiki 目录须为 .llmwiki 或 .llmwiki-<模型标准名>。')
    const roots=input.siyuan?{sources:[]}:await validateRoots(root,sourceRoots)
    try { if ((await readdir(root)).length) throw new Error('新库输出目录已有内容，请选择空目录；已有 Wiki 请通过设置页登记。') }
    catch(error) { if (!(error instanceof Error && 'code' in error && error.code==='ENOENT')) throw error }
    for (const library of expected.libraries.filter(library=>library.kind!=='whalefall')) {
      if ((await actualPath(library.wikiPath)).toLowerCase()===root.toLowerCase()) throw new Error('此 Wiki 目录已登记，请使用现有数据库。')
    }
    const runtime=this.runtime()
    if (!runtime || !await runtime.resolveModelInfo(input.provider,input.model)) throw new Error('所选模型当前未在宿主注册。')
    signal.throwIfAborted()
    const library=newLibrary(randomUUID())
    Object.assign(library,{name:input.name.trim(),wikiPath:root,sourceRoots:roots.sources})
    if (input.embedding) library.layered = structuredClone(input.embedding)
    if(input.siyuan){library.kind='siyuan';library.siyuan=structuredClone(input.siyuan)}
    library.models.unified={provider:input.provider,model:input.model}
    // 新建请求只选择模型，不能把默认模型的推理强度强加给另一种兼容模型。
    library.models.layeredRoutes={}
    const next=structuredClone(expected)
    next.libraries.push(library);next.activeLibraryId=library.id
    await this.writeRegistry(parseRegistry(next),expected)
    return {libraryId:library.id,status:'registered',message:'数据库已登记；调用 wiki_generate 扫描并生成预览。',wikiPath:root,sourceRoots:roots.sources}
  }

  async retryTopicGaps(id: string, signal: AbortSignal, filter: NonNullable<BuildLayeredOptions['retryTopics']> = {}) {
    return this.generate(id, 'generate', signal, undefined, false, undefined, undefined, filter)
  }

  async generate(id: string, action: 'scan'|'generate', signal: AbortSignal, resumeId?: string,rebuild=false,legacyLibraryAction?: 'backup', reextract?: BuildLayeredOptions['reextract'] | 'gaps', retryTopics?: BuildLayeredOptions['retryTopics'], retrySources?: BuildLayeredOptions['retrySources']) {
    sourceRetryRequest({ ...(retrySources !== undefined ? { retrySources } : {}), ...(retryTopics ? { retryTopics } : {}), retryGaps: reextract === 'gaps', ...(reextract && reextract !== 'gaps' ? { reextract } : {}) })
    const library=this.store.registration(id)
    if (retrySources && (action !== 'generate' || library.kind !== 'local' || library.siyuan)) throw new Error('来源定向补缺只适用于本地 Markdown 分层库生成。')
    const sourcePending = library.kind === 'local' && action === 'generate'
      ? await readOptional<Pick<PendingBuild, 'source_scope'>>(await safePath(library.wikiPath, 'work/pending.json')) : undefined
    if ((retrySources || sourcePending?.source_scope) && (reextract !== undefined || retryTopics !== undefined || rebuild || legacyLibraryAction)) throw new Error('来源补缺不能与重提、重建、主题重试或旧库备份组合。')
    if (action === 'generate' && !retrySources && !sourcePending?.source_scope && this.libraries && !this.running.has(id)) await this.libraries.summaries.retryPending(id, signal)
    if (retryTopics && (action !== 'generate' || library.kind !== 'local' && !library.siyuan)) throw new Error('主题缺口重试只适用于分层库。')
    if (reextract !== undefined && (action !== 'generate' || library.kind !== 'local' && !library.siyuan)) throw new Error('用当前模型重新提取只适用于本地或思源分层库的生成操作。')
    await this.store.root(id,true)
    if (this.running.has(id)) throw new Error('该库已有处理任务，正在生成或检查，请等待完成或先取消。')
    if (action === 'scan' && library.siyuan) await this.beforeWrite(id, signal)
    const abort=new AbortController(),cancel=()=>abort.abort(signal.reason)
    signal.addEventListener('abort',cancel,{once:true})
    if(signal.aborted)cancel()
    this.running.set(id,abort)
    try {
      abort.signal.throwIfAborted()
      const runtime=this.runtime()
      if(action==='generate'&&!runtime)throw new Error('宿主模型服务尚未连接。')
      this.store.assertUnchanged(library)
      if(library.siyuan){
        const root=await validateSiyuanRoot(library.wikiPath,library.siyuan)
        await mkdir(root,{recursive:true})
        const adapter=new SiyuanAdapter(new WikiExportClient(library.id,library.siyuan))
        if(action==='scan'){
          await initializeLibrary(root,{name:library.name,domain:library.description,origin_type:'siyuan',source_type:'思源笔记',default_credibility:'unknown',source_count:0,updated_at:new Date().toISOString(),format_version:2},library.layered?.writerTakeoverToken)
          await claimWriter(root,library.layered?.writerTakeoverToken)
          await adapter.checkAdmission(root,abort.signal)
          const scan=await adapter.scan(root,abort.signal)
          return {libraryId:id,status:'scanned',scan:{sources:scan.sources.map(source=>({sourceId:source.sourceId,path:source.path})),gaps:scan.gaps}}
        }
        const policy=(await this.store.policy(id)).policy
        const client=createBuildModelClient(runtime!,library,policy,this.store.snapshot())
        const result=await buildLayeredLibrary({knowledgeRoot:root,siyuan:adapter,client,...(client.recovery?{recovery:client.recovery}:{}),...(client.upgradeOptions?{upgradeOptions:client.upgradeOptions}:{}),taskModelIdentity:{models:library.models,policy},name:library.name,domain:library.description,
          topics:library.layered??{},tagVocabulary:policy.tagVocabularyMode==='custom'?[...policy.customEntityTags,...policy.customConceptTags]:[],signal:abort.signal,...(retryTopics ? { retryTopics } : {}),...(reextract === 'gaps' ? { retryGaps: true } : { reextract })})
        this.store.assertUnchanged(library)
        if (this.libraries) await this.libraries.summaries.afterPublication(id, result.version, abort.signal)
        const upgrade = await readUpgradeStatus(root)
        return {libraryId:id,status:'published',...result,...(upgrade ? { upgrade, backupPath: upgrade.backupPath } : {}),message:'思源分层库已通过校验并发布。'}
      }
      if (library.kind === 'local') {
        if (action === 'scan') return { libraryId: id, status: 'scanned', scan: await scanLocalLayered(this.store, id, abort.signal) }
        const result = await generateLocalLayered(this.store, id, runtime!, abort.signal, legacyLibraryAction, reextract, retryTopics, retrySources)
        const upgrade = await readUpgradeStatus(library.wikiPath)
        return { ...result, ...(upgrade ? { upgrade, backupPath: 'backupPath' in result ? result.backupPath ?? upgrade.backupPath : upgrade.backupPath } : {}) }
      }
      if (!(await this.store.policy(id)).initialized) await this.store.initialize(id)
      const scan=await scanLibrary(this.store,id,abort.signal)
      if(scan.errors.length)throw new Error('资料扫描有读取问题，未启动生成：'+scan.errors.map(error=>error.path+'：'+error.message).join('；'))
      if(action==='scan')return {libraryId:id,status:'scanned',scan}
      const job=await generateWiki(this.store,id,runtime!,abort.signal,resumeId,undefined,rebuild)
      return {libraryId:id,status:job.status,jobId:job.id,batchId:job.batchId,pendingImages:job.pendingImages,
        message:job.batchId?'已生成预览；先用 wiki_changes preview 阅读差异，再确认提交。':'内容没有变化。'}
    } finally { if(this.running.get(id)===abort)this.running.delete(id);signal.removeEventListener('abort',cancel) }
  }

  async automaticAllowed(id: string, batchId: string, digest: string): Promise<boolean> {
    const {batch}=await new ChangeStore(this.store).preview(id,batchId),view=await this.store.policy(id)
    const pages=batch.pages.filter(page=>!page.area)
    return batch.status==='preview'&&batch.reason==='资料提取与跨文档综合'&&batch.digest===digest
      &&batch.policyRevision===view.revision&&batch.registrationKey===JSON.stringify(this.store.registration(id))
      &&pages.length>0&&pages.every(page=>page.after!==null&&view.policy.automaticOperations.includes(page.before===null?'ingest':'update'))
  }

  async changes(id: string, action: 'list'|'preview'|'commit'|'cancel', signal: AbortSignal, batchId?: string, digest?: string) {
    if(this.store.registration(id).siyuan)throw new Error('思源分层库通过 wiki_generate 校验并发布，不使用旧版差异批次。')
    const changes=new ChangeStore(this.store)
    signal.throwIfAborted()
    if(action==='list')return {libraryId:id,status:'listed',batches:(await changes.list(id)).map(batch=>({id:batch.id,status:batch.status,reason:batch.reason,createdAt:batch.createdAt})),
      jobs:(await listGenerateJobs(this.store,id)).map(job=>({id:job.id,status:job.status,batchId:job.batchId,error:job.error}))}
    if(!batchId)throw new Error('请提供已生成的批次 ID。')
    const preview=await changes.preview(id,batchId)
    if(action==='preview')return {libraryId:id,status:preview.batch.status,batchId,digest:preview.batch.digest,
      pages:preview.pages.filter(page=>!preview.batch.pages.find(change=>change.path===page.path)?.area).map(page=>({path:page.path,
        before:page.before===null?null:separateImages(page.before).text,after:page.after===null?null:separateImages(page.after).text}))}
    if(!digest)throw new Error('请先阅读预览并提供对应摘要签名。')
    const upgrade = await this.beforeWrite(id, signal)
    const batch=action==='commit'?await changes.commit(id,batchId,digest,signal):await changes.cancel(id,batchId,digest)
    if (action === 'commit' && batch.layered && this.libraries) {
      const card = await this.libraries.discovery.show(id, signal)
      if (card.publishedVersion) await this.libraries.summaries.afterPublication(id, card.publishedVersion, signal)
    }
    return {libraryId:id,status:batch.status,batchId,backupPath:batch.layered?.backupPath ?? upgrade?.backupPath,...(upgrade ? { upgrade } : {}),message:(action==='commit'?'批次已写入 Wiki。':'批次已取消。')+(batch.message??'')}
  }
}
