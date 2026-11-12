import { expect,it } from 'vitest'
import type { Candidate } from '../src/ingest/extraction.js'
import { ModelCallError } from '../src/llm/client.js'
import { synthesize } from '../src/wiki/synthesis.js'
import type { SynthesisCheckpoint } from '../src/wiki/synthesis.js'
import { groupingResponse } from './synthesis-fixture.js'

function fixture(count:number,limit:number){
  const candidates:Candidate[]=Array.from({length:count},(_,index)=>({id:'candidate-'+index,type:'concept',title:'主题'+index,identity:'独立对象'+index,aliases:[],tags:[],
    claims:[{id:'claim-'+index,text:'详细正文。'.repeat(100),evidence:{sourceId:'source-'+index,hash:'hash',chunkId:'chunk',quote:'原文依据。'.repeat(100),cleanStart:0,originalStart:0,line:1}}]}))
  const compared=new Set<string>(),inputs:string[]=[]
  const call=async(_system:string,input:string)=>{
    const data=JSON.parse(input),items=data.candidates as Candidate[]
    expect(items).toBeDefined();inputs.push(input)
    expect(new Set(items.map(item=>item.id)).size).toBe(items.length)
    if(items.length>limit)throw new ModelCallError('模拟响应容量不足','max-tokens')
    for(const a of items)for(const b of items)if(a.id!==b.id)compared.add([a.identity,b.identity].sort().join(':'))
    return groupingResponse(_system,items.map(item=>({type:item.type,title:item.title,identity:item.identity,aliases:[],tags:[],members:[item.id],conflicts:[]})))
  }
  return {candidates,compared,inputs,call}
}
it('大组失败继续按交叉块缩批，32候选的全部496对仍覆盖且请求少于80次',async()=>{
  const f=fixture(32,8),checkpoints:SynthesisCheckpoint[]=[]
  const groups=await synthesize(f.candidates,null,12000,f.call,checkpoints,async()=>{},new AbortController().signal,undefined,5)
  expect(groups.flatMap(group=>group.members).sort()).toEqual(f.candidates.map(item=>item.id).sort())
  expect(f.compared.size).toBe(496);expect(f.inputs.length).toBeLessThan(80)
  expect(new Set(f.inputs).size).toBe(f.inputs.length)
  const bytes=JSON.stringify(checkpoints),before=f.inputs.length
  expect(await synthesize(f.candidates,null,12000,f.call,checkpoints,async()=>{},new AbortController().signal,undefined,5)).toEqual(groups)
  expect(f.inputs.slice(before).every(input=>JSON.parse(input).candidates.length>8)).toBe(true)
  expect(JSON.stringify(checkpoints)).toBe(bytes)
})
it('奇数分组和不对称交叉区缩到三项，全部候选对不遗漏也不产生重复成员',async()=>{
  const f=fixture(9,3)
  const groups=await synthesize(f.candidates,null,7000,f.call,[],async()=>{},new AbortController().signal,undefined,3)
  expect(groups).toHaveLength(9);expect(f.compared.size).toBe(36)
})
