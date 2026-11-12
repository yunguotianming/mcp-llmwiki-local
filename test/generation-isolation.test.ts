import { cp,mkdir,readFile,writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll,afterEach,beforeAll,describe,expect,it,vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { emptyRegistry,newLibrary,type LibraryRegistration } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { generateWiki,listGenerateJobs } from '../src/wiki/generation.js'
import { scanLibrary } from '../src/ingest/scanner.js'
import { ChangeStore } from '../src/storage/changes.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { temporaryWorkspace } from './temp.js'
import { groupingResponse } from './synthesis-fixture.js'
import { mockFixtureSync,restoreFixture,snapshotFixture,type FixtureSnapshot } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => vi.restoreAllMocks())

const snapshots=new WeakMap<object,FixtureSnapshot>()
async function fixture(seed?:{source:string;wiki:string;library:LibraryRegistration}){
  const temp=await temporaryWorkspace(),source=seed?.source??path.join(temp.root,'source'),wiki=path.join(temp.root,'wiki')
  mockFixtureSync(temp.root)
  const library=seed?structuredClone(seed.library):newLibrary('isolation');library.sourceRoots=[source];library.wikiPath=wiki;library.models.unified={provider:'fake',model:'test'}
  const registry=emptyRegistry();registry.libraries=[library];const store=new LibraryStore(()=>registry)
  if(seed){
    let snapshot=snapshots.get(seed)
    if(!snapshot){snapshot=await snapshotFixture(seed.wiki);snapshots.set(seed,snapshot)}
    await restoreFixture(snapshot,wiki)
  }
  else{
    await mkdir(source);await writeFile(path.join(source,'a.md'),'甲流程有明确的有效依据。');await writeFile(path.join(source,'b.md'),'乙流程有明确的有效依据。')
    const view=await store.initialize(library.id)
    await store.savePolicy(library.id,{...view.policy,batchDelayMs:0},view.revision);await scanLibrary(store,library.id)
  }
  const mode={value:'valid'},calls:string[]=[]
  const runtime:ModelRuntime={async resolveModelInfo(provider,id){return {provider,id,name:id}},async *stream(options):AsyncIterable<StreamChunk>{
    const data=JSON.parse((options.messages[0]!.content[0] as {text:string}).text);let output:unknown
    if(data.candidates){
      const groups=new Map<string,{type:'concept';title:string;identity:string;aliases:string[];tags:string[];members:string[];conflicts:string[][]}>()
      for(const c of data.candidates){const group=groups.get(c.identity)??{type:'concept',title:c.title,identity:c.identity,aliases:[],tags:[],members:[],conflicts:[]};group.members.push(c.id);groups.set(c.identity,group)}
      output=JSON.parse(groupingResponse(options.system??'',[...groups.values()]))
    }
    else if(data.claims)output={conflicts:[]}
    else{
      calls.push(data.source)
      if(mode.value==='io')throw Object.assign(new Error('模拟读取失败'),{code:'EACCES'})
      if(mode.value==='all-bad'||mode.value==='bad-chunk'&&data.source==='a.md'||mode.value==='late-bad'&&data.known.length){yield {type:'text-delta',index:0,text:'{broken'};yield {type:'finish',reason:{kind:'stop'}};return}
      output={candidates:data.known.length?[]:[{type:'concept',title:'主题'+data.source,identity:'对象'+data.source,aliases:[],tags:[],mentionOnly:false,
        claims:[{text:data.text,quote:data.text},...(mode.value==='mixed'&&data.source==='a.md'?[{text:'虚构的结论',quote:'没有此引文'}]:[])]}],images:[]}
    }
    yield {type:'text-delta',index:0,text:JSON.stringify(output)};yield {type:'finish',reason:{kind:'stop'}}
  }}
  return {...temp,source,wiki,library,store,mode,calls,runtime,changes:new ChangeStore(store)}
}
describe('单条引文失败的生成与接续',()=>{
  let seed:Awaited<ReturnType<typeof fixture>>
  beforeAll(async()=>{
    seed=await fixture();seed.mode.value='mixed'
    await seed.store.migrateStorage(seed.library.id)
    const job=await generateWiki(seed.store,seed.library.id,seed.runtime,new AbortController().signal)
    const view=await seed.changes.preview(seed.library.id,job.batchId!)
    await seed.changes.commit(seed.library.id,job.batchId!,view.batch.digest)
  })
  afterAll(async()=>{await seed?.cleanup()})
  it('单条引文失败保留同段其他知识和缺口',async()=>{
    const f=await fixture();f.mode.value='mixed'
    try{
    await f.store.migrateStorage(f.library.id)
    const job=await generateWiki(f.store,f.library.id,f.runtime,new AbortController().signal),view=await f.changes.preview(f.library.id,job.batchId!)
    expect(job).toMatchObject({status:'preview',partial:true,sourcesCompleted:2});expect(job.diagnostics).toHaveLength(1)
    expect(job.diagnostics![0]).toMatchObject({kind:'quote',scope:'claim',sourcePath:'a.md',start:0,line:1})
    const catalog=JSON.parse(view.pages.find(p=>p.path==='.llmwiki/knowledge/catalog.json')!.after!)
    expect(catalog.pages.flatMap((p:{claims:{text:string}[]})=>p.claims).map((c:{text:string})=>c.text)).not.toContain('虚构的结论')
    expect(view.pages.find(p=>p.path==='quality-report.md')!.after).toContain('没有此引文')
    }finally{await f.cleanup()}
  })
  it('重复生成仍保留缺口且仅处理问题来源',async()=>{
    const f=await fixture(seed);f.mode.value='mixed'
    try{
      const next=await generateWiki(f.store,f.library.id,f.runtime,new AbortController().signal)
      expect(next.partial).toBe(true);expect(next.diagnostics).toHaveLength(1);expect(f.calls).not.toContain('b.md')
    }finally{await f.cleanup()}
  })
  it('稳定重跑不变仍保留缺口',async()=>{
    const f=await fixture(seed);f.mode.value='mixed'
    try{
      const next=await generateWiki(f.store,f.library.id,f.runtime,new AbortController().signal)
      if(next.batchId){const changed=await f.changes.preview(f.library.id,next.batchId);await f.changes.commit(f.library.id,next.batchId,changed.batch.digest)}
      const stable=await generateWiki(f.store,f.library.id,f.runtime,new AbortController().signal)
      expect(stable).toMatchObject({status:'unchanged',partial:true});expect(stable.diagnostics).toHaveLength(1)
    }finally{await f.cleanup()}
  })
})
it('最小叶段Schema失败不终止其他来源，失败区间逐项登记',async()=>{
  const f=await fixture();f.mode.value='bad-chunk'
  try{
    const job=await generateWiki(f.store,f.library.id,f.runtime,new AbortController().signal)
    expect(job).toMatchObject({status:'preview',partial:true,sourcesCompleted:2});expect(job.chunks.filter(c=>c.status==='failed')).toHaveLength(1)
    expect(job.diagnostics).toMatchObject([{kind:'schema',scope:'chunk',sourcePath:'a.md',start:0,end:'甲流程有明确的有效依据。'.length,line:1}])
  }finally{await f.cleanup()}
})
it('全库无可发布知识仍失败，并保留所有已登记缺口',async()=>{
  const f=await fixture();f.mode.value='all-bad'
  try{await expect(generateWiki(f.store,f.library.id,f.runtime,new AbortController().signal)).rejects.toThrow('没有提取到有来源支持的知识')
    const job=(await listGenerateJobs(f.store,f.library.id))[0]!;expect(job.status).toBe('failed');expect(job.diagnostics).toHaveLength(2);expect(await f.changes.list(f.library.id)).toEqual([])
  }finally{await f.cleanup()}
})
it('IO故障仍终止作业并分类，不伪装成可发布缺口',async()=>{
  const f=await fixture();f.mode.value='io'
  try{await expect(generateWiki(f.store,f.library.id,f.runtime,new AbortController().signal)).rejects.toThrow('模拟读取失败')
    expect((await listGenerateJobs(f.store,f.library.id))[0]!.failure).toMatchObject({kind:'io',scope:'job'});expect(await f.changes.list(f.library.id)).toEqual([])
  }finally{await f.cleanup()}
})
describe('已发布成果的失败隔离',()=>{
  let seed:Awaited<ReturnType<typeof fixture>>,view:Awaited<ReturnType<ChangeStore['preview']>>
  beforeAll(async()=>{
    seed=await fixture()
    seed.mode.value='all-bad'
    await expect(generateWiki(seed.store,seed.library.id,seed.runtime,new AbortController().signal)).rejects.toThrow('没有提取到有来源支持的知识')
    seed.mode.value='valid'
    const first=await generateWiki(seed.store,seed.library.id,seed.runtime,new AbortController().signal)
    view=await seed.changes.preview(seed.library.id,first.batchId!)
    await seed.changes.commit(seed.library.id,first.batchId!,view.batch.digest)
  })
  afterAll(async()=>{await seed?.cleanup()})
  it('已发布后全库无可发布知识仍失败，不新增变更提案',async()=>{
    const f=await fixture(seed)
    try{
      // 此场景要修改原文，另复制来源并保留原有来源编号；只读模板不参与修改。
      const source=path.join(f.root,'source');await cp(f.source,source,{recursive:true})
      const file=path.join(f.wiki,'.llmwiki/sources/catalog.json'),catalog=JSON.parse(await readFile(file,'utf8'))
      for(const record of catalog){record.root=source;record.absolutePath=path.join(source,record.relativePath)}
      await writeFile(file,JSON.stringify(catalog));f.library.sourceRoots=[source]
      await writeFile(path.join(source,'a.md'),'甲来源已更新。');await writeFile(path.join(source,'b.md'),'乙来源已更新。');await scanLibrary(f.store,f.library.id)
      f.mode.value='all-bad'
      await expect(generateWiki(f.store,f.library.id,f.runtime,new AbortController().signal)).rejects.toThrow('没有提取到有来源支持的知识')
      expect((await f.changes.list(f.library.id)).every(batch=>batch.status==='committed')).toBe(true)
    }finally{await f.cleanup()}
  })
it('部分重建保留先前有效页面、主张和人工区，不产生删除旧成果的提案',async()=>{
  const f=await fixture(seed)
  try{
    const catalog=JSON.parse(view.pages.find(p=>p.path==='.llmwiki/knowledge/catalog.json')!.after!),oldPath=catalog.pages.find((p:{claims:{text:string}[]})=>p.claims.some(c=>c.text.includes('甲流程'))).path
    await writeFile(path.join(f.wiki,oldPath),(await readFile(path.join(f.wiki,oldPath),'utf8'))+'\n人工补充保留。\n')
    const policy=await f.store.policy(f.library.id);await f.store.savePolicy(f.library.id,{...policy.policy,extractionGranularity:'balanced'},policy.revision)
    f.mode.value='bad-chunk'
    const next=await generateWiki(f.store,f.library.id,f.runtime,new AbortController().signal,undefined,undefined,true),preview=await f.changes.preview(f.library.id,next.batchId!)
    expect(next.partial).toBe(true);expect(preview.pages.some(p=>p.after===null)).toBe(false)
    expect(preview.pages.find(p=>p.path===oldPath)!.after).toContain('人工补充保留。')
    expect(JSON.parse(preview.pages.find(p=>p.path==='.llmwiki/knowledge/catalog.json')!.after!).pages.flatMap((p:{claims:{text:string}[]})=>p.claims).some((c:{text:string})=>c.text.includes('甲流程'))).toBe(true)
  }finally{await f.cleanup()}
})
})
