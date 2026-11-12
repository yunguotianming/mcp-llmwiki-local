import { mkdir,writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect,it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { checkEvidence,reviewEvidence } from '../src/wiki/evidence-check.js'
import type { EvidenceReviewItem } from '../src/wiki/evidence-check.js'
import { defaultPolicy } from '../src/domain/policy.js'
import { newLibrary } from '../src/domain/config.js'
import { ModelClient,ModelCallError } from '../src/llm/client.js'
import type { ModelRuntime } from '../src/llm/client.js'
import type { KnowledgeCatalog } from '../src/wiki/documents.js'
import { signature } from '../src/storage/files.js'
import { temporaryWorkspace } from './temp.js'
const item=(id:string):EvidenceReviewItem=>({path:'concepts/a.md',claim:{id,text:'事实'+id,evidence:{sourceId:'source',hash:'hash',chunkId:'chunk',quote:'事实'+id,cleanStart:0,originalStart:0,line:1}}})
function client(output:(input:{items:{id:string}[]})=>unknown){
  const library=newLibrary('evidence');library.models.unified={provider:'fake',model:'test'};const policy=defaultPolicy();policy.batchDelayMs=0
  const runtime:ModelRuntime={async resolveModelInfo(provider,id){return {provider,id,name:id}},async *stream(options):AsyncIterable<StreamChunk>{
    const input=JSON.parse((options.messages[0]!.content[0] as {text:string}).text)
    yield {type:'text-delta',index:0,text:JSON.stringify(output(input))};yield {type:'finish',reason:{kind:'stop'}}
  }}
  return new ModelClient(runtime,library,policy)
}
it('L1缺失来源与L2错误定位只出报告，不改变主张或引文',async()=>{
  const temp=await temporaryWorkspace(),text='真实原文',hash=signature(text),catalog:KnowledgeCatalog={version:1,pages:[{path:'concepts/a.md',type:'concept',title:'知识',identity:'知识',aliases:[],tags:[],conflicts:[],blockHash:'',claims:[item('a').claim,item('b').claim]}]}
  try{
    catalog.pages[0]!.claims[0]!.evidence.hash=hash;catalog.pages[0]!.claims[0]!.evidence.quote='未定位引文'
    await mkdir(path.join(temp.root,'.llmwiki/sources/source'),{recursive:true});await mkdir(path.join(temp.root,'.llmwiki/objects'))
    await writeFile(path.join(temp.root,'.llmwiki/sources/source',hash+'.json'),JSON.stringify({hash,textObject:hash}));await writeFile(path.join(temp.root,'.llmwiki/objects',hash),text)
    const before=JSON.stringify(catalog),result=await checkEvidence(temp.root,catalog)
    expect(result.issues.map(i=>i.level)).toEqual(['L2','L1']);expect(result.items).toEqual([]);expect(JSON.stringify(catalog)).toBe(before)
  }finally{await temp.cleanup()}
})
it('归一化字面差异仍由L2报告，不能伪装为已保存的逐字引文',async()=>{
  const temp=await temporaryWorkspace(),text='CRNs prepare the protocol.',hash=signature(text),c=item('a').claim;c.evidence.hash=hash;c.evidence.quote=text.toLowerCase()
  try{
    await mkdir(path.join(temp.root,'.llmwiki/sources/source'),{recursive:true});await mkdir(path.join(temp.root,'.llmwiki/objects'))
    await writeFile(path.join(temp.root,'.llmwiki/sources/source',hash+'.json'),JSON.stringify({hash,textObject:hash}));await writeFile(path.join(temp.root,'.llmwiki/objects',hash),text)
    const result=await checkEvidence(temp.root,{version:1,pages:[{path:'concepts/a.md',type:'concept',title:'知识',identity:'知识',aliases:[],tags:[],claims:[c],conflicts:[],blockHash:''}]})
    expect(result.grounded).toBe(0);expect(result.issues[0]!.level).toBe('L2')
  }finally{await temp.cleanup()}
})
it('L3核对全部分句并记录待确认项，不自动重写知识',async()=>{
  const items=[item('a'),item('b')],before=JSON.stringify(items),model=client(input=>({checks:input.items.map((c,index)=>({id:c.id,supported:index===0,reason:index===0?'原文支持':'条件未获支持'}))}))
  const result=await reviewEvidence(items,model,7000,2,new AbortController().signal)
  expect(result.checked).toBe(2);expect(result.issues).toMatchObject([{kind:'semantic',level:'L3',claimId:'b',message:'条件未获支持',repairable:false}]);expect(JSON.stringify(items)).toBe(before)
})
it('语义模型不可用时保留报告和待复核状态',async()=>{
  const result=await reviewEvidence([item('a')],client(()=>{throw new ModelCallError('上游503','HTTP503',503)}),7000,2,new AbortController().signal)
  expect(result.checked).toBe(0);expect(result.issues[0]!.message).toContain('语义复核中断')
})
it('重复或未知复核编号有界拒绝，不把未审核条目计为通过',async()=>{
  const model=client(()=>({checks:[{id:'unknown',supported:true,reason:'错误编号'}]})),result=await reviewEvidence([item('a')],model,7000,1,new AbortController().signal)
  expect(result.checked).toBe(0);expect(model.attempts).toHaveLength(2);expect(result.issues[0]!.level).toBe('L3')
})
