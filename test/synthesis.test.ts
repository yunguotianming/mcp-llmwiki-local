import { describe,expect,it } from 'vitest'
import type { Candidate } from '../src/ingest/extraction.js'
import { ModelCallError } from '../src/llm/client.js'
import { synthesize } from '../src/wiki/synthesis.js'
import type { SynthesisCandidate,SynthesisCheckpoint } from '../src/wiki/synthesis.js'
import { groupingResponse } from './synthesis-fixture.js'
function fixture(){
  const candidates:Candidate[]=Array.from({length:12},(_,index)=>({id:'candidate-'+index,type:'concept',title:'同名流程',identity:index%2?'医学流程':'材料流程',aliases:[],tags:[],
    claims:[{id:'claim-'+index,text:'条件说明。'.repeat(25)+index,evidence:{sourceId:'source-'+index,hash:'hash',chunkId:'chunk',quote:'原始出处。'.repeat(25)+index,cleanStart:0,originalStart:0,line:1}}]}))
  const seen:string[][]=[],compared=new Set<string>()
  let calls=0,failAt=0,truncated=false
  const call=async(system:string,input:string)=>{
    calls++;if(calls===failAt)throw new Error('模拟综合中断')
    const data=JSON.parse(input)
    expect(Buffer.byteLength(input)).toBeLessThanOrEqual(4200)
    if(data.claims){
      for(const a of data.claims)for(const b of data.claims)if(a.id!==b.id)compared.add([a.sourceId.replace('source','claim'),b.sourceId.replace('source','claim')].sort().join(':'))
      const pair=data.claims.filter((claim:{sourceId:string})=>['source-0','source-10'].includes(claim.sourceId))
      return JSON.stringify({conflicts:pair.length===2?[pair.map((claim:{id:string})=>claim.id)]:[]})
    }
    seen.push(data.candidates.map((candidate:{id:string})=>candidate.id))
    if(truncated&&data.candidates.length>2)throw new ModelCallError('输出截断','max-tokens')
    const identities=[...new Set(data.candidates.map((candidate:{identity:string})=>candidate.identity))]
    return groupingResponse(system,identities.map(identity=>({type:'concept',title:'同名流程',identity,aliases:[],tags:[],members:data.candidates.filter((candidate:{identity:string})=>candidate.identity===identity).map((candidate:{id:string})=>candidate.id),conflicts:[]})))
  }
  return {candidates,call,seen,compared,get calls(){return calls},failNext(){failAt=calls+2},truncate(){truncated=true}}
}
const signal=()=>new AbortController().signal
describe('有界分级综合',()=>{
  it('全部候选跨块协调身份，同名不同对象分开，跨块冲突得到比较',async()=>{
    const f=fixture(),checkpoints:SynthesisCheckpoint[]=[]
    const groups=await synthesize(f.candidates,null,4200,f.call,checkpoints,async()=>{},signal())
    expect(groups).toHaveLength(2);expect(groups.flatMap(group=>group.members).sort()).toEqual(f.candidates.map(candidate=>candidate.id).sort())
    const material=groups.find(group=>group.identity==='材料流程')!
    expect(material.conflicts).toContainEqual(['claim-0','claim-10'])
    for(const group of groups)for(const a of group.members)for(const b of group.members)if(a!==b)expect(f.compared.has([a.replace('candidate','claim'),b.replace('candidate','claim')].sort().join(':'))).toBe(true)
    expect(checkpoints.length).toBeGreaterThan(2)
  })
  it('综合中断可复用已校验检查点，输出截断继续拆批而不丢成员',async()=>{
    const f=fixture(),checkpoints:SynthesisCheckpoint[]=[];f.failNext()
    await expect(synthesize(f.candidates,null,4200,f.call,checkpoints,async()=>{},signal())).rejects.toThrow('模拟综合中断')
    expect(checkpoints).toHaveLength(1);const first=JSON.stringify(checkpoints[0]!)
    f.truncate()
    const groups=await synthesize(f.candidates,null,4200,f.call,checkpoints,async()=>{},signal())
    expect(groups.flatMap(group=>group.members)).toHaveLength(12)
    expect(checkpoints.filter(item=>JSON.stringify(item)===first)).toHaveLength(1)
  })
  it('无效候选与冲突输出不进入可复用检查点',async()=>{
    const f=fixture(),checkpoints:SynthesisCheckpoint[]=[]
    await expect(synthesize(f.candidates,null,4200,async()=>JSON.stringify({groups:[],singletons:[]}),checkpoints,async()=>{},signal())).rejects.toThrow('未覆盖全部候选')
    expect(checkpoints).toHaveLength(0)
  })
  it('身份阶段省略空 conflicts 仍保留全部成员，并在后续核对真实冲突',async()=>{
    const f=fixture(),checkpoints:SynthesisCheckpoint[]=[]
    const groups=await synthesize(f.candidates,null,4200,async(system,input)=>{
      const output=JSON.parse(await f.call(system,input)),data=JSON.parse(input)
      if(data.candidates?.every((candidate:{claims:unknown[]})=>candidate.claims.length===0))for(const group of output.groups)delete group.conflicts
      return JSON.stringify(output)
    },checkpoints,async()=>{},signal())
    expect(groups.flatMap(group=>group.members).sort()).toEqual(f.candidates.map(candidate=>candidate.id).sort())
    expect(groups.find(group=>group.identity==='材料流程')!.conflicts).toContainEqual(['claim-0','claim-10'])
  })
  it('正式综合缺少 conflicts 时拒绝结果，不缓存未经冲突核对的输出',async()=>{
    const f=fixture(),checkpoints:SynthesisCheckpoint[]=[]
    await expect(synthesize(f.candidates,null,100000,async()=>JSON.stringify({groups:f.candidates.map(candidate=>({
      type:candidate.type,title:candidate.title,identity:candidate.identity,aliases:[],tags:[],members:[candidate.id],
    }))}),checkpoints,async()=>{},signal())).rejects.toThrow()
    expect(checkpoints).toHaveLength(0)
  })
  it('身份阶段不接受非空 conflicts',async()=>{
    const f=fixture(),checkpoints:SynthesisCheckpoint[]=[]
    await expect(synthesize(f.candidates,null,4200,async(system,input)=>{
      const output=JSON.parse(await f.call(system,input));if(output.groups.length)output.groups[0].conflicts=[['claim-ref-1','claim-ref-2']]
      return JSON.stringify(output)
    },checkpoints,async()=>{},signal())).rejects.toThrow()
    expect(checkpoints).toHaveLength(0)
  })
  it('综合统一同一对象的新候选分类，保留全部主张与冲突',async()=>{
    const f=fixture();f.candidates[0]!.type='entity'
    const groups=await synthesize(f.candidates,null,4200,f.call,[],async()=>{},signal())
    expect(groups.flatMap(group=>group.members).sort()).toEqual(f.candidates.map(candidate=>candidate.id).sort())
    expect(groups.find(group=>group.identity==='材料流程')!.conflicts).toContainEqual(['claim-0','claim-10'])
  })
  it('既有页面分类固定，综合不能改变类型',async()=>{
    const f=fixture(),candidates:SynthesisCandidate[]=f.candidates;candidates[0]={...candidates[0]!,type:'entity',fixedType:true}
    await expect(synthesize(candidates,null,4200,f.call,[],async()=>{},signal())).rejects.toThrow('既有页面类型')
  })
})
