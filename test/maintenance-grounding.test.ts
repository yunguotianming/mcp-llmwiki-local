import { mkdir,readFile,writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect,it } from 'vitest'
import { emptyRegistry,newLibrary } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { checkWiki } from '../src/wiki/maintenance.js'
import { signature,writeState } from '../src/storage/files.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { temporaryWorkspace } from './temp.js'

async function fixture(){
  const temp=await temporaryWorkspace(),library=newLibrary('grounding');library.wikiPath=temp.root;library.models.unified={provider:'fake',model:'test'}
  const registry=emptyRegistry();registry.libraries=[library];const store=new LibraryStore(()=>registry);await store.initialize(library.id)
  const text='干预仅在成人组观察到改善。',hash=signature(text),file=path.join(temp.root,'concepts/a.md'),raw='# 干预\n\n'+text
  await mkdir(path.dirname(file),{recursive:true});await writeFile(file,raw)
  await mkdir(path.join(temp.root,'.llmwiki/objects'),{recursive:true});await writeFile(path.join(temp.root,'.llmwiki/objects',hash),text)
  await writeState(temp.root,'.llmwiki/sources/source/'+hash+'.json',{hash,textObject:hash})
  await writeState(temp.root,'.llmwiki/knowledge/catalog.json',{version:1,pages:[{path:'concepts/a.md',title:'干预',type:'concept',identity:'干预',aliases:[],tags:[],conflicts:[],blockHash:'',claims:[{id:'claim',text,evidence:{sourceId:'source',hash,quote:text,cleanStart:0,originalStart:0,line:1,chunkId:'chunk'}}]}]})
  return {...temp,store,library,file,raw}
}
it('智能检查模型信息不可用时返回L2结果及L3待复核报告，页面字节不变',async()=>{
  const f=await fixture()
  try{
    const runtime:ModelRuntime={async resolveModelInfo(){throw new Error('模型未连接')},async *stream(){throw new Error('不应发起请求')}}
    const report=await checkWiki(f.store,f.library.id,new AbortController().signal,runtime)
    expect(report.grounding).toMatchObject({checked:1,grounded:1,semanticChecked:0,pendingSemantic:1})
    expect(report.issues).toContainEqual(expect.objectContaining({kind:'semantic',level:'L3',message:expect.stringContaining('模型未连接')}))
    expect(await readFile(f.file,'utf8')).toBe(f.raw)
  }finally{await f.cleanup()}
})
it('程序检查只核对定位不调用模型，智能复核逐分句留报告不改写',async()=>{
  const f=await fixture();let calls=0
  try{
    const program=await checkWiki(f.store,f.library.id);expect(program.grounding?.pendingSemantic).toBe(1)
    const runtime:ModelRuntime={async resolveModelInfo(provider,id){return {provider,id,name:id}},async *stream(){calls++;yield {type:'text-delta',index:0,text:JSON.stringify({checks:[{id:'claim-0',supported:false,reason:'条件需人工确认'}]})};yield {type:'finish',reason:{kind:'stop'}}}}
    const report=await checkWiki(f.store,f.library.id,new AbortController().signal,runtime)
    expect(calls).toBe(1);expect(report.grounding).toMatchObject({semanticChecked:1,pendingSemantic:0})
    expect(report.issues).toContainEqual(expect.objectContaining({kind:'semantic',level:'L3',claimId:'claim',message:'条件需人工确认',repairable:false}))
    expect(await readFile(f.file,'utf8')).toBe(f.raw)
  }finally{await f.cleanup()}
})
