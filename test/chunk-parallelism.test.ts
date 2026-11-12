// 多来源并发夹具用不同尾字保持独立来源，字数和片段数量不变；完全相同副本另测单次提取。
import { mkdir,readFile,writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach,describe,expect,it,vi } from 'vitest'
import { newLibrary,emptyRegistry } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { scanLibrary } from '../src/ingest/scanner.js'
import { generateWiki,listGenerateJobs } from '../src/wiki/generation.js'
import { ModelCallError } from '../src/llm/client.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { temporaryWorkspace } from './temp.js'
import { mockFixtureSync } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => vi.restoreAllMocks())

const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(done=>{resolve=done});return {promise,resolve}}
const longText='甲乙丙'.split('').map(letter=>letter.repeat(9000)).join('')
async function fixture(text=longText,sources=1){
  const temp=await temporaryWorkspace(),source=path.join(temp.root,'source'),wiki=path.join(temp.root,'wiki')
  mockFixtureSync(temp.root)
  await mkdir(source)
  for(let index=0;index<sources;index++)await writeFile(path.join(source,index+'.md'),index ? text.slice(0,-1)+'丁' : text)
  const library=newLibrary('chunk-parallelism');library.wikiPath=wiki;library.sourceRoots=[source];library.models.unified={provider:'fake',model:'test'}
  const registry=emptyRegistry();registry.libraries=[library];const store=new LibraryStore(()=>registry)
  const view=await store.initialize(library.id)
  await store.savePolicy(library.id,{...view.policy,batchDelayMs:0,analysisConcurrency:sources,pageGenerationConcurrency:2},view.revision)
  await scanLibrary(store,library.id)
  return {...temp,source,wiki,library,store}
}
interface Input {text?:string;round?:number;known?:{title:string}[];source?:string;candidates?:{id:string;title:string}[];limits?:unknown}
function runtime(before:(input:Input,signal:AbortSignal)=>Promise<void>=async()=>{}):ModelRuntime{
  return {async resolveModelInfo(provider,id){return {provider,id,name:id}},async *stream(options){
    const input=JSON.parse((options.messages[0]!.content[0] as {text:string}).text) as Input
    await before(input,options.signal!)
    const output=input.candidates?input.limits?{ids:input.candidates.slice(0,5).map(item=>item.id)}:
      {groups:[{type:'concept',title:'资料知识',identity:'资料知识',aliases:[],tags:[],members:input.candidates.map(item=>item.id),conflicts:[]}]}:
      {candidates:input.round===1?[{type:'concept',title:input.text![0]+'知识',identity:input.text![0]+'知识',aliases:[],tags:[],mentionOnly:false,claims:[{text:input.text!.slice(0,10),quote:input.text!.slice(0,10)}]}]:[],images:[]}
    yield {type:'text-delta',index:0,text:JSON.stringify(output)};yield {type:'finish',reason:{kind:'stop'}}
  }}
}
describe('同篇独立片段并行',()=>{
  it('原始片段逆序完成仍按正文顺序整篇筛选，补充轮次串行且保留已知候选',async()=>{
    const f=await fixture('甲乙丙丁戊己'.split('').map(letter=>letter.repeat(9000)).join('')),first=deferred(),second=deferred()
    const started:string[]=[],rounds=new Map<string,number[]>(),selected:string[][]=[]
    let pending:ReturnType<typeof generateWiki>|undefined
    try{
      const view=await f.store.policy(f.library.id)
      await f.store.savePolicy(f.library.id,{...view.policy,extractionGranularity:'minimal'},view.revision)
      pending=generateWiki(f.store,f.library.id,runtime(async input=>{
        if(input.text){
          const letter=input.text[0]!,seen=rounds.get(letter)??[]
          if(input.round===2){expect(seen).toEqual([1]);expect(input.known).toMatchObject([{title:letter+'知识'}])}
          seen.push(input.round!);rounds.set(letter,seen)
          if(input.round===1){started.push(letter);if(letter==='甲')await first.promise;if(letter==='乙')await second.promise}
        }else if(input.limits){selected.push(input.candidates!.map(item=>item.title));expect(rounds.size).toBe(6)}
      }),new AbortController().signal)
      void pending.catch(()=>{})
      await vi.waitFor(()=>expect([...started].sort()).toEqual(['甲','乙'].sort()));second.resolve()
      await vi.waitFor(()=>expect(started).toContain('己'));expect(selected).toEqual([])
      first.resolve();const job=await pending
      expect(job.status).toBe('preview');expect(job.sourcesCompleted).toBe(1)
      expect(selected).toEqual([['甲知识','乙知识','丙知识','丁知识','戊知识','己知识']])
      expect(job.chunks.filter(chunk=>chunk.status==='complete')).toHaveLength(6)
      for(const seen of rounds.values())expect(seen).toEqual([1,2])
    }finally{first.resolve();second.resolve();await pending?.catch(()=>{});await f.cleanup()}
  })
  it('递归缩段叶分支并发且完整覆盖，单槽接续复用相同分析指纹和叶段缓存',async()=>{
    const text='甲乙丙丁'.split('').map(letter=>letter.repeat(400)).join(''),f=await fixture(text),barrier=deferred()
    let active=0,peak=0,leaves=0
    try{
      const model=runtime(async input=>{
        if(!input.text)return
        if(input.text.length>400)throw new ModelCallError('模拟截断','max-tokens')
        if(input.round!==1)return
        peak=Math.max(peak,++active);leaves++;if(leaves===2)barrier.resolve();await barrier.promise;active--
      })
      const first=await generateWiki(f.store,f.library.id,model,new AbortController().signal)
      expect(peak).toBe(2);expect(first.chunks.filter(chunk=>chunk.status==='split')).toHaveLength(3)
      const completed=first.chunks.filter(chunk=>chunk.status==='complete').sort((a,b)=>a.start-b.start)
      expect(completed.map(chunk=>[chunk.start,chunk.end])).toEqual([[0,400],[400,800],[800,1200],[1200,1600]])
      const view=await f.store.policy(f.library.id)
      await f.store.savePolicy(f.library.id,{...view.policy,pageGenerationConcurrency:1},view.revision)
      const second=await generateWiki(f.store,f.library.id,runtime(async input=>{expect(input.text).toBeUndefined()}),new AbortController().signal)
      expect(second.analysisFingerprint).toBe(first.analysisFingerprint)
      for(const old of completed)expect(second.chunks.find(chunk=>chunk.key===old.key)).toEqual(old)
      expect(second.status).toBe('preview')
    }finally{barrier.resolve();await f.cleanup()}
  })
  it('分支失败等待兄弟流清理，保留成功叶段并在原作业接续时跳过已完成请求',async()=>{
    const f=await fixture(),failed=deferred(),cleanup=deferred(),abort=new AbortController();let settled=false
    try{
      const model=runtime(async(input,signal)=>{
        if(!input.text)return
        if(input.text[0]==='乙'){
          await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))
          failed.resolve();await cleanup.promise;signal.throwIfAborted()
        }
        if(input.text[0]==='丙')throw new Error('模拟独立片段失败')
      })
      const pending=generateWiki(f.store,f.library.id,model,abort.signal).catch(error=>{settled=true;return error})
      await failed.promise;expect(settled).toBe(false)
      expect((await listGenerateJobs(f.store,f.library.id))[0]!.status).toBe('running')
      cleanup.resolve();expect((await pending).message).toBe('模拟独立片段失败')
      const stopped=(await listGenerateJobs(f.store,f.library.id))[0]!,completed=stopped.chunks.find(chunk=>chunk.status==='complete')!
      expect(stopped.status).toBe('failed');expect(stopped.sourcesCompleted).toBe(0);expect(completed.start).toBe(0)
      expect(stopped.chunks.find(chunk=>chunk.start===9000)!.status).toBe('pending')
      expect(stopped.chunks.find(chunk=>chunk.start===18000)!.status).toBe('failed')
      const cache=path.join(f.wiki,'.llmwiki/analysis',completed.key+'.json'),before=await readFile(cache,'utf8')
      const resumed=await generateWiki(f.store,f.library.id,runtime(async input=>{if(input.text)expect(input.text[0]).not.toBe('甲')}),new AbortController().signal,stopped.id)
      expect(resumed.status).toBe('preview');expect(resumed.sourcesCompleted).toBe(1);expect(resumed.analysisFingerprint).toBe(stopped.analysisFingerprint)
      expect(resumed.chunks.find(chunk=>chunk.key===completed.key)).toEqual(completed);expect(await readFile(cache,'utf8')).toBe(before)
    }finally{abort.abort();cleanup.resolve();await f.cleanup()}
  })
  it('用户取消停止未开始片段，等待全部在途流退出后落可续作状态',async()=>{
    const f=await fixture(),abort=new AbortController(),cleanup=deferred(),started:string[]=[],exited:string[]=[];let settled=false
    try{
      const model=runtime(async(input,signal)=>{
        if(!input.text)return
        const letter=input.text[0]!;started.push(letter)
        await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}))
        await cleanup.promise;exited.push(letter);signal.throwIfAborted()
      })
      const pending=generateWiki(f.store,f.library.id,model,abort.signal).catch(error=>{settled=true;return error})
      await vi.waitFor(()=>expect(started).toHaveLength(2));abort.abort(new Error('用户取消'))
      await Promise.resolve();expect(settled).toBe(false);expect(exited).toEqual([])
      cleanup.resolve();expect((await pending).message).toBe('用户取消');expect(exited.sort()).toEqual(['乙','甲'].sort())
      expect(started.sort()).toEqual(['乙','甲'].sort())
      const stopped=(await listGenerateJobs(f.store,f.library.id))[0]!
      expect(stopped.status).toBe('cancelled');expect(stopped.sourcesCompleted).toBe(0);expect(stopped.chunks.every(chunk=>chunk.status==='pending')).toBe(true)
      const resumed=await generateWiki(f.store,f.library.id,runtime(),new AbortController().signal,stopped.id)
      expect(resumed.status).toBe('preview');expect(resumed.chunks.filter(chunk=>chunk.status==='complete')).toHaveLength(3)
    }finally{abort.abort();cleanup.resolve();await f.cleanup()}
  })
  it('多个来源的独立片段共享全库模型上限，完成来源数不按片段累加',async()=>{
    const f=await fixture(longText,2),barrier=deferred();let active=0,peak=0,started=0
    let pending:ReturnType<typeof generateWiki>|undefined
    try{
      pending=generateWiki(f.store,f.library.id,runtime(async input=>{
        if(!input.text)return
        peak=Math.max(peak,++active);started++;await barrier.promise;active--
      }),new AbortController().signal)
      void pending.catch(()=>{})
      await vi.waitFor(()=>expect(started).toBe(2));expect(active).toBe(2);barrier.resolve()
      const job=await pending;expect(peak).toBe(2);expect(active).toBe(0);expect(job.sourceTotal).toBe(2);expect(job.sourcesCompleted).toBe(2)
      expect(job.chunks.filter(chunk=>chunk.status==='complete')).toHaveLength(6)
    }finally{barrier.resolve();await pending?.catch(()=>{});await f.cleanup()}
  })
})
