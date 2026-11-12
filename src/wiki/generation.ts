import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { LibraryStore } from '../storage/libraries.js'
import { ChangeStore,directoryRevision } from '../storage/changes.js'
import type { ChangeSet, Dependency, PageProposal } from '../storage/changes.js'
import { readOptional, signature, writeState } from '../storage/files.js'
import { readGenerateJobs, writeGenerateJob } from '../storage/jobs.js'
import { safePath,validateRoots,within } from '../storage/paths.js'
import { withLibraryLock } from '../storage/lock.js'
import { ModelCallError, ModelClient,validatedModelOutput } from '../llm/client.js'
import { mapConcurrent,walkConcurrent } from '../llm/scheduler.js'
import { contextWindowLimit } from '../llm/context.js'
import type { ModelRuntime, ModelAttempt } from '../llm/client.js'
import type { SourceRecord, SourceVersion } from '../ingest/scanner.js'
import type { ModelRef } from '../domain/config.js'
import { candidatesFrom, extractionSchema, extractionWithReferences, parseJson, EXTRACT_PROMPT,QuoteLocationError,validateExtractionLanguage } from '../ingest/extraction.js'
import type { Candidate, Claim, Extraction } from '../ingest/extraction.js'
import { originalOffset, partitionText, separateImages } from '../ingest/markdown.js'
import type { SourceChunk } from '../ingest/markdown.js'
import { blockSignature,escapeText,managedDocument,renderKnowledge,sourceIndex,WIKI_GUIDE } from './documents.js'
import type { KnowledgeCatalog,KnowledgePage } from './documents.js'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import type { Recognition } from '../ingest/vision.js'
import { synthesize,SYNTHESIS_VERSION } from './synthesis.js'
import type { SynthesisCandidate,SynthesisCheckpoint } from './synthesis.js'
import { analyzeRounds } from '../ingest/rounds.js'
import { selectSourceCandidates } from './source-selection.js'
import { decodeSourceText } from '../ingest/text.js'
import { processingPolicy } from '../domain/policy.js'
import { policySchema } from '../domain/policy-schema.js'
import type { AnalysisState } from '../ingest/rounds.js'
import { compilationKey, unchangedCompilation } from './compilation.js'
import { relatedIdentityWindows } from './identity-search.js'
import { pageLabels } from './language.js'
import type { PageLabels } from './language.js'
import { addDiagnostic,generationDiagnostic,qualityLabels,recoverableGenerationError } from './generation-diagnostics.js'
import type { GenerationDiagnostic } from './generation-diagnostics.js'

interface ChunkResult extends AnalysisState { key:string; sourceId:string; sourceHash:string; chunkId:string; start:number; end:number; originalStart:number; originalEnd:number; status:'pending'|'complete'|'failed'|'split'; candidates:Candidate[]; images:Extraction['images']; recognitions?:Recognition[]; error?:string;diagnostics?:GenerationDiagnostic[] }
export interface GenerateJob { kind:'generate'; id:string; libraryId:string; fingerprint:string; createdAt:string; updatedAt:string;
  status:'running'|'preview'|'unchanged'|'failed'|'cancelled'; chunks:ChunkResult[]; attempts:ModelAttempt[]; pendingImages:number; imageTotal?:number; imagesEnumerated?:boolean; synthesis?:SynthesisCheckpoint[]; warnings?:string[]; batchId?:string; error?:string;
  executionModel?:ModelRef; phase?:'preparing'|'extracting'|'synthesizing'|'preparing-preview'; sourceTotal?:number; sourcesCompleted?:number; policyRevision?:string; analysisFingerprint?:string; synthesisVersion?:string;
  partial?:boolean;diagnostics?:GenerationDiagnostic[];failure?:GenerationDiagnostic }
const slug = (title:string) => title.normalize('NFKC').replace(/[<>:"/\\|?*\x00-\x1f\[\]#]/g,'-').replace(/[. ]+$/,'').trim().slice(0,90) || 'page'
async function optionalText(root:string,relative:string):Promise<string|null> {
  try { return await readFile(await safePath(root,relative),'utf8') }
  catch(error) { if(error instanceof Error && 'code' in error && error.code === 'ENOENT') return null; throw error }
}
function location(version:SourceVersion,raw:string,offset:number) {
  const mapping = version.mapping.find(item => item.start <= offset && offset < item.end)
  const originalStart = mapping ? mapping.originalStart + (mapping.replacement ? 0 : offset - mapping.start) : offset
  return {originalStart,line:raw.slice(0,originalStart).split('\n').length}
}
async function rebuildPages(root:string,dependencies:Dependency[],signal:AbortSignal):Promise<Map<string,string>> {
  const pages=new Map<string,string>()
  const capture=async(relative:string)=>{
    signal.throwIfAborted()
    const raw=await optionalText(root,relative)
    if(raw!==null)pages.set(relative,raw)
    dependencies.push({path:relative,hash:raw===null?null:signature(raw)})
  }
  const walk=async(relative:string):Promise<void>=>{
    signal.throwIfAborted()
    const hash=await directoryRevision(root,relative)
    dependencies.push({path:relative,hash,directory:true})
    if(hash===null)return
    for(const entry of await readdir(await safePath(root,relative),{withFileTypes:true})){
      if(entry.isSymbolicLink())continue
      const child=relative+'/'+entry.name
      if(entry.isDirectory())await walk(child)
      else if(entry.isFile()&&/\.md$/i.test(entry.name))await capture(child)
    }
  }
  for(const folder of ['entities','concepts','sources'])await walk(folder)
  for(const relative of ['index.md','log.md','welcome.md'])await capture(relative)
  return pages
}
export async function listGenerateJobs(store:LibraryStore,libraryId:string):Promise<GenerateJob[]> {
  const root = await store.root(libraryId)
  return readGenerateJobs(root)
}
export async function generateWiki(store:LibraryStore,libraryId:string,runtime:ModelRuntime,signal:AbortSignal,resumeId?:string,_attachments?:Pick<AttachmentStore,'saveImage'>,rebuild=false,executionModel?:ModelRef,clientOverride?:ModelClient):Promise<GenerateJob> {
  const registration = store.registration(libraryId), library = executionModel ? {...registration,models:{...registration.models,unified:executionModel,perTask:false,fallbacks:[]}} : registration
  const root = await store.root(libraryId,true), policy = await store.policy(libraryId)
  if(rebuild&&library.kind!=='local')throw new Error('完整重建只适用于本地 Wiki；共管库请沿用页面维护流程。')
  if(!policy.initialized) throw new Error('请先初始化并扫描资料。')
  const generationRaw = await optionalText(root,'.llmwiki/coordination/generation.json')
  const catalogRaw = await optionalText(root,'.llmwiki/sources/catalog.json')
  if(!catalogRaw) throw new Error('请先扫描原始资料。')
  const roots=await validateRoots(root,library.sourceRoots)
  const sourceRecords=(JSON.parse(catalogRaw) as SourceRecord[]).map(record=>roots.sources.some(source=>within(source,record.absolutePath))?record:{...record,state:'missing' as const})
  const records=sourceRecords.filter(item=>item.state === 'active')
  if(!records.length) throw new Error('当前没有活动来源。')
  const schema = await optionalText(root,'schema/config.md'), dependencies:Dependency[] = [{path:'.llmwiki/sources/catalog.json',hash:signature(catalogRaw)},
    {path:'.llmwiki/coordination/generation.json',hash:generationRaw===null?null:signature(generationRaw)},
    {path:'schema/config.md',hash:schema === null ? null : signature(schema)},...records.map(item=>({path:item.absolutePath,hash:item.hash,source:true as const}))]
  const previousKnowledgeRaw=await optionalText(root,'.llmwiki/knowledge/catalog.json')
  const previousKnowledge:KnowledgeCatalog=previousKnowledgeRaw&&!rebuild?JSON.parse(previousKnowledgeRaw):{version:1,pages:[]}
  dependencies.push({path:'.llmwiki/knowledge/catalog.json',hash:previousKnowledgeRaw===null?null:signature(previousKnowledgeRaw)})
  const rebuilding=rebuild?await rebuildPages(root,dependencies,signal):new Map<string,string>()
  const extractionVersion='extract-v8-preserve-images:'+signature(EXTRACT_PROMPT)
  const fingerprintFor = (revision:string) => signature(JSON.stringify([library,revision,schema,previousKnowledgeRaw,generationRaw,records.map(item=>[item.id,item.hash]),extractionVersion,'source-pages-v1','source-limits-v1',rebuild,rebuild?[...rebuilding].map(([file,raw])=>[file,signature(raw)]):[]]))
  const fingerprint=fingerprintFor(policy.revision)
  const processingSignature=signature(JSON.stringify(processingPolicy(policy.policy)))
  const analysisFingerprint=signature(JSON.stringify([library.models,processingSignature,schema,extractionVersion,'analysis-policy-v2']))
  const inputKey=compilationKey(library,policy.policy,schema,sourceRecords,extractionVersion)
  const incremental=!rebuild&&previousKnowledge.compilation?.analysisKey===analysisFingerprint&&!!previousKnowledge.compilation.sources
  const previousInputs=new Map(previousKnowledge.compilation?.sources?.map(source=>[source.id,source])??[])
  const analysisRecords=incremental?records.filter(record=>previousInputs.get(record.id)?.hash!==record.hash||previousInputs.get(record.id)?.state!=='active'||previousKnowledge.compilation?.incompleteSources?.includes(record.id)):records
  let job:GenerateJob,legacyAnalysis:string|undefined
  if(resumeId) {
    if(!/^[a-f0-9-]{36}$/.test(resumeId)) throw new Error('作业身份无效。')
    const previous = (await readGenerateJobs(root)).find(job=>job.id===resumeId)
    if(!previous || previous.kind !== 'generate' || previous.libraryId !== libraryId) throw new Error('资料或处理配置已变化，请新建作业。')
    let previousRevision=policy.revision
    if(previous.fingerprint!==fingerprint){
      let histories:string[]=[]
      try{histories=await readdir(await safePath(root,'.llmwiki/policy-history'))}catch(error){if(!(error instanceof Error&&'code'in error&&error.code==='ENOENT'))throw error}
      const matching=histories.filter(name=>/^[a-f0-9]{64}\.json$/.test(name)&&fingerprintFor(name.slice(0,-5))===previous.fingerprint)
      let compatible=false
      for(const name of matching){
        const snapshot=await readOptional<{revision:string;policy:unknown}>(await safePath(root,'.llmwiki/policy-history/'+name))
        if(snapshot?.revision!==name.slice(0,-5))continue
        if(signature(JSON.stringify(processingPolicy(policySchema.parse(snapshot.policy))))===processingSignature){previousRevision=snapshot.revision;compatible=true;break}
      }
      if(!compatible||previous.status==='preview')throw new Error('资料或处理配置已变化，请新建作业。')
    }
    if(previous.status === 'preview') return previous
    if(previous.analysisFingerprint&&previous.analysisFingerprint!==analysisFingerprint)throw new Error('提取处理依据已变化，请新建作业。')
    if(!previous.analysisFingerprint)legacyAnalysis=signature(JSON.stringify([library.models,previousRevision,schema,extractionVersion]))
    job = previous
  } else { job = {kind:'generate',id:randomUUID(),libraryId,fingerprint,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),status:'running',chunks:[],attempts:[],pendingImages:0} }
  const client = clientOverride ?? new ModelClient(runtime,library,policy.policy), attemptOffset = job.attempts.length
  const imageIds=new Set<string>(),failedImageIds=new Set<string>()
  const cacheWrites=new Map<string,ChunkResult>()
  const previousSplits=new Map<string,ChunkResult>()
  const recordIssue=(issue:GenerationDiagnostic)=>{addDiagnostic(job.diagnostics??=[],issue);job.partial=true}
  if(legacyAnalysis)for(const chunk of job.chunks){
    if(chunk.key!==signature(`${chunk.sourceId}:${chunk.sourceHash}:${chunk.chunkId}:${legacyAnalysis}`))throw new Error('旧检查点身份不匹配，停止接续。')
    chunk.key=signature(`${chunk.sourceId}:${chunk.sourceHash}:${chunk.chunkId}:${analysisFingerprint}`)
    if(chunk.status==='complete')cacheWrites.set(chunk.key,chunk)
  }
  job.fingerprint=fingerprint;job.policyRevision=policy.revision;job.analysisFingerprint=analysisFingerprint
  job.synthesisVersion=SYNTHESIS_VERSION
  let checkpoints:Promise<void>=Promise.resolve(),started=false
  const persist = ():Promise<void> => {
    const next=checkpoints.then(save,save);checkpoints=next;return next
  }
  const save = async () => {
    job.imageTotal=imageIds.size;job.pendingImages=failedImageIds.size
    job.updatedAt = new Date().toISOString(); job.attempts.splice(attemptOffset,job.attempts.length-attemptOffset,...client.attempts)
    await withLibraryLock(root,'job-checkpoint',async()=>{
      store.assertUnchanged(registration)
      if(!started){
        if(await optionalText(root,'.llmwiki/sources/catalog.json')!==catalogRaw)throw new Error('来源清单在生成启动前已变化，请重新启动以读取最新扫描结果。')
        const history=await listGenerateJobs(store,libraryId)
        if(history.some(record=>record.status==='running'))throw new Error('该库已有持久生成任务，请等待完成或先确认原作业已停止。')
        // 新扫描会创建新作业；保留同处理依据的缩段结构，使已验证的叶段缓存仍可到达。
        if(!resumeId)for(const previous of history)if(previous.analysisFingerprint===analysisFingerprint){
          for(const chunk of previous.chunks)if(chunk.status==='split'&&!previousSplits.has(chunk.key))previousSplits.set(chunk.key,chunk)
        }
        started=true
      }
      for(const [key,result] of cacheWrites){await writeState(root,`.llmwiki/analysis/${key}.json`,result);cacheWrites.delete(key)}
      await writeGenerateJob(root,job)
    })
  }
  job.status = 'running'; job.phase='preparing';job.sourceTotal=records.length;job.sourcesCompleted=0
  if(executionModel)job.executionModel=executionModel
  delete job.error;delete job.failure;job.diagnostics=[];job.partial=false;await persist()
  try {
    if(!rebuild&&await unchangedCompilation(root,previousKnowledge,inputKey,sourceRecords)){
      job.status='unchanged';job.sourcesCompleted=records.length;await persist();return job
    }
    let labels:PageLabels
    try{labels=pageLabels(policy.policy.wikiLanguage)}catch{
      if(incremental&&previousKnowledge.labels)labels=previousKnowledge.labels
      else{
        const template=pageLabels('en'),input=JSON.stringify({language:policy.policy.wikiLanguage,template}),key=signature('page-language-v1:'+input)
        const schema=z.strictObject(Object.fromEntries(Object.keys(template).map(key=>[key,z.string().min(1).max(600)])))
        const cached=job.synthesis?.find(item=>item.key===key)
        const parse=(text:string)=>schema.parse(parseJson(text)) as unknown as PageLabels
        if(cached)labels=parse(cached.output)
        else{
          const {output,value}=await validatedModelOutput(feedback=>client.call('ingest','将输入 template 的每个字段翻译为 language 指定的页面语言，保留 Markdown 链接及工具名，只返回同结构的严格 JSON。',JSON.stringify({...JSON.parse(input),...(feedback?{validationFeedback:feedback}:{})}),signal),parse)
          labels=value;(job.synthesis??=[]).push({key,output});await persist()
        }
      }
    }
    for(const record of records){
      const version=await readOptional<SourceVersion>(await safePath(root,`.llmwiki/sources/${record.id}/${record.hash}.json`))
      if(!version)throw new Error('来源版本不存在，请重新扫描。')
      if(version.parserVersion!==2)throw new Error('资料正文分离规则已更新，请重新扫描；原文和图片不会改写。')
      for(const image of version.images){imageIds.add(record.id+':'+image.id);if(image.state==='failed')failedImageIds.add(record.id+':'+image.id)}
    }
    job.imagesEnumerated=true;await persist()
    const info = analysisRecords.length?await client.info('ingest',signal):{provider:'',id:'',name:''}
    // 未知 tokenizer 时按 UTF-8 字节保守预留输入空间；不把字符数冒充 token 数。
    const contextWindow=contextWindowLimit(policy.policy,info)
    const inputBytes = contextWindow ? Math.max(512,contextWindow - Math.max(policy.policy.maxTokensPerCall || info.defaultMaxTokens || 4096,2048) - 2048) : 36000
    const chunkChars = Math.min(12000,Math.floor(inputBytes/4))
    job.phase='extracting';await persist()
    const imageOnlySources=new Set<string>()
    job.sourcesCompleted=records.length-analysisRecords.length
    const perSource=await mapConcurrent(analysisRecords,policy.policy.analysisConcurrency,signal,async(record,signal)=>{
      signal.throwIfAborted()
      const version = await readOptional<SourceVersion>(await safePath(root,`.llmwiki/sources/${record.id}/${record.hash}.json`))
      if(!version) throw new Error('来源版本不存在，请重新扫描。')
      const cleanBytes=await readFile(await safePath(root,'.llmwiki/objects/'+version.textObject)),rawBytes=await readFile(await safePath(root,'.llmwiki/objects/'+version.snapshotObject))
      if(version.snapshotObject!==record.hash||signature(rawBytes)!==record.hash||signature(cleanBytes)!==version.textObject)throw new Error('来源快照或正文对象签名不匹配。')
      const clean=cleanBytes.toString('utf8'),raw=decodeSourceText(rawBytes)
      const chunks = partitionText({text:clean,mapping:version.mapping,images:[]},chunkChars)
      const processChunk=async(chunk:SourceChunk,signal:AbortSignal):Promise<SourceChunk[]>=>{
        signal.throwIfAborted()
        const key = signature(`${record.id}:${record.hash}:${chunk.id}:${analysisFingerprint}`)
        let result = job.chunks.find(item=>item.key === key)
        if(!result){
          try{
            const cached=await readOptional<ChunkResult>(await safePath(root,`.llmwiki/analysis/${key}.json`))??previousSplits.get(key)
            if(cached){
              const valid=cached.key===key&&['complete','split'].includes(cached.status)&&cached.sourceId===record.id&&cached.sourceHash===record.hash&&cached.chunkId===chunk.id&&cached.start===chunk.start&&cached.end===chunk.end&&(cached.status==='split'||cached.candidates.every(candidate=>candidate.claims.every(claim=>{
                const evidence=claim.evidence
                if(evidence.sourceId!==record.id||evidence.hash!==record.hash)return false
                if(evidence.image){
                  const image=version.images.find(image=>image.id===evidence.image!.id&&image.assetId===evidence.image!.assetId)
                  const recognition=cached.recognitions?.find(item=>item.id===image?.id&&item.key===evidence.image!.recognitionKey&&item.status==='recognized')
                  return !!image&&!!recognition&&[recognition.observedText,...recognition.observations].some(text=>text.includes(evidence.quote))
                }
                return evidence.cleanStart>=chunk.start&&evidence.cleanStart+evidence.quote.length<=chunk.end&&clean.slice(evidence.cleanStart,evidence.cleanStart+evidence.quote.length)===evidence.quote
              })))
              if(!valid)throw new Error('缓存身份或引文校验失败。')
              result=structuredClone(cached);job.chunks.push(result);await persist()
            }
          }catch(error){signal.throwIfAborted();(job.warnings??=[]).push('重提取无效缓存 '+record.relativePath+'：'+(error instanceof Error?error.message:String(error)))}
        }
        if(!result) { result={key,sourceId:record.id,sourceHash:record.hash,chunkId:chunk.id,start:chunk.start,end:chunk.end,originalStart:chunk.originalStart,originalEnd:chunk.originalEnd,status:'pending',candidates:[],images:[]}; job.chunks.push(result) }
        const split=():SourceChunk[]=>{
          let middle=chunk.start+Math.floor((chunk.end-chunk.start)/2)
          if(/[\uD800-\uDBFF]/.test(clean[middle-1]!))middle--
          const child=(start:number,end:number):SourceChunk=>({id:signature(`${start}:${end}:${clean.slice(start,end)}`).slice(0,24),start,end,
            originalStart:originalOffset(version.mapping,start),originalEnd:originalOffset(version.mapping,end,true),text:clean.slice(start,end),status:'pending'})
          return [child(chunk.start,middle),child(middle,chunk.end)]
        }
        if(result.status==='split')return split()
        if(result.diagnostics?.length){
          // 有缺口的已保存轮次可以接续；旧完整缓存不因本次诊断能力变化而改写。
          const index=job.chunks.indexOf(result);result=structuredClone(result);job.chunks[index]=result
          result.status='pending';result.diagnostics=[]
        }
        if(result.status !== 'complete') {
          await persist()
          try {
            const images = version.images.filter(image=>image.originalStart >= chunk.originalStart && image.originalStart < chunk.originalEnd)
            const validated=new WeakMap<Extraction,Candidate[]>()
            const validate=(extraction:Extraction,round:number,allowUnlocated=true)=>{
              const previous=validated.get(extraction);if(previous)return previous
              validateExtractionLanguage(extraction,policy.policy.wikiLanguage)
              // 兼容旧模型的图片判断字段；原图独立保留，不再校验图片覆盖引文或触发识图。
              const issues:GenerationDiagnostic[]=[]
              const candidates=candidatesFrom(extraction,chunk.text,{...chunk,id:round?chunk.id+'-round'+round:chunk.id},record,offset=>location(version,raw,offset),policy.policy.skipMentionOnlyCandidates,[],allowUnlocated?claim=>{
                issues.push(generationDiagnostic(claim.error,{scope:'claim',phase:'extracting',sourceId:record.id,sourcePath:record.relativePath,chunkId:chunk.id,
                  claimId:round+':'+claim.candidate+':'+claim.claim,start:chunk.start,end:chunk.end,line:location(version,raw,chunk.start).line,text:claim.text,quote:claim.quote}))
              }:undefined)
              if(!candidates.length&&issues.length&&chunk.text.length>400)throw new QuoteLocationError(extraction.candidates[0]?.title??'',issues[0]!.quote??'',chunk.text)
              if(policy.policy.tagVocabularyMode==='custom')for(const candidate of candidates){
                const allowed=candidate.type==='entity'?policy.policy.customEntityTags:policy.policy.customConceptTags
                if(candidate.tags.some(tag=>!allowed.includes(tag)))throw new Error('提取使用了自定义词表以外的标签。')
              }
              for(const issue of issues){addDiagnostic(result!.diagnostics??=[],issue);recordIssue(issue)}
              const output=candidates.map(candidate=>({...candidate,claims:candidate.claims.map(claim=>({...claim,evidence:{...claim.evidence,chunkId:chunk.id}}))}))
              validated.set(extraction,output);return output
            }
            const analysis=await analyzeRounds(result,policy.policy,chunk.text.length,async(known,batchSize,round)=>{
              const input=JSON.stringify({language:policy.policy.wikiLanguage,granularity:policy.policy.extractionGranularity,
                limits:policy.policy.extractionGranularity==='custom'?{entities:policy.policy.customEntityLimit,concepts:policy.policy.customConceptLimit}:undefined,
                tagVocabulary:policy.policy.tagVocabularyMode==='custom'?{entity:policy.policy.customEntityTags,concept:policy.policy.customConceptTags}:undefined,
                schema,source:record.relativePath,text:chunk.text,images:images.map(({id,alt,line})=>({id,alt,line})),
                batchSize,round:round+1,known:known.map(candidate=>({type:candidate.type,title:candidate.title,identity:candidate.identity,claims:candidate.claims.map(claim=>claim.text)}))})
              if(Buffer.byteLength(input)+Buffer.byteLength(EXTRACT_PROMPT)>inputBytes)throw new ModelCallError('Schema、已有候选与资料片段超出当前模型保守预算。','context-limit')
              const quoteReferences=new Map(chunk.text.length<=800?[['current-fragment',chunk.text]]:[])
              let correcting=false
              const {value}=await validatedModelOutput(feedback=>{
                correcting=!!feedback
                const validationFeedback=feedback&&quoteReferences.size?{...feedback,
                  error:feedback.error+'本次纠正可在 claim 中用 quoteRef 替代 quote；quoteRef 只能填写 quoteReferences 提供的 id，程序将回填其完整原文后严格校验。主张必须由该原文支持，不能同时填写 quote 和 quoteRef。',
                  quoteReferences:[...quoteReferences].map(([id,text])=>({id,text}))}:feedback
                return client.call('ingest',EXTRACT_PROMPT+'\n根据 round 和 known 继续提取遗漏的知识或补充已有对象的新主张；不重复已有主张，没有补充则输出空 candidates。遵守 batchSize 和自定义标签词表。',feedback?JSON.stringify({...JSON.parse(input),validationFeedback}):input,signal)
              },text=>{
                const parsed=parseJson(text),extraction=correcting&&quoteReferences.size?extractionWithReferences(parsed,quoteReferences):extractionSchema.parse(parsed)
                validate(extraction,round,correcting);return extraction
              })
              return value
            },validate,persist,(error,round)=>{
              if(signal.aborted||!recoverableGenerationError(error))return false
              const issue=generationDiagnostic(error,{scope:'chunk',phase:'extraction-round-'+round,sourceId:record.id,sourcePath:record.relativePath,chunkId:chunk.id,
                start:chunk.start,end:chunk.end,line:location(version,raw,chunk.start).line})
              addDiagnostic(result!.diagnostics??=[],issue);recordIssue(issue);return true
            })
            result.candidates=analysis.candidates
            const resolved=new Set(result.diagnostics?.filter(issue=>issue.scope==='claim'&&analysis.candidates.some(candidate=>candidate.claims.some(claim=>claim.text===issue.text))).map(issue=>issue.id))
            if(resolved.size){result.diagnostics=result.diagnostics!.filter(issue=>!resolved.has(issue.id));job.diagnostics=job.diagnostics!.filter(issue=>!resolved.has(issue.id))}
            result.images=[]; result.status='complete'; delete result.error
            cacheWrites.set(key,result)
          } catch(error) {
            if(!signal.aborted && chunk.text.length>400 && recoverableGenerationError(error)){
              result.status='split';result.error=error instanceof Error?error.message:String(error);await persist();return split()
            }
            if(signal.aborted){result.status='pending';delete result.error}
            else{result.status='failed'; result.error=error instanceof Error ? error.message : String(error)}
            throw error
          }
          await persist()
        }
        return []
      }
      await walkConcurrent(chunks,policy.policy.pageGenerationConcurrency,signal,processChunk,async(error,chunk)=>{
        signal.throwIfAborted();if(!recoverableGenerationError(error))throw error
        recordIssue(generationDiagnostic(error,{scope:'chunk',phase:'extracting',sourceId:record.id,sourcePath:record.relativePath,chunkId:chunk.id,
          start:chunk.start,end:chunk.end,line:location(version,raw,chunk.start).line}));await persist();return []
      })
      const covered=job.chunks.filter(chunk=>chunk.sourceId===record.id&&chunk.status==='complete').sort((a,b)=>a.start-b.start)
      const leaves=job.chunks.filter(chunk=>chunk.sourceId===record.id&&chunk.status!=='split').sort((a,b)=>a.start-b.start)
      let end=0;for(const chunk of leaves){if(chunk.start!==end||!['complete','failed'].includes(chunk.status))throw new Error('段落覆盖存在未登记的遗漏或重叠。');end=chunk.end}
      if(end!==clean.length)throw new Error('段落覆盖未到达正文末尾。')
      const extracted=covered.flatMap(chunk=>chunk.candidates)
      if(!extracted.length&&version.images.length)imageOnlySources.add(record.id)
      const selected=await selectSourceCandidates(extracted,record.relativePath,policy.policy,inputBytes,
        (system,input,callSignal=signal)=>client.call('ingest',system,input,callSignal),job.synthesis??=[],persist,signal).catch(error=>{
          signal.throwIfAborted()
          throw new Error('来源按篇筛选失败（'+record.relativePath+'）：'+(error instanceof Error?error.message:String(error)),{cause:error})
        })
      job.sourcesCompleted=(job.sourcesCompleted??0)+1;await persist();return selected
    },async(error,record)=>{
      signal.throwIfAborted();if(!recoverableGenerationError(error))throw error
      recordIssue(generationDiagnostic(error,{scope:'source',phase:'source-selection',sourceId:record.id,sourcePath:record.relativePath,start:0,
        end:Math.max(0,...job.chunks.filter(chunk=>chunk.sourceId===record.id).map(chunk=>chunk.end)),line:1}))
      job.sourcesCompleted=(job.sourcesCompleted??0)+1;await persist();return []
    })
    let all:SynthesisCandidate[]=perSource.flat()
    job.partial=!!job.diagnostics?.length
    const hasCandidates=all.length>0,activeVersions=new Map(records.map(record=>[record.id,record.hash]))
    const retainedContent=incremental&&(imageIds.size>0||previousKnowledge.pages.some(page=>page.claims.some(claim=>activeVersions.get(claim.evidence.sourceId)===claim.evidence.hash)))
    if(!hasCandidates&&!imageOnlySources.size&&!retainedContent) throw new Error('没有提取到有来源支持的知识，请检查来源与模型输出。')
    const existing=new Map(previousKnowledge.pages.map(page=>['existing-'+signature(page.path),page]))
    const freshIds=new Set(all.map(candidate=>candidate.id))
    const freshClaimIds=new Set(all.flatMap(candidate=>candidate.claims.map(claim=>claim.id)))
    for(const [id,page] of existing)all.push({id,type:page.type,title:page.title,identity:page.identity,aliases:page.aliases,tags:page.tags,
      claims:incremental?page.claims.filter(claim=>activeVersions.get(claim.evidence.sourceId)===claim.evidence.hash&&!freshClaimIds.has(claim.id)):[],fixedType:true})
    const untouched=new Set<string>()
    if(incremental){
      const affected=new Set(all.filter(item=>existing.has(item.id)&&existing.get(item.id)!.claims.some(claim=>activeVersions.get(claim.evidence.sourceId)!==claim.evidence.hash)).map(item=>item.id))
      const contexts=new Map(all.map(item=>[item.id,item.claims.map(claim=>claim.text).join('\n')]))
      for(const window of relatedIdentityWindows(all,signal,{contexts}))if(window.some(item=>freshIds.has(item.id)))for(const item of window)if(existing.has(item.id))affected.add(item.id)
      for(const [id,page] of existing)if(!affected.has(id))untouched.add(page.path)
      all=all.filter(item=>freshIds.has(item.id)||affected.has(item.id))
    }
    job.phase='synthesizing';await persist()
    const groups=hasCandidates?await synthesize(all,schema,inputBytes,(system,input,callSignal=signal)=>client.call('ingest',system,input,callSignal),job.synthesis??=[],persist,signal,policy.policy.wikiLanguage,policy.policy.pageGenerationConcurrency,incremental?previousKnowledge.pages.map(page=>({...page,complete:!page.coverageWarning})):[],(error,context)=>{
      recordIssue(generationDiagnostic(error,{scope:'comparison',...context}))
    })
      :incremental?all.map(item=>({type:item.type,title:item.title,identity:item.identity,aliases:item.aliases,tags:item.tags,members:[item.id],conflicts:existing.get(item.id)!.conflicts.filter(group=>group.every(id=>item.claims.some(claim=>claim.id===id)))})):[]
    job.phase='preparing-preview';await persist()
    const changedSources=new Set(records.filter(record=>record.hash!==record.committedHash).map(record=>record.id))
    const issueSources=new Set(job.diagnostics?.flatMap(issue=>issue.sourceId?[issue.sourceId]:all.filter(candidate=>issue.candidateIds?.includes(candidate.id)||candidate.claims.some(claim=>issue.claimIds?.includes(claim.id))).flatMap(candidate=>candidate.claims.map(claim=>claim.evidence.sourceId))))
    if(job.partial&&!issueSources.size)for(const record of records)issueSources.add(record.id)
    const quality=qualityLabels(policy.policy.wikiLanguage)
    const proposals:PageProposal[] = [], candidateMap = new Map(all.map(item=>[item.id,item])), links:string[] = [],knowledge:KnowledgeCatalog={version:1,pages:[],labels,...(job.partial?{quality:{complete:false,diagnostics:job.diagnostics!}}:{})}
    for(const page of previousKnowledge.pages)if(untouched.has(page.path)){
      knowledge.pages.push(page);links.push(`- [${escapeText(page.title)}](${page.path}) — ${escapeText(page.identity)}`)
    }
    const addPage = async (relative:string,title:string,metadata:Record<string,unknown>,body:string) => {
      const before = await optionalText(root,relative), content=managedDocument(rebuild?null:before,title,metadata,body)
      proposals.push({path:relative,content,expectedBefore:before === null ? null : signature(before)})
    }
    for(const group of groups) {
      const matched=group.members.map(id=>existing.get(id)).filter((page):page is KnowledgePage=>!!page)
      if(matched.length>1)throw new Error('综合建议合并多个既有页面，请先通过维护流程核对人工内容与链接：'+matched.map(page=>page.path).join('、'))
      if(!incremental&&group.members.every(id=>existing.has(id)))continue
      const suffix = signature(group.type+':'+group.title+':'+group.identity).slice(0,10)
      const name = slug(group.title), file = matched[0]?.path??`${group.type === 'entity' ? 'entities' : 'concepts'}/${policy.policy.slugCase === 'lower' ? name.toLowerCase() : name}-${suffix}.md`
      const members=group.members.map(id=>candidateMap.get(id)!),claims=members.flatMap(item=>item.claims)
      const previous=previousKnowledge.pages.find(page=>page.path===file),before=await optionalText(root,file)
      if(previous&&before!==null&&blockSignature(before)!==previous.blockHash)throw new Error('已生成区存在人工修改，请先合并后重试：'+file)
      if(previous&&before!==null&&changedSources.size&&previous.claims.every(claim=>!changedSources.has(claim.evidence.sourceId))){
        const claimKey=(claims:Claim[])=>JSON.stringify([...claims].sort((a,b)=>a.id.localeCompare(b.id)))
        const conflictKey=(conflicts:string[][])=>JSON.stringify(conflicts.map(group=>[...group].sort()).sort((a,b)=>a.join(':').localeCompare(b.join(':'))))
        if(claimKey(previous.claims)===claimKey(claims)&&conflictKey(previous.conflicts)===conflictKey(group.conflicts)){
          knowledge.pages.push(previous);links.push(`- [${escapeText(previous.title)}](${file}) — ${escapeText(previous.identity)}`);continue
        }
      }
      const inactive=new Set(sourceRecords.filter(record=>record.state!=='active').map(record=>record.id))
      const dormant=previous?.claims.filter(claim=>inactive.has(claim.evidence.sourceId))??[]
      const aliases=[...new Set([...group.aliases,...members.flatMap(item=>item.aliases),...(previous?[previous.title,...previous.aliases]:[])])].filter(alias=>alias!==group.title&&[...alias].length>=policy.policy.minAliasLength)
      const page:KnowledgePage={path:file,pageId:previous?.pageId??signature(libraryId+':page:'+file),language:policy.policy.wikiLanguage,labels,type:group.type,title:group.title,identity:group.identity,aliases,tags:[...new Set([...group.tags,...members.flatMap(item=>item.tags)])],claims:[...claims,...dormant],conflicts:[...group.conflicts,...(previous?.conflicts.filter(group=>group.some(id=>dormant.some(claim=>claim.id===id)))??[])],blockHash:'',
        ...(claims.some(claim=>issueSources.has(claim.evidence.sourceId))?{coverageWarning:quality.incomplete}:{})}
      const content=renderKnowledge(page,rebuild?null:before,sourceRecords);page.blockHash=blockSignature(content)!
      knowledge.pages.push(page);proposals.push({path:file,content,expectedBefore:before===null?null:signature(before)})
      links.push(`- [${escapeText(group.title)}](${file}) — ${escapeText(group.identity)}`)
    }
    // 部分重建保留已发布且版本仍有效的事实；缺口不能变成删除旧成果的依据。
    if(rebuild&&job.partial&&previousKnowledgeRaw)for(const old of (JSON.parse(previousKnowledgeRaw) as KnowledgeCatalog).pages){
      const retained=old.claims.filter(claim=>activeVersions.get(claim.evidence.sourceId)===claim.evidence.hash),before=rebuilding.get(old.path)
      if(!retained.length||before===undefined)continue
      if(blockSignature(before)!==old.blockHash)throw new Error('已生成区存在人工修改，请先合并后重试：'+old.path)
      let page=knowledge.pages.find(page=>page.path===old.path)
      if(!page){page={...old,claims:[],conflicts:[]};knowledge.pages.push(page);links.push(`- [${escapeText(old.title)}](${old.path}) — ${escapeText(old.identity)}`)}
      const ids=new Set(page.claims.map(claim=>claim.id));page.claims.push(...retained.filter(claim=>!ids.has(claim.id)))
      const valid=new Set(page.claims.map(claim=>claim.id)),known=new Set(page.conflicts.map(group=>[...group].sort().join(':')))
      page.conflicts.push(...old.conflicts.filter(group=>group.every(id=>valid.has(id))&&!known.has([...group].sort().join(':'))))
      page.coverageWarning=quality.incomplete
      const content=renderKnowledge(page,before,sourceRecords);page.blockHash=blockSignature(content)!
      const proposal=proposals.find(proposal=>proposal.path===page!.path)
      if(proposal)proposal.content=content;else proposals.push({path:page.path,content,expectedBefore:signature(before)})
    }
    for(const page of previousKnowledge.pages)if(!knowledge.pages.some(current=>current.path===page.path)&&page.claims.every(claim=>sourceRecords.some(record=>record.id===claim.evidence.sourceId&&record.state!=='active')))knowledge.pages.push(page)
    for(const record of records) {
      if(incremental&&previousInputs.get(record.id)?.hash===record.hash&&previousInputs.get(record.id)?.path===record.absolutePath&&!issueSources.has(record.id)&&!previousKnowledge.compilation?.incompleteSources?.includes(record.id))continue
      const claims = (incremental?knowledge.pages.flatMap(page=>page.claims):all.flatMap(item=>item.claims)).filter(item=>item.evidence.sourceId === record.id)
      const chunks = [...new Set(claims.map(item=>item.evidence.chunkId))]
      const version=(await readOptional<SourceVersion>(await safePath(root,`.llmwiki/sources/${record.id}/${record.hash}.json`)))!
      const raw=decodeSourceText(await readFile(await safePath(root,'.llmwiki/objects/'+version.snapshotObject)))
      const gallery=separateImages(raw,/\.(md|markdown)$/i.test(record.absolutePath)).images.map(image=>{
        const url=/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(image.url)?image.url:path.relative(path.join(root,'sources'),path.dirname(record.absolutePath)).replaceAll('\\','/')+'/'+image.url
        return `${/^zh(?:-|$)/i.test(policy.policy.wikiLanguage)?'第 '+image.line+' 行':labels.line+' '+image.line}${labels.image}：\n\n![${escapeText(image.alt).replaceAll(']','\\]')}](<${url.replaceAll('>','%3E')}>)`
      }).join('\n\n')
      await addPage(`sources/${record.id}.md`,record.relativePath,{type:'source',sourceId:record.id,sourceHash:record.hash,originalPath:record.absolutePath},
        `${labels.source}：${escapeText(record.absolutePath)}\n\n${labels.version}：${record.hash}\n\n` + (issueSources.has(record.id)?'> '+quality.incomplete+' ['+quality.report+'](../quality-report.md)\n\n':'') + (imageOnlySources.has(record.id)?labels.imageOnly+'\n\n':'') + chunks.map(chunk=>`<a id="${chunk}"></a>\n\n`+claims.filter(item=>item.evidence.chunkId === chunk).map(claim=>`> ${claim.evidence.image?'图像识别观察：':''}${escapeText(claim.evidence.quote)}\n\n${labels.line} ${claim.evidence.line}；${labels.offset} ${claim.evidence.originalStart}；${labels.claim}：${escapeText(claim.text)}`).join('\n\n')).join('\n\n')+(gallery?'\n\n## '+labels.originalImages+'\n\n'+gallery:''))
    }
    await addPage('index.md',library.name,{type:'index'},(job.partial?'> '+quality.incomplete+' ['+quality.report+'](quality-report.md)\n\n':'')+links.join('\n')+sourceIndex(records,labels.source))
    if(job.partial||await optionalText(root,'quality-report.md')!==null)await addPage('quality-report.md',quality.report,{type:'quality-report'},job.partial?
      job.diagnostics!.map(issue=>`<a id="${issue.id}"></a>\n\n- ${escapeText(issue.sourcePath??issue.phase)} · ${issue.kind} · ${issue.scope}${issue.start!==undefined?` · [${issue.start}, ${issue.end})`:''}${issue.line?` · ${labels.line} ${issue.line}`:''}\n\n${escapeText(issue.message)}${issue.text?'\n\n'+labels.claim+'：'+escapeText(issue.text):''}${issue.quote?'\n\n> '+escapeText(issue.quote):''}${issue.sourceId?'\n\n['+labels.source+'](sources/'+issue.sourceId+'.md)':''}`).join('\n\n'):quality.resolved)
    if(policy.policy.createWelcomeNote&&(rebuild||await optionalText(root,'welcome.md')===null))await addPage('welcome.md',labels.welcome,{type:'index'},/^zh(?:-|$)/i.test(policy.policy.wikiLanguage)?WIKI_GUIDE:labels.guide)
    if(rebuild&&!job.partial)for(const [file,raw] of rebuilding)if(!proposals.some(proposal=>proposal.path===file))proposals.push({path:file,content:null,expectedBefore:signature(raw)})
    const fileHashes=new Map(previousKnowledge.compilation?.files.map(file=>[file.path,file.hash])??[])
    for(const proposal of proposals.filter(proposal=>!proposal.area))if(proposal.content===null)fileHashes.delete(proposal.path);else fileHashes.set(proposal.path,signature(proposal.content))
    knowledge.compilation={version:1,inputKey,analysisKey:analysisFingerprint,sources:sourceRecords.map(record=>({id:record.id,hash:record.hash,path:record.absolutePath,state:record.state})),files:[...fileHashes].map(([path,hash])=>({path,hash})),...(job.partial?{incompleteSources:[...issueSources]}:{})}
    const committedSources=sourceRecords.map(record=>record.state==='active'&&!issueSources.has(record.id)?{...record,committedHash:record.hash,committedPath:record.absolutePath}:record)
    proposals.push({path:'.llmwiki/sources/catalog.json',area:'state',content:JSON.stringify(committedSources,null,2),expectedBefore:signature(catalogRaw)})
    proposals.push({path:'.llmwiki/knowledge/catalog.json',area:'state',content:JSON.stringify(knowledge,null,2),expectedBefore:previousKnowledgeRaw===null?null:signature(previousKnowledgeRaw)})
    store.assertUnchanged(registration)
    if((await store.policy(libraryId)).revision !== policy.revision) throw new Error('处理期间策略已变化，请重新生成。')
    signal.throwIfAborted()
    if(proposals.every(proposal=>proposal.content !== null && signature(proposal.content) === proposal.expectedBefore)) {
      job.status='unchanged'; await persist(); return job
    }
    const batch:ChangeSet = await new ChangeStore(store).prepare(libraryId,(rebuild?'完整重建本地 Wiki':'资料提取与跨文档综合')+(job.partial?'（部分成果，缺口'+job.diagnostics!.length+'项）':''),proposals,dependencies,signal)
    job.batchId=batch.id; job.status='preview'; await persist(); return job
  } catch(error) {
    job.status=signal.aborted ? 'cancelled' : 'failed'; job.error=error instanceof Error ? error.message : String(error)
    if(!signal.aborted)job.failure=generationDiagnostic(error,{scope:'job',phase:job.phase??'preparing'})
    try{await persist()}catch(saveError){throw new AggregateError([error,saveError],'生成及保存错误均已保留：'+job.error+'；保存失败：'+(saveError instanceof Error?saveError.message:String(saveError)))}
    throw error
  }
}
