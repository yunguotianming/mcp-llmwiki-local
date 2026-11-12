import { pageRelevance, searchConfidence } from './relevance.js'
import { layeredSettings } from '../domain/config.js'
import path from 'node:path'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { parse } from 'yaml'
import type { LibraryRegistration } from '../domain/config.js'
import type { LibraryStore } from '../storage/libraries.js'
import { safePath } from '../storage/paths.js'
import { signature, readOptional } from '../storage/files.js'
import { inspectLock } from '../storage/lock.js'
import type { SourceRecord } from '../ingest/scanner.js'
import { resolveSharedRegistration } from '../storage/manifest.js'
import type { KnowledgeCatalog } from './documents.js'
import { blockSignature,renderKnowledge } from './documents.js'
import { rankGraph } from './ranking.js'
import { separateImages } from '../ingest/markdown.js'
import { jobStorage, sqliteIndex } from '../storage/jobs.js'
import type { IndexRow } from '../storage/jobs.js'
import { terms as searchTerms } from './identity-search.js'
import type { LayeredLibrary, LayeredQuery, LayeredSearchHit, PageReadOptions, SourceReadOptions } from './layered-query.js'
import { formatVersion } from '../layered/schema.js'
import type { EmbeddingClient } from '../layered/schema.js'
import type { LayeredReadView } from '../layered/revocations.js'
import type { ModelRuntime } from '../llm/client.js'
import { understandQuery } from './query-understanding.js'
import { excerpts, fuseRanks, pageParagraphs } from './page-search.js'
import type { PageExcerpt, SearchNotice, SearchOptions } from './page-search.js'
import type { BrowseOptions } from './browse.js'
export type PageType = 'entity'|'concept'|'source'|'topic'|'term'|'term-index'|'navigation'
export interface WikiPage {library:string;path:string;type:PageType;title:string;aliases:string[];tags:string[];updated?:string;content:string;summary:string;hash:string;links:string[]}
const normalize = (text:string) => text.normalize('NFKC').replaceAll('\\','/').replace(/\.md$/i,'').toLowerCase()
const strings = (value:unknown):string[] => Array.isArray(value) ? value.filter((item):item is string=>typeof item === 'string') : typeof value === 'string' ? [value] : []
function libraryFailure(library:LibraryRegistration,error:unknown):SearchNotice {
  const reason=error instanceof Error&&'code'in error?String(error.code):error instanceof SyntaxError?'invalid-data':'library-unavailable'
  return {library:library.name,stage:'library',reason,message:reason==='EACCES'||reason==='EPERM'?'库访问被拒绝。':reason==='ENOENT'?'库文件不存在。':reason==='invalid-data'?'库数据格式损坏。':'库读取或检索失败，请检查库状态。'}
}
// 文件 IO 分批并行，按原顺序收集结果；失败也等本批读取结束，避免遗留读取跨过调用边界。
async function mapInBatches<T,R>(items:readonly T[],action:(item:T)=>Promise<R>):Promise<R[]>{
  const values:R[]=[]
  for(let offset=0;offset<items.length;offset+=8){
    const batch=await Promise.allSettled(items.slice(offset,offset+8).map(action))
    for(const result of batch){if(result.status==='rejected')throw result.reason;values.push(result.value)}
  }
  return values
}
export async function findLayeredLibrary(wikiPath:string):Promise<LayeredLibrary|undefined>{
  // 同时兼容登记资料根和直接登记成果根；旧库不加载分层检索及建库依赖。
  for(const relative of ['.llmwiki/library.yaml','library.yaml']){
    let raw:string
    try{raw=await readFile(await safePath(wikiPath,relative),'utf8')}
    catch(error){if(error instanceof Error&&'code'in error&&error.code==='ENOENT')continue;throw error}
    let card:LayeredLibrary['card']
    try{card=parse(raw) as LayeredLibrary['card']}catch{continue}
    if(card?.format_version===formatVersion)return {root:path.dirname(await safePath(wikiPath,relative)),card}
    if(card?.format_version!==undefined)throw new Error('旧分层库格式不兼容，请重建；原有数据已保留。')
  }
  return undefined
}
function parsePage(library:string,relative:string,raw:string,strictMetadata:boolean) {
  const match=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)
  let metadata:Record<string,unknown>={}
  if(match) {
    try { const value:unknown=parse(match[1]!);if(value && typeof value === 'object' && !Array.isArray(value))metadata=value as Record<string,unknown> }
    catch(error) { if(strictMetadata)throw new Error('Wiki 页面的 YAML 属性无效，请核对后重试：'+relative,{cause:error}) }
  }
  const content=match ? raw.slice(match[0].length).trimStart() : raw,searchContent=separateImages(content).text
  const title=typeof metadata.title === 'string' ? metadata.title : /^#\s+(.+)$/m.exec(content)?.[1] ?? path.basename(relative,'.md')
  const links=[...content.matchAll(/\[\[([^\]|#]+)(?:[^\]]*)\]\]/g)].map(item=>item[1]!)
  for(const match of content.matchAll(/\]\(([^\s)#]+)(?:#[^)]*)?\)/g)) if(!/^[a-z]+:/.test(match[1]!)) links.push(path.posix.normalize(path.posix.join(path.posix.dirname(relative),match[1]!)))
  const page:WikiPage={library,path:relative,type:relative.startsWith('entities/')?'entity':relative.startsWith('concepts/')?'concept':'source',title,aliases:strings(metadata.aliases),tags:strings(metadata.tags),
    ...(typeof metadata.updated === 'string' ? {updated:metadata.updated} : {}),content,summary:searchContent.replace(/<!--[^]*?-->/g,'').replace(/^#+\s*/gm,'').replace(/\s+/g,' ').slice(0,240),hash:signature(raw),links}
  return {page,metadata}
}
export class WikiQuery {
  private layered:LayeredQuery|undefined
  constructor(private readonly store:LibraryStore,private readonly embeddingClient?:EmbeddingClient,private readonly runtime?:()=>ModelRuntime|undefined) {}
  private async layeredQuery():Promise<LayeredQuery>{
    return this.layered??=new (await import('./layered-query.js')).LayeredQuery(this.embeddingClient)
  }
  private async consistent<T>(action:(views:LayeredReadView[])=>Promise<T>,signal?:AbortSignal):Promise<T>{
    for(;;){
      signal?.throwIfAborted()
      const views:LayeredReadView[]=[],result=await action(views)
      let unchanged=true
      // 多库合并后再复核，避免查询后一个库期间撤权的前一个库泄漏旧摘要。
      for(const view of views) {
        try { if(!await view.unchanged())unchanged=false }
        catch { signal?.throwIfAborted();unchanged=false }
      }
      signal?.throwIfAborted()
      if(unchanged)return result
    }
  }
  private async indexed(library:LibraryRegistration,signal?:AbortSignal):Promise<WikiPage[]|undefined>{
    // 只读/共管沿用原读取协议；SQLite 索引只在已明确切换的独立库中更新。
    if(library.kind!=='local'||library.mode!=='managed')return undefined
    const root=await this.store.root(library.id)
    if(!await jobStorage(root))return undefined
    const marker=async()=>JSON.stringify([await inspectLock(root),await readOptional(await safePath(root,'.llmwiki/coordination/generation.json')),await readOptional(await safePath(root,'.llmwiki/coordination/recovery.json'))])
    const before=await marker(),status=JSON.parse(before)
    if(status[0]||status[2])throw new Error('Wiki 正在写入或等待恢复，请稍后查询：'+library.name)
    const records=await readOptional<SourceRecord[]>(await safePath(root,'.llmwiki/sources/catalog.json'))??[],knowledge=await readOptional<KnowledgeCatalog>(await safePath(root,'.llmwiki/knowledge/catalog.json'))
    const revision=signature(JSON.stringify([records,knowledge?.pages.map(page=>[page.path,page.blockHash])]))
    const current=await sqliteIndex<{path:string;stamp:string;data:string}[]>(root,'index-read'),previous=new Map(current.map(item=>[item.path,item])),seen=new Set<string>(),updates:IndexRow[]=[],pages:WikiPage[]=[]
    const active=new Map(records.filter(record=>record.state==='active').map(record=>[record.id,record.hash])),known=new Map(knowledge?.pages.map(page=>[page.path,page]))
    const walk=async(relative:string):Promise<void>=>{
      signal?.throwIfAborted()
      let entries
      try{entries=await readdir(await safePath(root,relative),{withFileTypes:true})}catch(error){if(error instanceof Error&&'code'in error&&error.code==='ENOENT')return;throw error}
      for(const entry of entries){
        signal?.throwIfAborted();if(entry.isSymbolicLink())continue
        const child=relative+'/'+entry.name
        if(entry.isDirectory()){await walk(child);continue}
        if(!entry.isFile()||!/\.md$/i.test(entry.name))continue
        const file=await safePath(root,child),info=await stat(file),knownPage=known.get(child),source=records.find(record=>child==='sources/'+record.id+'.md')
        const stamp=JSON.stringify([info.size,info.mtimeMs,info.ctimeMs,library.name,'terms-v1',knownPage?.blockHash,
          knownPage?.claims.map(claim=>[claim.evidence.sourceId,active.get(claim.evidence.sourceId)]),source?[source.state,source.hash]:null]),old=previous.get(child)
        seen.add(child)
        if(old?.stamp===stamp){pages.push({...JSON.parse(old.data),content:'',summary:'',links:[]} as WikiPage);continue}
        const raw=await readFile(file,'utf8'),page=known.get(child)
        if(page&&blockSignature(raw)!==page.blockHash)throw new Error('已生成区发生人工修改，请先核对合并：'+child)
        const view=page?renderKnowledge(page,raw,records):raw,parsed=parsePage(library.name,child,view,!!knowledge||records.length>0)
        if(parsed.metadata.llmwikiNoActiveEvidence===true||parsed.page.type==='source'&&records.some(record=>record.id===String(parsed.metadata.sourceId)&&active.get(record.id)!==String(parsed.metadata.sourceHash))||knowledge&&parsed.page.type!=='source'&&raw.includes('<!-- llmwiki:begin v1 -->')&&!page){seen.delete(child);continue}
        parsed.page.hash=signature(raw)
        const indexed={...parsed.page,content:''}, {content:_content,summary:_summary,links:_links,...metadata}=indexed
        updates.push({path:child,stamp,data:JSON.stringify(metadata),title:[...searchTerms(indexed.title)].join(' '),aliases:[...searchTerms(indexed.aliases.join(' '))].join(' '),identity:[...searchTerms(page?.identity??'')].join(' '),body:[...searchTerms(separateImages(parsed.page.content).text)].join(' ')})
        pages.push(indexed)
        const after=await stat(file)
        if(info.size!==after.size||info.mtimeMs!==after.mtimeMs||info.ctimeMs!==after.ctimeMs)throw new Error('Wiki 在建立索引期间变化，请重试。')
      }
    }
    for(const folder of ['entities','concepts','sources'])await walk(folder)
    const removed=current.filter(item=>!seen.has(item.path)).map(item=>item.path)
    if(before!==await marker())throw new Error('Wiki 版本在索引期间变化，请重试。')
    const latestRecords=await readOptional<SourceRecord[]>(await safePath(root,'.llmwiki/sources/catalog.json'))??[],latestKnowledge=await readOptional<KnowledgeCatalog>(await safePath(root,'.llmwiki/knowledge/catalog.json'))
    if(revision!==signature(JSON.stringify([latestRecords,latestKnowledge?.pages.map(page=>[page.path,page.blockHash])])))throw new Error('来源或知识清单在建立索引时变化，请重试。')
    if(updates.length||removed.length)await sqliteIndex(root,'index-save',{pages:updates,removed})
    if(before!==await marker())throw new Error('Wiki 版本在索引提交期间变化，请重试。')
    this.store.assertUnchanged(library)
    return pages
  }
  async libraries(name?:string,onFailure?:(library:LibraryRegistration,error:unknown)=>void):Promise<LibraryRegistration[]> {
    const registrations=this.store.snapshot().libraries.filter(item=>item.enabled && item.kind !== 'whalefall')
    const resolved=await Promise.allSettled(registrations.map(resolveSharedRegistration)),filtered:LibraryRegistration[]=[]
    let failed=false
    for(const [index,result] of resolved.entries()) {
      const registration=registrations[index]!
      try {
        if(result.status==='rejected')throw result.reason
        const library=result.value
        if(!library||name&&normalize(library.name)!==normalize(name))continue
        if(library.siyuan){
          const layered=await findLayeredLibrary(library.wikiPath)
          if(!layered||layered.card.origin_type!=='siyuan')throw new Error('思源库尚未发布或库卡片不匹配，拒绝读取。')
        }
        filtered.push(library)
      } catch(error) {
        if(!onFailure)throw error
        if(!name||normalize(registration.name)===normalize(name)){onFailure(registration,error);failed=true}
      }
    }
    if(name && !filtered.length&&!failed)throw new Error('未找到已启用本地 Wiki：'+name)
    return filtered
  }
  async pages(library:LibraryRegistration,signal?:AbortSignal):Promise<WikiPage[]> {
    if(library.siyuan)throw new Error('思源库必须通过分层查询核对准入。')
    const registration=this.store.registration(library.id)
    const root=await realpath(library.wikiPath)
    const marker=async()=>JSON.stringify([await inspectLock(root),await readOptional(await safePath(root,'.llmwiki/coordination/generation.json')),
      await readOptional(await safePath(root,'.llmwiki/coordination/recovery.json'))])
    const before=await marker()
    const status=JSON.parse(before)
    if(status[0] || status[2])throw new Error('Wiki 正在写入或等待恢复，请稍后查询：'+library.name)
    const catalogPath=await safePath(root,'.llmwiki/sources/catalog.json')
    const records=await readOptional<SourceRecord[]>(catalogPath),catalogHash=records ? signature(JSON.stringify(records)) : null
    const inactive=new Set(records?.filter(record=>record.state!=='active').map(record=>record.id)),pages:WikiPage[]=[],directories=new Map<string,string>()
    const knowledge=await readOptional<KnowledgeCatalog>(await safePath(root,'.llmwiki/knowledge/catalog.json'))
    const knowledgeHash=knowledge?signature(JSON.stringify(knowledge)):null
    const walk=async(relative:string):Promise<WikiPage[]>=>{
      signal?.throwIfAborted()
      let entries
      try{entries=await readdir(await safePath(root,relative),{withFileTypes:true})}
      catch(error){if(error instanceof Error && 'code' in error && error.code==='ENOENT'){directories.set(relative,'missing');return []}throw error}
      directories.set(relative,JSON.stringify(entries.map(entry=>entry.name).sort()))
      return (await mapInBatches(entries,async entry=>{
        signal?.throwIfAborted();if(entry.isSymbolicLink())return []
        const child=relative+'/'+entry.name
        if(entry.isDirectory())return walk(child)
        if(!entry.isFile()||!entry.name.toLowerCase().endsWith('.md'))return []
        const file=await safePath(root,child),raw=await readFile(file,'utf8'),known=knowledge?.pages.find(page=>page.path===child)
        if(known&&blockSignature(raw)!==known.blockHash)throw new Error('已生成区发生人工修改，请先核对合并：'+child)
        const view=known&&records?renderKnowledge(known,raw,records):raw,{page,metadata}=parsePage(library.name,child,view,!!records||!!knowledge)
        page.hash=signature(raw)
        if(metadata && (metadata.llmwikiNoActiveEvidence===true || inactive.has(String(metadata.sourceId)) || strings(metadata.sources).some(source=>inactive.has(source))))return []
        if(knowledge&&page.type!=='source'&&raw.includes('<!-- llmwiki:begin v1 -->')&&!knowledge.pages.some(item=>item.path===child))return []
        return [page]
      })).flat()
    }
    for(const folder of ['entities','concepts','sources'])pages.push(...await walk(folder))
    // 页面正文变化也使一致视图失效；不只依赖 index.md 或 TTL。
    await mapInBatches(pages,async page=>{if(signature(await readFile(await safePath(root,page.path)))!==page.hash)throw new Error('Wiki 在读取期间变化，请重试。')})
    await mapInBatches([...directories],async ([relative,mark])=>{
      let current:string
      try{current=JSON.stringify((await readdir(await safePath(root,relative))).sort())}
      catch(error){if(error instanceof Error && 'code' in error && error.code==='ENOENT')current='missing';else throw error}
      if(current!==mark)throw new Error('Wiki 目录在读取期间变化，请重试。')
    })
    const latestRecords=await readOptional<SourceRecord[]>(catalogPath)
    const latestKnowledge=await readOptional<KnowledgeCatalog>(await safePath(root,'.llmwiki/knowledge/catalog.json'))
    if(knowledgeHash!==(latestKnowledge?signature(JSON.stringify(latestKnowledge)):null))throw new Error('Wiki 知识清单在读取期间变化，请重试。')
    if(before!==await marker() || catalogHash !== (latestRecords ? signature(JSON.stringify(latestRecords)) : null)) throw new Error('Wiki 版本在读取期间变化，请重试。')
    this.store.assertUnchanged(registration)
    if(JSON.stringify(await resolveSharedRegistration(registration))!==JSON.stringify(library))throw new Error('Vault 共享清单已变化，请重试查询。')
    return pages
  }
  async catalog(signal?:AbortSignal) {
    return this.consistent(async views=>{
    const libraries=[]
    for(const library of await this.libraries()) {
      signal?.throwIfAborted()
      const layered=await findLayeredLibrary(library.wikiPath)
      if(layered){const result=await (await this.layeredQuery()).catalog(library,layered,signal);this.store.assertUnchanged(library);views.push(result.view);libraries.push(result.value);continue}
      let pages:WikiPage[]
      try {pages=await this.pages(library,signal)}catch(error){if(error instanceof Error && 'code' in error && error.code==='ENOENT')continue;throw error}
      libraries.push({libraryId:library.id,name:library.name,description:library.description,path:library.wikiPath,pageCount:pages.length,mode:library.mode})
    }
    return {libraries}
    },signal)
  }
  async search(query:string,name?:string,types?:string[],limit=8,signal?:AbortSignal,options:SearchOptions={}) {
    query=query.trim();if(!query)throw new Error('查询不能为空。')
    if (!Number.isSafeInteger(limit) || limit < 1) throw new Error('检索条数必须为正整数。')
    limit=Math.min(20,limit)
    const budget=options.excerpt_budget??4000,pageCount=options.excerpt_pages??3
    if (!Number.isSafeInteger(budget)||budget<0||budget>6000||!Number.isSafeInteger(pageCount)||pageCount<0||pageCount>20||options.include!==undefined&&!['hits','excerpts'].includes(options.include)) throw new Error('摘录预算为 0～6000，页数为 0～20。')
    const registrationFailures:SearchNotice[]=[]
    const isolate=this.store.snapshot().libraries.filter(item=>item.enabled&&item.kind!=='whalefall').length>1
    const selected=await this.libraries(name,isolate?(library,error)=>{signal?.throwIfAborted();if(error instanceof Error&&error.name==='AbortError')throw error;registrationFailures.push(libraryFailure(library,error))}:undefined),owner=selected.find(library=>library.id===this.store.snapshot().activeLibraryId)??selected[0]
    const understanding=await understandQuery(query,options.variants,owner,this.runtime?.(),signal)
    const queries=[query,...understanding.variants]
    return this.consistent(async views=>{
    const hits:{libraryId:string;page:WikiPage;score:number;layered?:LayeredSearchHit;score_channels?:Record<string,number>}[]=[],searchedLibraries:string[]=[],skippedLibraries=registrationFailures.map(notice=>notice.library)
    const searchedGroups:{libraryId:string;library:string}[]=[]
    const legacyQuotes=new Map<WikiPage,PageExcerpt[]>()
    const degradations: SearchNotice[] = [...registrationFailures,...understanding.notice?[understanding.notice]:[]]
    let remainingBudget=budget,remainingPages=pageCount
    for(const library of selected) {
      signal?.throwIfAborted()
      const mark={hits:hits.length,groups:searchedGroups.length,libraries:searchedLibraries.length,views:views.length,budget:remainingBudget,pages:remainingPages}
      try {
      const layered=await findLayeredLibrary(library.wikiPath)
      if(layered){
        const result=await (await this.layeredQuery()).search(library,layered,query,types,signal,{...options,limit,variants:understanding.variants,excerpt_budget:remainingBudget,excerpt_pages:Math.min(remainingPages,limit)})
        if(result.degradation)degradations.push(result.degradation)
        degradations.push(...result.notices)
        this.store.assertUnchanged(library);views.push(result.view);searchedLibraries.push(library.name)
        searchedGroups.push({libraryId:library.id,library:library.name})
        for(const hit of result.value){
          hits.push({libraryId:library.id,page:{...hit,content:'',hash:'',links:[]},score:hit.score,layered:hit})
          if(hit.excerpts.length){remainingPages--;remainingBudget-=hit.excerpts.reduce((sum,item)=>sum+item.tokens,0)}
        }
        continue
      }
      let pages:WikiPage[]
      let indexed:WikiPage[]|undefined
      indexed=await this.indexed(library,signal);pages=indexed??await this.pages(library,signal)
      searchedLibraries.push(library.name)
      searchedGroups.push({libraryId:library.id,library:library.name})
      if(indexed){
        const root=await this.store.root(library.id),catalog=await readOptional<KnowledgeCatalog>(await safePath(root,'.llmwiki/knowledge/catalog.json')),records=await readOptional<SourceRecord[]>(await safePath(root,'.llmwiki/sources/catalog.json'))??[]
        const fresh:WikiPage[]=[]
        for(const page of pages){
          const raw=await readFile(await safePath(root,page.path),'utf8')
          if(signature(raw)!==page.hash){
            await sqliteIndex(root,'index-save',{removed:[page.path]})
            degradations.push({library:library.name,stage:'index',reason:'stale-index',message:'页面索引哈希已过期，已跳过；下次查询前重建：'+page.path});continue
          }
          const known=catalog?.pages.find(item=>item.path===page.path)
          fresh.push(parsePage(library.name,page.path,known?renderKnowledge(known,raw,records):raw,true).page)
        }
        pages=fresh
      }
      const ranks:{paths:string[];weight:number;channel:string}[]=[],primary=new Map<string,number>()
      for(const [queryIndex,input] of queries.entries()){
      const terms=[...new Set(normalize(input).split(/[\s,，。；;]+/).filter(Boolean))]
      if(terms.length===1 && /[\p{Script=Han}]/u.test(input))for(let index=0;index<input.length-1;index++)terms.push(input.slice(index,index+2).toLowerCase())
      const scores=new Map<WikiPage,number>()
      const fts=indexed?new Map((await sqliteIndex<{path:string;score:number}[]>(await this.store.root(library.id),'index-search',{query:[...searchTerms(input)].slice(0,64).map(term=>'"'+term.replaceAll('"','""')+'"').join(' OR ')})).map(item=>[item.path,item.score])):undefined
      for(const page of pages){
        const title=normalize(page.title),aliases=page.aliases.map(normalize),body=normalize(separateImages(page.content).text)
        let score=title===normalize(input)||aliases.includes(normalize(input))?20:0
        for(const term of terms)score+=(title.includes(term)?6:0)+(aliases.some(alias=>alias.includes(term))?4:0)+(body.includes(term)?1:0)
        score+=fts?.get(page.path)??0
        if(score>0)scores.set(page,score)
      }
      const nodes=pages.map(page=>({...page,references:[page.path,path.posix.basename(page.path),page.title,...page.aliases]}))
      const byPath=new Map([...scores].map(([page,score])=>[page.path,score]))
      const seeds=new Map(nodes.filter(node=>byPath.has(node.path)).map(node=>[node,byPath.get(node.path)!]))
      const ranked=[...rankGraph(nodes,seeds)].filter(([page])=>!types?.length||types.includes(page.type)).sort(([a,x],[b,y])=>y-x||a.path.localeCompare(b.path))
      if(!queryIndex)for(const [page,score] of ranked)primary.set(page.path,score)
      ranks.push({paths:ranked.map(([page])=>page.path),weight:queryIndex?0.5:1,channel:queryIndex?'variant'+queryIndex:'original'})
      }
      const fused=fuseRanks(ranks)
      const ranked=pages.filter(page=>fused.has(page.path)).map(page=>({page,score:queries.length>1?fused.get(page.path)!.score:primary.get(page.path)!,score_channels:fused.get(page.path)!.score_channels})).sort((a,b)=>b.score-a.score||a.page.path.localeCompare(b.page.path)).slice(0,limit)
      for(const hit of ranked){
        if(options.include!=='hits'&&remainingPages>0&&remainingBudget>0){
          const quotes=excerpts(hit.page,queries,Math.floor(remainingBudget/Math.min(remainingPages,ranked.length-ranked.indexOf(hit))))
          legacyQuotes.set(hit.page,quotes);if(quotes.length)remainingPages--;remainingBudget-=quotes.reduce((sum,item)=>sum+item.tokens,0)
        }
        hits.push({libraryId:library.id,...hit})
      }
      } catch(error) {
        signal?.throwIfAborted()
        if(error instanceof Error&&error.name==='AbortError')throw error
        const notice=libraryFailure(library,error)
        if(!isolate&&notice.reason!=='ENOENT')throw error
        // 整库失败时撤回该库已加入的结果及预算，其他库照常完成。
        hits.length=mark.hits;searchedGroups.length=mark.groups;searchedLibraries.length=mark.libraries;views.length=mark.views
        remainingBudget=mark.budget;remainingPages=mark.pages
        skippedLibraries.push(library.name)
        degradations.push(notice)
      }
    }
    const groups=searchedGroups.map(group=>({...group,results:hits.filter(hit=>hit.libraryId===group.libraryId).sort((a,b)=>b.score-a.score||a.page.path.localeCompare(b.page.path)).slice(0,limit).map(({page,score,layered,score_channels})=>{
      if(layered)return layered
      const block=pageParagraphs(page.content,queries)[0]
      return {library:page.library,path:page.path,type:page.type,title:page.title,aliases:page.aliases,summary:page.summary,score,relevance:pageRelevance(query,{...page,snippet:(block?.content??'').slice(0,300)}),snippet:(block?.content??'').slice(0,300),anchor:block?.anchor??'',page_ref:page.path,topic_path:'',excerpts:legacyQuotes.get(page)??[],score_channels:score_channels??{}}
    })}))
    const confidentGroups=groups.map(group=>({...group,...searchConfidence(group.results,layeredSettings(selected.find(library=>library.id===group.libraryId)?.layered).searchRelevanceThreshold)}))
    // 各库先完成自己的通道融合，跨库只比较名次，避免不同空间或通道数的分数互比。
    const results=groups.length > 1 ? groups.flatMap(group=>group.results.map((hit,index)=>({...hit,score:1/(60+index+1)})))
      .sort((a,b)=>b.score-a.score||a.library.localeCompare(b.library)||a.path.localeCompare(b.path)) : groups[0]?.results ?? []
    const confidence: 'none' | 'high' | 'low'=!results.length?'none':confidentGroups.some(group=>group.confidence==='high')?'high':'low'
    return {query,total:results.length,results,groups:confidentGroups,confidence,...(confidence!=='high'?{message:'未找到可信匹配；候选页仅供继续检索，请勿据此断言库中有答案。'}:{}),understanding,searchedLibraries,...(skippedLibraries.length?{skippedLibraries}:{}),...(degradations.length?{degradations}:{})}
    },signal)
  }
  async browse(name:string,ref='root',options:BrowseOptions={},signal?:AbortSignal){
    return this.consistent(async views=>{
      const library=(await this.libraries(name))[0]!,layered=await findLayeredLibrary(library.wikiPath)
      if(!layered)throw new Error('分层浏览只支持已发布的分层库。')
      const result=await (await this.layeredQuery()).browse(library,layered,ref,options,signal)
      this.store.assertUnchanged(library);views.push(result.view);return result.value
    },signal)
  }
  async read(ref:string,name?:string,maxChars=this.store.snapshot().readMaxChars,signal?:AbortSignal,options:PageReadOptions={}) {
    return this.consistent(async views=>{
    const requested=normalize(ref).replace(/\/$/,'')
    for(const library of await this.libraries(name)){
      signal?.throwIfAborted()
      const layered=await findLayeredLibrary(library.wikiPath)
      if(layered){
        try{
          const result=await (await this.layeredQuery()).read(library,layered,ref,maxChars,{...options,signal})
          this.store.assertUnchanged(library);views.push(result.view)
          if(result.value)return result.value
        }catch(error){if(!(error instanceof Error&&'code'in error&&error.code==='ENOENT'))throw error}
        continue
      }
      let pages:WikiPage[]
      let indexed:WikiPage[]|undefined
      try{indexed=await this.indexed(library,signal);pages=indexed??await this.pages(library,signal)}catch(error){if(error instanceof Error && 'code' in error && error.code==='ENOENT')continue;throw error}
      const page=pages.find(page=>[page.path,path.posix.basename(page.path),page.title,...page.aliases].some(value=>normalize(value)===requested))
      if(!page)continue
      if(indexed){
        const root=await this.store.root(library.id),raw=await readFile(await safePath(root,page.path),'utf8')
        if(signature(raw)!==page.hash)throw new Error('Wiki 页面在索引后变化，请重试。')
        const catalog=await readOptional<KnowledgeCatalog>(await safePath(root,'.llmwiki/knowledge/catalog.json')),records=await readOptional<SourceRecord[]>(await safePath(root,'.llmwiki/sources/catalog.json'))??[],known=catalog?.pages.find(item=>item.path===page.path)
        page.content=parsePage(library.name,page.path,known?renderKnowledge(known,raw,records):raw,true).page.content
      }
      const max=Math.min(100000,Math.max(200,Math.trunc(maxChars))),{hash:_hash,summary:_summary,links:_links,...value}=page
      const content=separateImages(page.content).text
      return {...value,content:content.slice(0,max),truncated:content.length>max}
    }
    throw new Error('未找到 Wiki 页面。请先检索并使用返回的 library 与 path。')
    },signal)
  }
  async sourceRead(sourceId:string,locator:string,name:string,options:SourceReadOptions={}){
    const library=this.store.snapshot().libraries.find(item=>item.enabled&&normalize(item.name)===normalize(name))
    if(!library)throw new Error('未找到已启用 Wiki：'+name)
    this.store.registration(library.id)
    if(library.kind==='whalefall'||library.siyuan)return {library:library.name,sourceId,locator,status:'external' as const,content:'请走 keeper_notes 回源',truncated:false,next_offset:null}
    const layered=await findLayeredLibrary(library.wikiPath)
    if(!layered)throw new Error('原文工具只支持已登记的分层库。')
    const result=await (await this.layeredQuery()).source(library,layered,sourceId,locator,options.maxChars??this.store.snapshot().readMaxChars,options)
    this.store.assertUnchanged(library)
    return result
  }
}
