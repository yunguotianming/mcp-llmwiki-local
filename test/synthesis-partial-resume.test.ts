import { expect,it } from 'vitest'
import type { Candidate,Claim } from '../src/ingest/extraction.js'
import { synthesize } from '../src/wiki/synthesis.js'
import { groupingResponse } from './synthesis-fixture.js'
const claims:Claim[]=['a','b'].map(id=>({id,text:'事实'+id,evidence:{sourceId:'source',hash:'hash',chunkId:'chunk',quote:'原文'+id,cleanStart:0,originalStart:0,line:1}}))
const candidate:Candidate={id:'candidate',type:'concept',title:'主题',identity:'主题',aliases:[],tags:[],claims}

it('部分比较再次生成会重试原缺口，并保留旧已确认冲突',async()=>{
  let comparisons=0
  const groups=await synthesize([candidate],null,7000,async(system,input)=>{
    const data=JSON.parse(input)
    if(data.claims){comparisons++;return JSON.stringify({conflicts:[]})}
    return groupingResponse(system,[])
  },[],async()=>{},new AbortController().signal,'zh',2,[{identity:'主题',claims,conflicts:[['a','b']],complete:false}],()=>{})
  expect(comparisons).toBe(1);expect(groups[0]!.conflicts).toEqual([['a','b']])
})
it('原缺口再次失败仍报告待复核，不能用旧主张集合冒充完整比较',async()=>{
  let issues=0
  const groups=await synthesize([candidate],null,7000,async()=>'{invalid',[],async()=>{},new AbortController().signal,'zh',2,[{identity:'主题',claims,conflicts:[],complete:false}],()=>{issues++})
  expect(issues).toBe(1);expect(groups[0]!.members).toEqual(['candidate'])
})
