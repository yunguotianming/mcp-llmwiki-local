import { expect,it } from 'vitest'
import type { Candidate } from '../src/ingest/extraction.js'
import { synthesize } from '../src/wiki/synthesis.js'
import { groupingResponse } from './synthesis-fixture.js'

function candidate(id:string,title:string,identity:string,aliases:string[]=[]):Candidate{return {id,type:'concept',title,identity,aliases,tags:[],claims:[{id:'claim-'+id,text:'完整主张。'.repeat(100),evidence:{sourceId:id,hash:'hash',chunkId:'chunk',quote:'完整引文。'.repeat(100),cleanStart:0,originalStart:0,line:1}}]}}
const filler=()=>Array.from({length:65},(_,i)=>candidate('x'+i,'Term'+i,'Description'+i))
it('相关检索只让命中项进入身份调用，未命中项仍保留全部成员与证据',async()=>{
  const items=[...filler(),candidate('a','临床协调员','访视管理',['CRC']),candidate('b','CRC','访视管理')],requests:unknown[]=[]
  const groups=await synthesize(items,null,8000,async(_system,input)=>{
    const data=JSON.parse(input);requests.push(data)
    if(data.claims)return JSON.stringify({conflicts:[data.claims.map((item:{id:string})=>item.id)]})
    expect(data.candidates.map((item:Candidate)=>item.id)).toEqual(['candidate-ref-1','candidate-ref-2'])
    expect(data.candidates.map((item:Candidate)=>item.identity)).toEqual(['访视管理','访视管理'])
    return groupingResponse(_system,[{type:'concept',title:'研究协调员',identity:'访视管理',aliases:[],tags:[],members:data.candidates.map((item:Candidate)=>item.id),conflicts:[]}])
  },[],async()=>{},new AbortController().signal)
  expect(groups).toHaveLength(66);expect(groups.flatMap(group=>group.members).sort()).toEqual(items.map(item=>item.id).sort())
  expect(groups.find(group=>group.members.includes('a'))!.conflicts).toEqual([['claim-a','claim-b']])
  expect(requests).toHaveLength(2)
})
it('同名但不同语境仍交模型区分，不按标题自动合并',async()=>{
  const items=[...filler(),candidate('a','CRC','临床研究协调员'),candidate('b','CRC','循环冗余校验')]
  const groups=await synthesize(items,null,8000,async(_system,input)=>{
    const data=JSON.parse(input);expect(data.candidates.map((item:Candidate)=>item.id)).toEqual(['candidate-ref-1','candidate-ref-2'])
    return groupingResponse(_system,data.candidates.map((item:Candidate)=>({type:item.type,title:item.title,identity:item.identity,aliases:[],tags:[],members:[item.id],conflicts:[]})))
  },[],async()=>{},new AbortController().signal)
  expect(groups).toHaveLength(67);expect(groups.filter(group=>group.title==='CRC')).toHaveLength(2)
})
