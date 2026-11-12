import { expect, it } from 'vitest'
import type { Candidate, Claim } from '../src/ingest/extraction.js'
import { synthesize } from '../src/wiki/synthesis.js'
import { groupingResponse } from './synthesis-fixture.js'

const claim=(id:string):Claim=>({id,text:'同一条件的观察'+id,evidence:{sourceId:id,hash:'v1',chunkId:id,quote:'原文'+id,cleanStart:0,originalStart:0,line:1}})
async function run(old:Claim[],current:Claim[]){
  const compared:string[][]=[]
  const candidates:Candidate[]=current.map(item=>({id:'candidate-'+item.id,type:'concept',title:'流程',identity:'同一流程',aliases:[],tags:[],claims:[item]}))
  const groups=await synthesize(candidates,null,5000,async(_system,input)=>{
    const data=JSON.parse(input)
    if(data.claims){compared.push(data.claims.map((item:{sourceId:string})=>item.sourceId));return JSON.stringify({conflicts:[]})}
    return groupingResponse(_system,[{type:'concept',title:'流程',identity:'同一流程',aliases:[],tags:[],members:data.candidates.map((item:Candidate)=>item.id),conflicts:[]}])
  },[],async()=>{},new AbortController().signal,'zh',3,[{identity:'同一流程',claims:old,conflicts:[old.map(item=>item.id)]}])
  return {groups,compared}
}
it('新增主张只比较新旧交叉范围，原多主张冲突组完整保留',async()=>{
  const old=[claim('a'),claim('b'),claim('c')],fresh=claim('d'),result=await run(old,[...old,fresh])
  expect(result.groups[0]!.conflicts).toContainEqual(['a','b','c'])
  expect(result.compared.length).toBeGreaterThan(0)
  expect(result.compared.every(ids=>ids.includes('d'))).toBe(true)
  for(const id of ['a','b','c'])expect(result.compared.some(ids=>ids.includes(id)&&ids.includes('d'))).toBe(true)
})
it('完整旧范围未变化时，不再调用冲突模型',async()=>{
  const old=[claim('a'),claim('b'),claim('c')],result=await run(old,old)
  expect(result.compared).toEqual([]);expect(result.groups[0]!.conflicts).toEqual([['a','b','c']])
})
it('旧主张证据版本改变时拒绝复用完整组，重新覆盖当前范围',async()=>{
  const old=[claim('a'),claim('b'),claim('c')],current=structuredClone(old);current[1]!.evidence.hash='v2'
  const result=await run(old,current)
  expect(result.compared.some(ids=>ids.includes('a')&&ids.includes('b')&&ids.includes('c'))).toBe(true)
  expect(result.groups[0]!.conflicts).toEqual([])
})
