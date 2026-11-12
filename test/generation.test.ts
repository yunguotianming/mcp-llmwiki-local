// 内容低重合替换会留下旧缺失记录；重编号验证选当前活动来源，原图及零提取断言保持。
import { mkdir, readFile, rename,unlink,writeFile } from 'node:fs/promises'
import { readFileSync,writeFileSync } from 'node:fs'
import path from 'node:path'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterAll,afterEach,beforeAll,describe,expect,it,vi } from 'vitest'
import { newLibrary,emptyRegistry } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { scanLibrary } from '../src/ingest/scanner.js'
import { generateWiki,listGenerateJobs } from '../src/wiki/generation.js'
import { ChangeStore } from '../src/storage/changes.js'
import { listSources,prepareSourceState } from '../src/wiki/sources.js'
import { WikiQuery } from '../src/wiki/query.js'
import type { ModelRuntime } from '../src/llm/client.js'
import type { Candidate } from '../src/ingest/extraction.js'
import { EXTRACT_PROMPT } from '../src/ingest/extraction.js'
import { signature } from '../src/storage/files.js'
import { temporaryWorkspace } from './temp.js'
import { groupingResponse } from './synthesis-fixture.js'
import { mockFixtureSync, restoreFixture, snapshotFixture, type FixtureSnapshot } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => vi.restoreAllMocks())
const defaultSources = {'a.md':'流程青松的初检为18/20。','b.md':'流程青松的初检为17/20。'}
let shared: Awaited<ReturnType<typeof createFixture>>, single: typeof shared, initial: FixtureSnapshot, singleInitial: FixtureSnapshot
let committedInitial: FixtureSnapshot, committedPreview: Awaited<ReturnType<ChangeStore['preview']>>
beforeAll(async () => {
  shared = await createFixture(defaultSources); initial = await snapshotFixture(shared.root)
  const changes = new ChangeStore(shared.store), job = await generateWiki(shared.store, shared.library.id, fakeModel().runtime, new AbortController().signal)
  committedPreview = await changes.preview(shared.library.id, job.batchId!)
  await changes.commit(shared.library.id, job.batchId!, committedPreview.batch.digest)
  committedInitial = await snapshotFixture(shared.root)
  single = await createFixture({ 'a.md': defaultSources['a.md'] }); singleInitial = await snapshotFixture(single.root)
})
afterAll(async () => { await shared?.cleanup(); await single?.cleanup() })
async function fixture(sources?:Record<string,string> | 'single' | 'committed') {
  if (sources && typeof sources !== 'string') return createFixture(sources)
  const base = sources === 'single' ? single : shared
  mockFixtureSync(base.root)
  await restoreFixture(sources === 'single' ? singleInitial : sources === 'committed' ? committedInitial : initial, base.root)
  // 每项用例重新建登记与服务；只复用原字节基线，不共享可变作业或 mock。
  const library = structuredClone(base.library), registry = emptyRegistry(); registry.libraries = [library]
  return { ...base, library, store: new LibraryStore(() => registry), async cleanup() {} }
}
async function committedFixture() {
  const f = await fixture('committed')
  // 增量与查询用例共用真实双来源首版的字节快照，每次恢复后独立变更。
  return { ...f, changes: new ChangeStore(f.store), preview: structuredClone(committedPreview) }
}
async function createFixture(sources:Record<string,string>) {
  const temp=await temporaryWorkspace(),source=path.join(temp.root,'source'),wiki=path.join(temp.root,'wiki')
  mockFixtureSync(temp.root)
  await mkdir(source);for(const [name,text] of Object.entries(sources))await writeFile(path.join(source,name),text)
  const library=newLibrary('generation');library.wikiPath=wiki;library.sourceRoots=[source];library.models.unified={provider:'fake',model:'test'}
  const registry=emptyRegistry();registry.libraries=[library];const store=new LibraryStore(()=>registry)
  const initialized=await store.initialize(library.id);initialized.policy.batchDelayMs=0
  await store.savePolicy(library.id,initialized.policy,initialized.revision);await scanLibrary(store,library.id)
  return {...temp,source,wiki,library,store}
}
function fakeModel(hallucinate=false) {
  let extractionCalls=0,failCall=0
  const runtime:ModelRuntime={async resolveModelInfo(provider,id){return {provider,id,name:id}},
    async *stream(options):AsyncIterable<StreamChunk> {
      const data=JSON.parse((options.messages[0]!.content[0] as {text:string}).text)
      let output:unknown
      if(data.claims){
        output={conflicts:data.claims.length>1?[data.claims.map((claim:{id:string})=>claim.id)]:[]}
      }else if(data.candidates) {
        const candidates=data.candidates
        const claimIds=candidates.flatMap((item:{claims:{id:string}[]})=>item.claims.map(claim=>claim.id))
        output=JSON.parse(groupingResponse(options.system??'',[{type:'concept',title:'青松初检流程',identity:'青松初检流程',aliases:['青松'],tags:[],members:candidates.map((item:{id:string})=>item.id),conflicts:claimIds.length>1?[claimIds]:[]}]))
      }else{
        extractionCalls++;if(extractionCalls===failCall)throw new Error('模拟请求中断')
        output={candidates:[{type:'concept',title:'青松初检流程',identity:'青松初检流程',aliases:['青松'],tags:[],mentionOnly:false,claims:[{text:data.text,quote:hallucinate?'不存在的引文':data.text}]}],images:[]}
      }
      yield {type:'text-delta',index:0,text:JSON.stringify(output)};yield {type:'finish',reason:{kind:'stop'}}
    }}
  return {runtime,get extractionCalls(){return extractionCalls},failAt(call:number){failCall=call}}
}
describe('提取与跨文档综合',()=>{
  it('生成首次保存前来源清单变化时拒绝启动，不保存过期运行任务',async()=>{
    const f=await fixture(),model=fakeModel(),check=f.store.assertUnchanged.bind(f.store);let changed=false
    try{
      f.store.assertUnchanged=library=>{
        check(library)
        if(!changed){changed=true;const file=path.join(f.wiki,'.llmwiki/sources/catalog.json'),records=JSON.parse(readFileSync(file,'utf8'));records[0].relativePath='扫描后的新路径.md';writeFileSync(file,JSON.stringify(records))}
      }
      await expect(generateWiki(f.store,f.library.id,model.runtime,new AbortController().signal)).rejects.toThrow('来源清单在生成启动前已变化')
      expect(await listGenerateJobs(f.store,f.library.id)).toEqual([]);expect(model.extractionCalls).toBe(0)
    }finally{await f.cleanup()}
  })
  it('持久运行作业阻止另一执行器同时生成，取消后保存可继续的片段',async()=>{
    const f=await fixture(),abort=new AbortController()
    let entered!:()=>void
    const started=new Promise<void>(resolve=>{entered=resolve})
    const model=fakeModel(),runtime:ModelRuntime={...model.runtime,async *stream(options){entered();await new Promise<void>(resolve=>options.signal!.addEventListener('abort',()=>resolve(),{once:true}));yield {type:'finish',reason:{kind:'stop'}}}}
    try{
      const first=generateWiki(f.store,f.library.id,runtime,abort.signal).catch(error=>error)
      await started
      await expect(generateWiki(f.store,f.library.id,model.runtime,new AbortController().signal)).rejects.toThrow('已有持久生成任务')
      abort.abort(new Error('用户取消'))
      await first
      const latest=(await listGenerateJobs(f.store,f.library.id))[0]!
      expect(latest.status).toBe('cancelled');expect(latest.chunks.some(chunk=>chunk.status==='failed')).toBe(false)
    }finally{abort.abort();await f.cleanup()}
  })
  it('完整重建通过同一批次替换旧成果，不另存副本并保留原始资料和 Schema',async()=>{
    const f=await fixture(),model=fakeModel()
    try{
      await mkdir(path.join(f.wiki,'concepts'));await mkdir(path.join(f.wiki,'schema'))
      await writeFile(path.join(f.wiki,'concepts/legacy.md'),'# 旧版知识\n人工整理内容。')
      await writeFile(path.join(f.wiki,'index.md'),'# 旧目录\n')
      await writeFile(path.join(f.wiki,'log.md'),'# 旧历史\n')
      await writeFile(path.join(f.wiki,'schema/config.md'),'# 保留的 Schema\n')
      await expect(generateWiki(f.store,f.library.id,model.runtime,new AbortController().signal)).rejects.toThrow('未登记人工内容')
      const job=await generateWiki(f.store,f.library.id,model.runtime,new AbortController().signal,undefined,undefined,true)
      const changes=new ChangeStore(f.store),preview=await changes.preview(f.library.id,job.batchId!)
      expect(preview.batch.reason).toBe('完整重建本地 Wiki')
      expect(preview.pages.find(page=>page.path==='concepts/legacy.md')).toMatchObject({before:'# 旧版知识\n人工整理内容。',after:null})
      expect(preview.pages.find(page=>page.path==='log.md')?.after).toBeNull()
      expect(await readFile(path.join(f.wiki,'index.md'),'utf8')).toBe('# 旧目录\n')
      expect(await readFile(path.join(f.wiki,'concepts/legacy.md'),'utf8')).toContain('人工整理内容')
      await changes.commit(f.library.id,job.batchId!,preview.batch.digest)
      await expect(readFile(path.join(f.wiki,'concepts/legacy.md'))).rejects.toThrow()
      expect(await readFile(path.join(f.wiki,'index.md'),'utf8')).toContain('青松初检流程')
      expect(await readFile(path.join(f.wiki,'schema/config.md'),'utf8')).toBe('# 保留的 Schema\n')
      expect(await readFile(path.join(f.source,'a.md'),'utf8')).toBe('流程青松的初检为18/20。')
      expect((await new WikiQuery(f.store).search('青松')).results.some(page=>page.type==='concept')).toBe(true)
    }finally{await f.cleanup()}
  })
  it('完整重建期间旧页面发生编辑时拒绝准备批次，不覆盖修改',async()=>{
    const f=await fixture(),model=fakeModel();let changed=false
    try{
      await mkdir(path.join(f.wiki,'concepts'));await writeFile(path.join(f.wiki,'concepts/legacy.md'),'# 原旧页')
      const runtime:ModelRuntime={...model.runtime,async *stream(options){
        if(!changed){changed=true;await writeFile(path.join(f.wiki,'concepts/legacy.md'),'# 新人工修改')}
        yield* model.runtime.stream(options)
      }}
      await expect(generateWiki(f.store,f.library.id,runtime,new AbortController().signal,undefined,undefined,true)).rejects.toThrow(/变化/)
      expect(await new ChangeStore(f.store).list(f.library.id)).toEqual([])
      expect(await readFile(path.join(f.wiki,'concepts/legacy.md'),'utf8')).toBe('# 新人工修改')
    }finally{await f.cleanup()}
  })
  it('模型分析期间另一端提交后，旧作业不能按最新代次生成可确认预览',async()=>{
    const f=await fixture(),model=fakeModel();let changed=false
    try{
      const runtime:ModelRuntime={...model.runtime,async *stream(options){
        if(!changed){changed=true;await writeFile(path.join(f.wiki,'.llmwiki/coordination/generation.json'),JSON.stringify({value:1,batchId:'obsidian-test'}))}
        yield* model.runtime.stream(options)
      }}
      await expect(generateWiki(f.store,f.library.id,runtime,new AbortController().signal)).rejects.toThrow('生成依据已变化')
      expect((await listGenerateJobs(f.store,f.library.id))[0]?.status).toBe('failed')
      expect(await new ChangeStore(f.store).list(f.library.id)).toEqual([])
      await expect(readFile(path.join(f.wiki,'index.md'))).rejects.toThrow()
    }finally{await f.cleanup()}
  })
  it.each([
    {name:'按建库策略创建说明页',enabled:true,manual:false},
    {name:'关闭建库策略时不创建说明页',enabled:false,manual:false},
    {name:'已有人工说明页不被覆盖',enabled:true,manual:true},
  ])('$name',async({enabled,manual})=>{
    // 各策略状态独立验证，每项只用一个来源和一次真实生成。
    const f=await fixture('single')
    try{
      if(!enabled){
        const view=await f.store.policy(f.library.id)
        await f.store.savePolicy(f.library.id,{...view.policy,createWelcomeNote:false},view.revision)
      }
      if(manual)await writeFile(path.join(f.wiki,'welcome.md'),'# 人工说明\r\n保留内容。\r\n')
      const job=await generateWiki(f.store,f.library.id,fakeModel().runtime,new AbortController().signal),changes=new ChangeStore(f.store)
      const welcome=(await changes.preview(f.library.id,job.batchId!)).pages.find(page=>page.path==='welcome.md')
      if(enabled&&!manual)expect(welcome?.after).toContain('原始资料目录保持只读')
      else expect(welcome).toBeUndefined()
      if(manual)expect(await readFile(path.join(f.wiki,'welcome.md'),'utf8')).toBe('# 人工说明\r\n保留内容。\r\n')
    }finally{await f.cleanup()}
  })
  it('两个来源综合成一页，保留冲突和逐条出处，提交前不落页面',async()=>{
    const f=await fixture(),model=fakeModel()
    try{
      const job=await generateWiki(f.store,f.library.id,model.runtime,new AbortController().signal)
      expect(job.status).toBe('preview');expect(job.chunks.every(chunk=>chunk.status==='complete')).toBe(true)
      const changes=new ChangeStore(f.store),preview=await changes.preview(f.library.id,job.batchId!)
      const concepts=preview.pages.filter(page=>page.path.startsWith('concepts/'))
      expect(concepts).toHaveLength(1);expect(concepts[0]!.after).toContain('18/20');expect(concepts[0]!.after).toContain('17/20')
      expect(concepts[0]!.after).toContain('来源分歧');expect(concepts[0]!.after).toContain('逐条出处')
      await expect(readFile(path.join(f.wiki,concepts[0]!.path))).rejects.toThrow()
      expect((await scanLibrary(f.store,f.library.id)).files.every(file=>file.needsGeneration)).toBe(true)
      await changes.commit(f.library.id,job.batchId!,preview.batch.digest)
      expect((await scanLibrary(f.store,f.library.id)).files.every(file=>file.generation==='current'&&!file.needsGeneration)).toBe(true)
      expect(await readFile(path.join(f.wiki,concepts[0]!.path),'utf8')).toBe(concepts[0]!.after)
      expect(await readFile(path.join(f.source,'a.md'),'utf8')).toBe('流程青松的初检为18/20。')
    }finally{await f.cleanup()}
  })
  it('全部引文不存在且无可发布知识时停止，不生成可提交批次',async()=>{
    const f=await fixture()
    try{
      await expect(generateWiki(f.store,f.library.id,fakeModel(true).runtime,new AbortController().signal)).rejects.toThrow('没有提取到有来源支持的知识')
      expect((await listGenerateJobs(f.store,f.library.id))[0]?.status).toBe('failed')
      expect(await new ChangeStore(f.store).list(f.library.id)).toEqual([])
    }finally{await f.cleanup()}
  })
  it('重编号后复用已完成提取，提交同步来源路径并保留知识引用身份',async()=>{
    const f=await committedFixture(),model=fakeModel(),changes=f.changes
    try{
      const calls=model.extractionCalls,oldPath=path.join(f.source,'a.md'),newPath=path.join(f.source,'02-a.md')
      const records=JSON.parse(await readFile(path.join(f.wiki,'.llmwiki/sources/catalog.json'),'utf8')),original=records.find((record:{absolutePath:string})=>record.absolutePath===oldPath)
      await rename(oldPath,newPath)
      expect((await scanLibrary(f.store,f.library.id)).files.find(file=>file.path===newPath)).toMatchObject({sourceId:original.id,change:'moved',needsGeneration:true})
      const next=await generateWiki(f.store,f.library.id,model.runtime,new AbortController().signal),preview=await changes.preview(f.library.id,next.batchId!)
      expect(model.extractionCalls).toBe(calls)
      expect(preview.pages.find(page=>page.path===`sources/${original.id}.md`)!.after).toContain(newPath)
      expect(next.chunks.filter(chunk=>chunk.sourceId===original.id).every(chunk=>chunk.status==='complete')).toBe(true)
      await changes.commit(f.library.id,next.batchId!,preview.batch.digest)
      expect((await scanLibrary(f.store,f.library.id)).files.every(file=>file.generation==='current'&&!file.needsGeneration)).toBe(true)
    }finally{await f.cleanup()}
  },10000)
  it('把逐字引文错误反馈一次，纠正通过后才保存提取检查点',async()=>{
    const f=await fixture(),model=fakeModel();let invalid=true,corrections=0
    try{
      const runtime:ModelRuntime={...model.runtime,async *stream(options){
        const input=JSON.parse((options.messages[0]!.content[0] as {text:string}).text)
        if(input.validationFeedback){corrections++;expect(input.validationFeedback.error).toContain('无法在当前段落定位');expect(input.validationFeedback.error).toContain('不存在的逐字引文')}
        for await(const event of model.runtime.stream(options)){
          if(invalid&&event.type==='text-delta'&&input.text){
            invalid=false;const data=JSON.parse(event.text);data.candidates[0].claims[0].quote='不存在的逐字引文';yield {...event,text:JSON.stringify(data)}
          }else yield event
        }
      }}
      const job=await generateWiki(f.store,f.library.id,runtime,new AbortController().signal)
      expect(job.status).toBe('preview');expect(corrections).toBe(1)
      expect(job.chunks.flatMap(chunk=>chunk.candidates).flatMap(candidate=>candidate.claims).every(claim=>!claim.evidence.quote.includes('不存在'))).toBe(true)
    }finally{await f.cleanup()}
  })
  it('短表格引文纠正提供完整原文，验证后保留连续引文和定位',async()=>{
    const f=await fixture(),model=fakeModel();let corrections=0
    const table='| 工作方式 | 职业体验 |\n| 自主 | 全部参与者完全 |\n| 挑战 | 满意研究护士工作 |'
    try{
      await writeFile(path.join(f.source,'a.md'),table);await scanLibrary(f.store,f.library.id)
      const runtime:ModelRuntime={...model.runtime,async *stream(options){
        const input=JSON.parse((options.messages[0]!.content[0] as {text:string}).text)
        if(input.text!==table){yield* model.runtime.stream(options);return}
        if(input.validationFeedback){
          corrections++;expect(input.validationFeedback.error).toContain(JSON.stringify(table))
          expect(input.validationFeedback.quoteReferences).toEqual([{id:'current-fragment',text:table}])
        }
        yield {type:'text-delta',index:0,text:JSON.stringify({candidates:[{type:'concept',title:'职业体验',identity:'研究护士的职业体验',aliases:[],tags:[],mentionOnly:false,
          claims:[{text:'全部参与者完全满意研究护士工作。',...(input.validationFeedback?{quoteRef:'current-fragment'}:{quote:input.round===1?'全部参与者完全满意研究护士工作':table})}]}],images:[]})}
        yield {type:'finish',reason:{kind:'stop'}}
      }}
      const job=await generateWiki(f.store,f.library.id,runtime,new AbortController().signal)
      const chunk=job.chunks.find(chunk=>chunk.candidates.some(candidate=>candidate.title==='职业体验'))!
      expect(job.status).toBe('preview');expect(corrections).toBe(1)
      expect(chunk.status).toBe('complete');expect(chunk.candidates[0]!.claims[0]!.evidence).toMatchObject({quote:table,cleanStart:0,originalStart:0,line:1})
      expect(chunk.rounds?.flatMap(round=>round.candidates).flatMap(candidate=>candidate.claims).every(claim=>'quote' in claim&&!('quoteRef' in claim))).toBe(true)
    }finally{await f.cleanup()}
  })
  it('引文纠正失败后缩段重提取，叶段连续覆盖全文且仍严格定位',async()=>{
    const f=await fixture(),model=fakeModel();let corrections=0
    try{
      const text='𠮷'.repeat(600)+'\n长文末尾。'
      await writeFile(path.join(f.source,'a.md'),text);await scanLibrary(f.store,f.library.id)
      const runtime:ModelRuntime={...model.runtime,async *stream(options){
        const input=JSON.parse((options.messages[0]!.content[0] as {text:string}).text)
        if(input.text?.length>400){
          if(input.validationFeedback)corrections++
          yield {type:'text-delta',index:0,text:JSON.stringify({candidates:[{type:'concept',title:'无效引文对象',identity:'无效引文对象',aliases:[],tags:[],mentionOnly:false,claims:[{text:'不能保留此主张。',quote:'当前正文不存在的引文'}]}],images:[]})}
          yield {type:'finish',reason:{kind:'stop'}};return
        }
        yield* model.runtime.stream(options)
      }}
      const job=await generateWiki(f.store,f.library.id,runtime,new AbortController().signal)
      expect(job.status).toBe('preview');expect(corrections).toBeGreaterThan(0)
      const parents=job.chunks.filter(chunk=>chunk.status==='split');expect(parents.length).toBeGreaterThan(0)
      const leaves=job.chunks.filter(chunk=>chunk.sourceId===parents[0]!.sourceId&&chunk.status==='complete').sort((a,b)=>a.start-b.start)
      expect(leaves[0]!.start).toBe(0);expect(leaves.at(-1)!.end).toBe(text.length)
      for(let index=1;index<leaves.length;index++)expect(leaves[index]!.start).toBe(leaves[index-1]!.end)
      expect(leaves.flatMap(chunk=>chunk.candidates).flatMap(candidate=>candidate.claims).map(claim=>claim.evidence.quote).join('')).toBe(text)
      expect(job.chunks.flatMap(chunk=>chunk.candidates).some(candidate=>candidate.title==='无效引文对象')).toBe(false)
    }finally{await f.cleanup()}
  })
  it('长片段请求超时后缩段，保留成功叶段及连续正文覆盖',async()=>{
    const f=await fixture(),model=fakeModel();let timeouts=0
    try{
      const text='长文内容。'.repeat(250)
      await writeFile(path.join(f.source,'a.md'),text);await scanLibrary(f.store,f.library.id)
      const runtime:ModelRuntime={...model.runtime,async *stream(options){
        const input=JSON.parse((options.messages[0]!.content[0] as {text:string}).text)
        if(input.text?.length>400){timeouts++;throw new DOMException('模拟请求超时','TimeoutError')}
        yield* model.runtime.stream(options)
      }}
      const job=await generateWiki(f.store,f.library.id,runtime,new AbortController().signal)
      expect(job.status).toBe('preview');expect(timeouts).toBeGreaterThan(0)
      const parent=job.chunks.find(chunk=>chunk.status==='split')!
      const leaves=job.chunks.filter(chunk=>chunk.sourceId===parent.sourceId&&chunk.status==='complete').sort((a,b)=>a.start-b.start)
      expect(leaves[0]!.start).toBe(0);expect(leaves.at(-1)!.end).toBe(text.length)
      for(let index=1;index<leaves.length;index++)expect(leaves[index]!.start).toBe(leaves[index-1]!.end)
      expect(leaves.flatMap(chunk=>chunk.candidates).flatMap(candidate=>candidate.claims).map(claim=>claim.evidence.quote).join('')).toBe(text)
    }finally{await f.cleanup()}
  })
  it('短片段请求超时全部无可发布知识时停止，并保留分类缺口',async()=>{
    const f=await fixture(),model=fakeModel()
    try{
      const runtime:ModelRuntime={...model.runtime,async *stream(){throw new DOMException('模拟请求超时','TimeoutError');yield {type:'finish',reason:{kind:'stop'}}}}
      await expect(generateWiki(f.store,f.library.id,runtime,new AbortController().signal)).rejects.toThrow('没有提取到有来源支持的知识')
      const job=(await listGenerateJobs(f.store,f.library.id))[0]!
      expect(job.status).toBe('failed');expect(job.chunks.some(chunk=>chunk.status==='failed')).toBe(true)
      expect(job.chunks.some(chunk=>chunk.status==='split')).toBe(false)
      expect(job.diagnostics?.some(issue=>issue.kind==='timeout')).toBe(true)
      expect(await new ChangeStore(f.store).list(f.library.id)).toEqual([])
    }finally{await f.cleanup()}
  })
  it('JSON纠正仍不合法时缩段提取，叶段连续覆盖全文',async()=>{
    const f=await fixture(),model=fakeModel();let corrections=0
    try{
      const text='𠮷'.repeat(600)+'\n长文末尾。'
      await writeFile(path.join(f.source,'a.md'),text);await scanLibrary(f.store,f.library.id)
      const runtime:ModelRuntime={...model.runtime,async *stream(options){
        const input=JSON.parse((options.messages[0]!.content[0] as {text:string}).text)
        if(input.text?.length>400){
          if(input.validationFeedback)corrections++
          yield {type:'text-delta',index:0,text:'{"candidates":['};yield {type:'finish',reason:{kind:'stop'}};return
        }
        yield* model.runtime.stream(options)
      }}
      const job=await generateWiki(f.store,f.library.id,runtime,new AbortController().signal)
      expect(job.status).toBe('preview');expect(corrections).toBeGreaterThan(0)
      const parent=job.chunks.find(chunk=>chunk.status==='split')!
      const leaves=job.chunks.filter(chunk=>chunk.sourceId===parent.sourceId&&chunk.status==='complete').sort((a,b)=>a.start-b.start)
      expect(leaves[0]!.start).toBe(0);expect(leaves.at(-1)!.end).toBe(text.length)
      for(let index=1;index<leaves.length;index++)expect(leaves[index]!.start).toBe(leaves[index-1]!.end)
      expect(leaves.flatMap(chunk=>chunk.candidates).flatMap(candidate=>candidate.claims).map(claim=>claim.evidence.quote).join('')).toBe(text)
    }finally{await f.cleanup()}
  })
  it.each(['引文过长','候选字段错层'])('长片段Schema纠正仍失败后缩段：%s',async(kind)=>{
    const f=await fixture(),model=fakeModel();let corrections=0
    try{
      const text='资料正文。'.repeat(1000)
      await writeFile(path.join(f.source,'a.md'),text);await scanLibrary(f.store,f.library.id)
      const runtime:ModelRuntime={...model.runtime,async *stream(options){
        const input=JSON.parse((options.messages[0]!.content[0] as {text:string}).text)
        if(input.text?.length>4000){
          if(input.validationFeedback)corrections++
          yield {type:'text-delta',index:0,text:JSON.stringify({candidates:[{type:'concept',title:'不应缓存的无效候选',identity:'无效候选',aliases:[],tags:[],mentionOnly:false,
            claims:[{text:'资料包含正文。',quote:kind==='引文过长'?input.text:'资料正文。'}],...(kind==='候选字段错层'?{images:[]}: {})}],images:[]})}
          yield {type:'finish',reason:{kind:'stop'}};return
        }
        yield* model.runtime.stream(options)
      }}
      const job=await generateWiki(f.store,f.library.id,runtime,new AbortController().signal)
      expect(job.status).toBe('preview');expect(corrections).toBe(1)
      const parent=job.chunks.find(chunk=>chunk.status==='split')!
      const leaves=job.chunks.filter(chunk=>chunk.sourceId===parent.sourceId&&chunk.status==='complete').sort((a,b)=>a.start-b.start)
      expect(leaves[0]!.start).toBe(0);expect(leaves.at(-1)!.end).toBe(text.length)
      for(let index=1;index<leaves.length;index++)expect(leaves[index]!.start).toBe(leaves[index-1]!.end)
      expect(leaves.flatMap(chunk=>chunk.candidates).flatMap(candidate=>candidate.claims).map(claim=>claim.evidence.quote).join('')).toBe(text)
      expect(parent.rounds??[]).toEqual([])
      expect(job.chunks.flatMap(chunk=>chunk.candidates).some(candidate=>candidate.title==='不应缓存的无效候选')).toBe(false)
    }finally{await f.cleanup()}
  })
  it('短片段Schema纠正仍全部失败时停止，不移除未知字段并保留缺口',async()=>{
    const f=await fixture(),model=fakeModel()
    try{
      const runtime:ModelRuntime={...model.runtime,async *stream(options){
        const input=JSON.parse((options.messages[0]!.content[0] as {text:string}).text)
        yield {type:'text-delta',index:0,text:JSON.stringify({candidates:[{type:'concept',title:'无效候选',identity:'无效候选',aliases:[],tags:[],mentionOnly:false,
          claims:[{text:'资料包含正文。',quote:input.text}],images:[]}],images:[]})}
        yield {type:'finish',reason:{kind:'stop'}}
      }}
      await expect(generateWiki(f.store,f.library.id,runtime,new AbortController().signal)).rejects.toThrow('没有提取到有来源支持的知识')
      const job=(await listGenerateJobs(f.store,f.library.id))[0]!
      expect(job.status).toBe('failed');expect(job.chunks.some(chunk=>chunk.status==='split')).toBe(false)
      expect(job.diagnostics?.some(issue=>issue.kind==='schema')).toBe(true)
      expect(job.chunks.every(chunk=>!chunk.candidates.length&&!(chunk.rounds??[]).length)).toBe(true)
      expect(await new ChangeStore(f.store).list(f.library.id)).toEqual([])
    }finally{await f.cleanup()}
  })
  it('中文策略将英文主张反馈纠正，英文引文保持逐字且综合接收中文目标',async()=>{
    const f=await fixture();let corrections=0,synthesisCalls=0
    try{
      await unlink(path.join(f.source,'b.md'));await writeFile(path.join(f.source,'a.md'),'CRNs coordinate clinical trials.')
      const current=await f.store.policy(f.library.id);current.policy.wikiLanguage='zh'
      await f.store.savePolicy(f.library.id,current.policy,current.revision);await scanLibrary(f.store,f.library.id)
      const runtime:ModelRuntime={async resolveModelInfo(provider,id){return {provider,id,name:id}},async *stream(options){
        const input=JSON.parse((options.messages[0]!.content[0] as {text:string}).text)
        expect(input.language).toBe('zh')
        let output:unknown
        if(input.candidates){
          synthesisCalls++;output={groups:[{type:'concept',title:'科研护士职责',identity:'临床试验中的科研护士职责',aliases:['CRN'],tags:[],members:input.candidates.map((item:Candidate)=>item.id),conflicts:[]}]}
        }else{
          if(input.validationFeedback){corrections++;expect(input.validationFeedback.error).toContain('中文');expect(input.validationFeedback.output).toContain('CRNs coordinate')}
          output={candidates:input.known.length?[]:[{type:'concept',title:'科研护士职责',identity:'临床试验中的科研护士职责',aliases:['CRN'],tags:[],mentionOnly:false,
            claims:[{text:input.validationFeedback?'科研护士协调临床试验。':'CRNs coordinate clinical trials.',quote:input.text}]}],images:[]}
        }
        yield {type:'text-delta',index:0,text:JSON.stringify(output)};yield {type:'finish',reason:{kind:'stop'}}
      }}
      const job=await generateWiki(f.store,f.library.id,runtime,new AbortController().signal)
      expect(job.status).toBe('preview');expect(corrections).toBe(1);expect(synthesisCalls).toBeGreaterThan(0)
      const claim=job.chunks.flatMap(chunk=>chunk.candidates).flatMap(candidate=>candidate.claims)[0]!
      expect(claim.text).toBe('科研护士协调临床试验。');expect(claim.evidence.quote).toBe('CRNs coordinate clinical trials.')
    }finally{await f.cleanup()}
  })
  it('从持久检查点继续时复用成功段落，来源在确认前变化使预览失效',async()=>{
    const f=await fixture(),model=fakeModel();model.failAt(3)
    try{
      await expect(generateWiki(f.store,f.library.id,model.runtime,new AbortController().signal)).rejects.toThrow('模拟请求中断')
      const failed=(await listGenerateJobs(f.store,f.library.id))[0]!
      expect(failed.chunks.filter(chunk=>chunk.status==='complete')).toHaveLength(1)
      const resumed=await generateWiki(f.store,f.library.id,model.runtime,new AbortController().signal,failed.id)
      expect(model.extractionCalls).toBe(5)
      const changes=new ChangeStore(f.store),preview=await changes.preview(f.library.id,resumed.batchId!)
      await writeFile(path.join(f.source,'a.md'),'改变的资料')
      await expect(changes.commit(f.library.id,resumed.batchId!,preview.batch.digest)).rejects.toThrow('生成依据已变化')
    }finally{await f.cleanup()}
  })
  it('旧版检查点调到30并发后接续，已完成片段与后续生成均复用提取',async()=>{
    const f=await fixture(),model=fakeModel();model.failAt(3)
    try{
      await expect(generateWiki(f.store,f.library.id,model.runtime,new AbortController().signal)).rejects.toThrow('模拟请求中断')
      const old=(await listGenerateJobs(f.store,f.library.id))[0]!,before=await f.store.policy(f.library.id)
      const legacy=signature(JSON.stringify([f.library.models,before.revision,null,'extract-v8-preserve-images:'+signature(EXTRACT_PROMPT)]))
      delete old.analysisFingerprint;delete old.policyRevision
      for(const chunk of old.chunks)chunk.key=signature(`${chunk.sourceId}:${chunk.sourceHash}:${chunk.chunkId}:${legacy}`)
      await writeFile(path.join(f.wiki,'.llmwiki/jobs',old.id+'.json'),JSON.stringify(old))
      await f.store.savePolicy(f.library.id,{...before.policy,analysisConcurrency:30,pageGenerationConcurrency:30},before.revision)
      const resumed=await generateWiki(f.store,f.library.id,model.runtime,new AbortController().signal,old.id)
      expect(resumed.status).toBe('preview');expect(resumed.id).toBe(old.id);expect(model.extractionCalls).toBe(5)
      expect(resumed.chunks.filter(chunk=>chunk.status==='complete')).toHaveLength(2)
      expect(resumed.analysisFingerprint).toBeTruthy()
      await generateWiki(f.store,f.library.id,model.runtime,new AbortController().signal)
      expect(model.extractionCalls).toBe(5)
    }finally{await f.cleanup()}
  })
  it('新版检查点仅调度变化可接续，语言变化即使有历史也拒绝混用',async()=>{
    const f=await fixture(),model=fakeModel();model.failAt(3)
    try{
      await expect(generateWiki(f.store,f.library.id,model.runtime,new AbortController().signal)).rejects.toThrow('模拟请求中断')
      const old=(await listGenerateJobs(f.store,f.library.id))[0]!,before=await f.store.policy(f.library.id)
      const next=await f.store.savePolicy(f.library.id,{...before.policy,analysisConcurrency:30,pageGenerationConcurrency:30},before.revision)
      await f.store.savePolicy(f.library.id,{...next.policy,wikiLanguage:'zh-CN'},next.revision)
      await expect(generateWiki(f.store,f.library.id,model.runtime,new AbortController().signal,old.id)).rejects.toThrow('资料或处理配置已变化')
      expect(model.extractionCalls).toBe(3)
      const changed=await f.store.policy(f.library.id)
      await f.store.savePolicy(f.library.id,{...next.policy,batchDelayMs:5},changed.revision)
      const resumed=await generateWiki(f.store,f.library.id,model.runtime,new AbortController().signal,old.id)
      expect(resumed.status).toBe('preview');expect(model.extractionCalls).toBe(5)
    }finally{await f.cleanup()}
  })
  it('模型截断时递归缩段，成功叶段连续覆盖全文',async()=>{
    const f=await fixture(),model=fakeModel()
    try{
      const text='𠮷'.repeat(600)+'\n长文末尾。'
      await writeFile(path.join(f.source,'a.md'),text);await scanLibrary(f.store,f.library.id)
      const runtime:ModelRuntime={...model.runtime,async *stream(options){
        const input=JSON.parse((options.messages[0]!.content[0] as {text:string}).text)
        if(input.text&&input.text.length>400){yield {type:'finish',reason:{kind:'max-tokens'}};return}
        yield* model.runtime.stream(options)
      }}
      const job=await generateWiki(f.store,f.library.id,runtime,new AbortController().signal)
      expect(job.chunks.some(chunk=>chunk.status==='split')).toBe(true)
      const sourceId=job.chunks.find(chunk=>chunk.status==='split')!.sourceId
      const leaves=job.chunks.filter(chunk=>chunk.sourceId===sourceId&&chunk.status==='complete').sort((a,b)=>a.start-b.start)
      expect(leaves[0]!.start).toBe(0);expect(leaves.at(-1)!.end).toBe(text.length)
      for(let index=1;index<leaves.length;index++)expect(leaves[index]!.start).toBe(leaves[index-1]!.end)
      expect(leaves.flatMap(chunk=>chunk.candidates).flatMap(candidate=>candidate.claims).map(claim=>claim.evidence.quote).join('')).toBe(text)
    }finally{await f.cleanup()}
  })
  it('撤出仅移除所选来源主张，恢复后重现冲突，原件与人工补充保留',async()=>{
    const f=await committedFixture(),changes=f.changes,generated=f.preview
    try{
      const concept=generated.pages.find(page=>page.path.startsWith('concepts/'))!,file=path.join(f.wiki,concept.path)
      await writeFile(file,(await readFile(file,'utf8'))+'\n人工补充保留。\n')
      const source=(await listSources(f.store,f.library.id)).find(source=>source.relativePath==='b.md')!
      const withdrawn=await prepareSourceState(f.store,f.library.id,[source.id],'withdrawn')
      // 确认前仍保留当前版本。
      expect((await new WikiQuery(f.store).read('青松')).content).toContain('17/20')
      await changes.commit(f.library.id,withdrawn.id,withdrawn.digest)
      const current=await new WikiQuery(f.store).read('青松')
      expect(current.content).toContain('18/20');expect(current.content).not.toContain('17/20');expect(current.content).toContain('人工补充保留')
      const restored=await prepareSourceState(f.store,f.library.id,[source.id],'active');await changes.commit(f.library.id,restored.id,restored.digest)
      expect((await new WikiQuery(f.store).read('青松')).content).toContain('17/20')
      expect(await readFile(path.join(f.source,'b.md'),'utf8')).toBe('流程青松的初检为17/20。')
    }finally{await f.cleanup()}
  })
  it('缩小资料范围后，不把旧目录的快照发送给模型',async()=>{
    const f=await fixture(),model=fakeModel()
    try{
      const selected=path.join(f.root,'selected');await mkdir(selected);await writeFile(path.join(selected,'c.md'),'新范围的资料。')
      f.library.sourceRoots.push(selected);await scanLibrary(f.store,f.library.id)
      const chosen=(await listSources(f.store,f.library.id)).find(source=>source.relativePath==='c.md')!
      f.library.sourceRoots=[selected]
      const job=await generateWiki(f.store,f.library.id,model.runtime,new AbortController().signal)
      expect(job.chunks.map(chunk=>chunk.sourceId)).toEqual([chosen.id]);expect(model.extractionCalls).toBe(2)
    }finally{await f.cleanup()}
  })
  it('增量综合匹配既有身份，名称或命名策略变化保留旧路径与人工补充',async()=>{
    const f=await fixture(),model=fakeModel()
    try{
      const changes=new ChangeStore(f.store),first=await generateWiki(f.store,f.library.id,model.runtime,new AbortController().signal)
      const preview=await changes.preview(f.library.id,first.batchId!);await changes.commit(f.library.id,first.batchId!,preview.batch.digest)
      const original=preview.pages.find(page=>page.path.startsWith('concepts/'))!,file=path.join(f.wiki,original.path)
      await writeFile(file,(await readFile(file,'utf8'))+'\n人工补充保留。\n')
      await writeFile(path.join(f.source,'c.md'),'流程青松还需要登记复核人。');await scanLibrary(f.store,f.library.id)
      const renamed:ModelRuntime={...model.runtime,async *stream(options){
        for await(const event of model.runtime.stream(options)){
          if(event.type==='text-delta'&&event.text.includes('"groups"')){
            const data=JSON.parse(event.text);data.groups[0].title='青松初检指南';yield {...event,text:JSON.stringify(data)}
          }else yield event
        }
      }}
      const next=await generateWiki(f.store,f.library.id,renamed,new AbortController().signal),result=await changes.preview(f.library.id,next.batchId!)
      expect(result.pages.filter(page=>page.path.startsWith('concepts/')).map(page=>page.path)).toEqual([original.path])
      const updated=result.pages.find(page=>page.path===original.path)!
      expect(updated.after).toContain('青松初检指南');expect(updated.after).toContain('人工补充保留')
      await changes.commit(f.library.id,next.batchId!,result.batch.digest)
      expect((await new WikiQuery(f.store).read('青松初检流程')).title).toBe('青松初检指南')
      expect(model.extractionCalls).toBe(6)
    }finally{await f.cleanup()}
  })
  it('仅修改一个来源时，重提取该来源并重新综合，未变来源复用已核对结果',async()=>{
    const f=await fixture(),model=fakeModel()
    try{
      const changes=new ChangeStore(f.store),first=await generateWiki(f.store,f.library.id,model.runtime,new AbortController().signal)
      const before=await changes.preview(f.library.id,first.batchId!);await changes.commit(f.library.id,first.batchId!,before.batch.digest)
      expect(model.extractionCalls).toBe(4)
      await writeFile(path.join(f.source,'b.md'),'流程青松的初检为19/20。');await scanLibrary(f.store,f.library.id)
      const second=await generateWiki(f.store,f.library.id,model.runtime,new AbortController().signal)
      const after=await changes.preview(f.library.id,second.batchId!)
      expect(model.extractionCalls).toBe(6)
      const concept=after.pages.find(page=>page.path.startsWith('concepts/'))!
      expect(concept.after).toContain('18/20');expect(concept.after).toContain('19/20');expect(concept.after).not.toContain('17/20')
    }finally{await f.cleanup()}
  })
  it('重编号后复用提取和原图，提交更新来源路径后扫描恢复为已生成',async()=>{
    const f=await fixture(),model=fakeModel()
    try{
      await writeFile(path.join(f.source,'a.md'),'流程青松的初检为18/20。\n![原图](image.png)')
      await writeFile(path.join(f.source,'image.png'),'原图字节');await scanLibrary(f.store,f.library.id)
      const changes=new ChangeStore(f.store),first=await generateWiki(f.store,f.library.id,model.runtime,new AbortController().signal)
      const initial=await changes.preview(f.library.id,first.batchId!);await changes.commit(f.library.id,first.batchId!,initial.batch.digest)
      const original=(await listSources(f.store,f.library.id)).find(record=>record.relativePath==='a.md'&&record.state==='active')!
      const versionPath=path.join(f.wiki,`.llmwiki/sources/${original.id}/${original.hash}.json`),version=await readFile(versionPath,'utf8'),calls=model.extractionCalls
      const newPath=path.join(f.source,'02-重新编号.md');await rename(original.absolutePath,newPath)
      const scan=await scanLibrary(f.store,f.library.id)
      expect(scan.files.find(file=>file.sourceId===original.id)).toMatchObject({change:'moved',generation:'update'})
      const second=await generateWiki(f.store,f.library.id,model.runtime,new AbortController().signal)
      expect(model.extractionCalls).toBe(calls)
      const preview=await changes.preview(f.library.id,second.batchId!),source=preview.pages.find(page=>page.path===`sources/${original.id}.md`)!
      expect(source.after).toContain(newPath);expect(source.after).not.toContain(original.absolutePath)
      expect(source.after).toContain('image.png');expect(preview.pages.find(page=>page.path==='index.md')!.after).toContain('02-重新编号.md')
      await changes.commit(f.library.id,second.batchId!,preview.batch.digest)
      expect(await readFile(versionPath,'utf8')).toBe(version)
      expect((await listSources(f.store,f.library.id)).find(record=>record.id===original.id)).toMatchObject({absolutePath:newPath,committedPath:newPath,committedHash:original.hash})
      expect((await scanLibrary(f.store,f.library.id)).files.find(file=>file.sourceId===original.id)).toMatchObject({change:'unchanged',needsGeneration:false,generation:'current'})
      expect((await new WikiQuery(f.store).read(`sources/${original.id}.md`)).title).toBe('02-重新编号.md')
    }finally{await f.cleanup()}
  })
  it('长文重编号并新增来源后，新作业沿用缩段结构与叶段证据缓存',async()=>{
    const f=await fixture(),model=fakeModel();let longCalls=0
    const runtime:ModelRuntime={...model.runtime,async *stream(options){
      const input=JSON.parse((options.messages[0]!.content[0] as {text:string}).text)
      if(input.text&&input.text.length>400){longCalls++;yield {type:'finish',reason:{kind:'max-tokens'}};return}
      yield* model.runtime.stream(options)
    }}
    try{
      await writeFile(path.join(f.source,'a.md'),'长'.repeat(900));await scanLibrary(f.store,f.library.id)
      const first=await generateWiki(f.store,f.library.id,runtime,new AbortController().signal),calls=model.extractionCalls,splits=longCalls
      expect(first.chunks.some(chunk=>chunk.status==='split')).toBe(true)
      await rename(path.join(f.source,'a.md'),path.join(f.source,'02-长文.md'))
      await writeFile(path.join(f.source,'新增.md'),'流程青松的初检为19/20。');await scanLibrary(f.store,f.library.id)
      await expect(generateWiki(f.store,f.library.id,runtime,new AbortController().signal,first.id)).rejects.toThrow('资料或处理配置已变化')
      const second=await generateWiki(f.store,f.library.id,runtime,new AbortController().signal)
      expect(second.id).not.toBe(first.id);expect(second.status).toBe('preview');expect(second.sourceTotal).toBe(3)
      expect(longCalls).toBe(splits);expect(model.extractionCalls).toBe(calls+2)
      for(const old of first.chunks.filter(chunk=>chunk.status==='complete'))expect(second.chunks.find(chunk=>chunk.key===old.key)).toEqual(old)
    }finally{await f.cleanup()}
  })
  it('增量综合不能把已登记概念页改成实体类型',async()=>{
    const f=await committedFixture(),model=fakeModel(),preview=f.preview
    try{
      await writeFile(path.join(f.source,'c.md'),'流程青松还需要登记复核人。');await scanLibrary(f.store,f.library.id)
      const reclassified:ModelRuntime={...model.runtime,async *stream(options){
        for await(const event of model.runtime.stream(options)){
          if(event.type==='text-delta'&&event.text.includes('"groups"')){
            const data=JSON.parse(event.text);data.groups[0].type='entity';yield {...event,text:JSON.stringify(data)}
          }else yield event
        }
      }}
      await expect(generateWiki(f.store,f.library.id,reclassified,new AbortController().signal)).rejects.toThrow('既有页面类型')
      expect(await readFile(path.join(f.wiki,preview.pages.find(page=>page.path.startsWith('concepts/'))!.path),'utf8')).toContain('青松初检流程')
    }finally{await f.cleanup()}
  })
  it('增量来源未影响的页面保持原字节和身份，不接受综合措辞漂移',async()=>{
    const f=await fixture();let drift=false
    const runtime:ModelRuntime={async resolveModelInfo(provider,id){return {provider,id,name:id}},async *stream(options){
      const input=JSON.parse((options.messages[0]!.content[0] as {text:string}).text)
      const output=input.claims?{conflicts:input.identity.includes('青松')&&input.claims.length>1?[input.claims.map((claim:{id:string})=>claim.id)]:[]}:input.candidates?{groups:['青松','白桦'].flatMap(subject=>{
        const members=input.candidates.filter((candidate:Candidate)=>candidate.title.includes(subject)) as Candidate[]
        if(!members.length)return []
        const claims=members.flatMap(candidate=>candidate.claims).map(claim=>claim.id)
        return [{type:'concept',title:subject==='白桦'&&drift?'白桦新名称':subject+'流程',identity:subject==='白桦'&&drift?'同一白桦流程的新措辞':subject+'流程',aliases:[],tags:[],members:members.map(candidate=>candidate.id),conflicts:subject==='青松'&&claims.length>1?[claims]:[]}]
      })}:{candidates:[{type:'concept',title:input.text.includes('白桦')?'白桦流程':'青松流程',identity:input.text.includes('白桦')?'白桦流程':'青松流程',aliases:[],tags:[],mentionOnly:false,claims:[{text:input.text,quote:input.text}]}],images:[]}
      yield {type:'text-delta',index:0,text:'groups'in output?groupingResponse(options.system??'',output.groups):JSON.stringify(output)};yield {type:'finish',reason:{kind:'stop'}}
    }}
    try{
      await writeFile(path.join(f.source,'c.md'),'白桦只执行一轮校验。');await scanLibrary(f.store,f.library.id)
      const changes=new ChangeStore(f.store),first=await generateWiki(f.store,f.library.id,runtime,new AbortController().signal)
      const initial=await changes.preview(f.library.id,first.batchId!);await changes.commit(f.library.id,first.batchId!,initial.batch.digest)
      const unrelated=initial.pages.find(page=>page.path.includes('白桦'))!,file=path.join(f.wiki,unrelated.path)
      await writeFile(file,(await readFile(file,'utf8'))+'\n白桦人工补充。\n');const raw=await readFile(file,'utf8')
      drift=true;await writeFile(path.join(f.source,'a.md'),'流程青松的初检为19/20。');await scanLibrary(f.store,f.library.id)
      const second=await generateWiki(f.store,f.library.id,runtime,new AbortController().signal),preview=await changes.preview(f.library.id,second.batchId!)
      expect(preview.pages.some(page=>page.path===unrelated.path)).toBe(false)
      await changes.commit(f.library.id,second.batchId!,preview.batch.digest)
      expect(await readFile(file,'utf8')).toBe(raw)
      expect((await new WikiQuery(f.store).read(unrelated.path)).title).toBe('白桦流程')
    }finally{await f.cleanup()}
  })
  it('扫描发现缺失或新版本时，查询去除失效依据并保留其他来源的知识',async()=>{
    const f=await committedFixture(),preview=f.preview
    try{
      const concept=preview.pages.find(page=>page.path.startsWith('concepts/'))!,physical=await readFile(path.join(f.wiki,concept.path),'utf8')
      await unlink(path.join(f.source,'b.md'));await scanLibrary(f.store,f.library.id)
      const current=await new WikiQuery(f.store).read('青松')
      expect(current.content).toContain('18/20');expect(current.content).not.toContain('17/20')
      expect(await readFile(path.join(f.wiki,concept.path),'utf8')).toBe(physical)
      await writeFile(path.join(f.source,'a.md'),'流程青松的初检为10/20。');await scanLibrary(f.store,f.library.id)
      await expect(new WikiQuery(f.store).read('青松')).rejects.toThrow('未找到')
    }finally{await f.cleanup()}
  })
  it('已提交输入无变化时零解析模型及生成调用，人工区保持字节',async()=>{
    const f=await committedFixture(),preview=f.preview
    try{
      const file=path.join(f.wiki,preview.pages.find(page=>page.path.startsWith('concepts/'))!.path)
      await writeFile(file,(await readFile(file,'utf8'))+'\n人工补充保持。\n');const raw=await readFile(file,'utf8')
      const forbidden:ModelRuntime={async resolveModelInfo(){throw new Error('不应解析模型')},async *stream(){throw new Error('不应调用模型')}}
      const next=await generateWiki(f.store,f.library.id,forbidden,new AbortController().signal)
      expect(next.status).toBe('unchanged');expect(next.attempts).toHaveLength(0);expect(await readFile(file,'utf8')).toBe(raw)
    }finally{await f.cleanup()}
  })
  it('无变化短路仍拒绝未扫描的原文修改',async()=>{
    const f=await committedFixture(),model=fakeModel()
    try{
      await writeFile(path.join(f.source,'a.md'),'来源已编辑尚未扫描。')
      await expect(generateWiki(f.store,f.library.id,model.runtime,new AbortController().signal)).rejects.toThrow('请先扫描')
    }finally{await f.cleanup()}
  })
})
