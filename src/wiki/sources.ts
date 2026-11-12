import { randomUUID } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { LibraryStore } from '../storage/libraries.js'
import { ChangeStore, directoryRevision } from '../storage/changes.js'
import type { Dependency, PageProposal } from '../storage/changes.js'
import { safePath } from '../storage/paths.js'
import { readOptional,signature } from '../storage/files.js'
import { inspectLock } from '../storage/lock.js'
import type { SourceRecord } from '../ingest/scanner.js'
import { blockSignature,escapeText,renderKnowledge,sourceIndex,utilityDocument } from './documents.js'
import type { KnowledgeCatalog } from './documents.js'
async function optionalText(root:string,relative:string):Promise<string|null> {
  try{return await readFile(await safePath(root,relative),'utf8')}catch(error){if(error instanceof Error&&'code'in error&&error.code==='ENOENT')return null;throw error}
}
export async function listSources(store:LibraryStore,libraryId:string):Promise<SourceRecord[]> {
  const root=await store.root(libraryId)
  return await readOptional<SourceRecord[]>(await safePath(root,'.llmwiki/sources/catalog.json'))??[]
}
export async function prepareSourceState(store:LibraryStore,libraryId:string,sourceIds:string[],target:'active'|'withdrawn',archiveUnused=false,signal?:AbortSignal) {
  signal?.throwIfAborted()
  const library=store.registration(libraryId)
  if(archiveUnused&&target!=='withdrawn')throw new Error('归档只适用于撤出操作。')
  const root=await store.root(libraryId,true),sourceRaw=await readFile(await safePath(root,'.llmwiki/sources/catalog.json'),'utf8')
  const records=JSON.parse(sourceRaw) as SourceRecord[],selected=new Set(sourceIds)
  const previousRecords=structuredClone(records),stamp=new Date().toISOString().replaceAll(':','-')+'-'+randomUUID()
  if(!selected.size||sourceIds.length!==selected.size||sourceIds.some(id=>!records.some(record=>record.id===id)))throw new Error('请选择有效且不重复的来源。')
  for(const record of records)if(selected.has(record.id)) {
    signal?.throwIfAborted()
    if(target==='active') {
      // 恢复活动状态须绑定已扫描版本；原文已变时先扫描再生成。
      if(signature(await readFile(record.absolutePath))!==record.hash)throw new Error('来源已变化，请先扫描后核对恢复：'+record.relativePath)
    }
    record.state=target
  }
  const knowledgeRaw=await optionalText(root,'.llmwiki/knowledge/catalog.json'),knowledge:KnowledgeCatalog=knowledgeRaw===null?{version:1,pages:[]}:JSON.parse(knowledgeRaw)
  const proposals:PageProposal[]=[],archived=new Set<string>()
  const active=new Map(records.filter(record=>record.state==='active').map(record=>[record.id,record.hash]))
  for(const page of knowledge.pages)if(page.claims.some(claim=>selected.has(claim.evidence.sourceId))) {
    signal?.throwIfAborted()
    const current=await readFile(await safePath(root,page.path),'utf8')
    if(blockSignature(current)!==page.blockHash)throw new Error('已生成区存在人工修改，请先合并后重试：'+page.path)
    // 只移动与生成模板完全一致、且已无活动依据的页面；人工内容始终留在原位置。
    if(archiveUnused&&!page.claims.some(claim=>active.get(claim.evidence.sourceId)===claim.evidence.hash)&&current===renderKnowledge(page,null,previousRecords)) {
      const archivePath=`archive/withdrawn/${stamp}/${page.path}`
      proposals.push({path:archivePath,content:renderKnowledge(page,current,records,{includeInactive:true,sourcePrefix:path.posix.relative(path.posix.dirname(archivePath),'sources')}),expectedBefore:null},
        {path:page.path,content:null,expectedBefore:signature(current)})
      archived.add(page.path);continue
    }
    const content=renderKnowledge(page,current,records);page.blockHash=blockSignature(content)!
    proposals.push({path:page.path,content,expectedBefore:signature(current)})
  }
  knowledge.pages=knowledge.pages.filter(page=>!archived.has(page.path))
  if(knowledgeRaw!==null){
    const index=await optionalText(root,'index.md')
    const links=knowledge.pages.filter(page=>page.claims.some(claim=>active.get(claim.evidence.sourceId)===claim.evidence.hash))
      .map(page=>`- [${escapeText(page.title).replaceAll('[','\\[').replaceAll(']','\\]')}](${page.path.split('/').map(encodeURIComponent).join('/')})`)
    proposals.push({path:'index.md',content:utilityDocument(index,library.name,(links.join('\n')||'当前没有活动知识页面。')+sourceIndex(records.filter(record=>record.state==='active'&&record.committedHash===record.hash))),expectedBefore:index===null?null:signature(index)},
      {path:'.llmwiki/knowledge/catalog.json',area:'state',content:JSON.stringify(knowledge,null,2),expectedBefore:signature(knowledgeRaw)})
  }
  proposals.push({path:'.llmwiki/sources/catalog.json',area:'state',content:JSON.stringify(records,null,2),expectedBefore:signature(sourceRaw)})
  const dependencies=target==='active'?records.filter(record=>selected.has(record.id)).map(record=>({path:record.absolutePath,hash:record.hash,source:true as const})):[]
  store.assertUnchanged(library)
  return await new ChangeStore(store).prepare(libraryId,target==='withdrawn'?archiveUnused?'撤出来源并归档无活动依据的生成页':'撤出来源并更新受影响知识':'恢复来源活动状态',proposals,dependencies,signal)
}

export interface ArchiveView { revision: string; files: { path: string; bytes: number }[] }
async function archiveSnapshot(store:LibraryStore,libraryId:string,signal?:AbortSignal) {
  signal?.throwIfAborted()
  const library=store.registration(libraryId),root=await store.root(libraryId),files:{path:string;raw:string}[]=[],dependencies:Dependency[]=[]
  const marker=async()=>JSON.stringify([await inspectLock(root),await readOptional(await safePath(root,'.llmwiki/coordination/recovery.json')),await readOptional(await safePath(root,'.llmwiki/coordination/generation.json'))])
  const before=await marker(),status=JSON.parse(before)
  if(status[0]||status[1])throw new Error('Wiki 正在写入或等待恢复，请稍后读取归档。')
  const walk=async(relative:string):Promise<void>=>{
    signal?.throwIfAborted()
    const hash=await directoryRevision(root,relative);dependencies.push({path:relative,hash,directory:true})
    if(hash===null)return
    for(const entry of await readdir(await safePath(root,relative),{withFileTypes:true})) {
      signal?.throwIfAborted()
      if(entry.isSymbolicLink())continue
      const child=relative+'/'+entry.name
      if(entry.isDirectory())await walk(child)
      else if(entry.isFile()&&/\.md$/i.test(entry.name)){
        const raw=await readFile(await safePath(root,child),'utf8');files.push({path:child,raw});dependencies.push({path:child,hash:signature(raw)})
      }
    }
  }
  await walk('archive/withdrawn')
  files.sort((a,b)=>a.path.localeCompare(b.path));dependencies.sort((a,b)=>a.path.localeCompare(b.path))
  for(const dependency of dependencies) {
    signal?.throwIfAborted()
    const hash=dependency.directory?await directoryRevision(root,dependency.path):signature(await readFile(await safePath(root,dependency.path)))
    if(hash!==dependency.hash)throw new Error('归档在读取期间发生变化，请刷新后重试。')
  }
  if(before!==await marker())throw new Error('Wiki 版本在读取归档期间变化，请刷新后重试。')
  store.assertUnchanged(library)
  return {library,files,dependencies,revision:signature(JSON.stringify([library,dependencies]))}
}
export async function listArchive(store:LibraryStore,libraryId:string,signal?:AbortSignal):Promise<ArchiveView> {
  const state=await archiveSnapshot(store,libraryId,signal)
  return {revision:state.revision,files:state.files.map(file=>({path:file.path,bytes:Buffer.byteLength(file.raw)}))}
}
export async function prepareArchiveCleanup(store:LibraryStore,libraryId:string,revision:string,signal?:AbortSignal) {
  await store.root(libraryId,true)
  const state=await archiveSnapshot(store,libraryId,signal)
  if(state.revision!==revision)throw new Error('归档已变化，请刷新清单后重新预览。')
  store.assertUnchanged(state.library)
  return await new ChangeStore(store).prepare(libraryId,'清理撤出归档文件（保留批次恢复对象）',state.files.map(file=>({path:file.path,content:null,expectedBefore:signature(file.raw)})),state.dependencies,signal)
}
