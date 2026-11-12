import { expect,it } from 'vitest'
import type { Candidate } from '../src/ingest/extraction.js'
import { ModelCallError } from '../src/llm/client.js'
import { signature } from '../src/storage/files.js'
import { GROUP_PROMPT,synthesize } from '../src/wiki/synthesis.js'
import type { SynthesisCheckpoint } from '../src/wiki/synthesis.js'

const candidates:Candidate[]=Array.from({length:3},(_,index)=>({id:String(index).padStart(64,'a'),type:'concept',title:'主题'+index,identity:'语境'+index,aliases:['别名'+index],tags:['标签'+index],
  claims:[{id:String(index).padStart(64,'b'),text:'条件'+index,evidence:{sourceId:'source-'+index,hash:'version',chunkId:'chunk',quote:'完整原文'+index,cleanStart:0,originalStart:0,line:1}}]}))
const signal=()=>new AbortController().signal
const group=(members:string[])=>({type:'concept',title:'归并主题',identity:'归并语境',aliases:['统一别名'],tags:['主题'],members})
// 已有冲突覆盖令测试直接进入分层路径，候选与事实仍使用正常完整输入。
const prior=[{identity:'其他对象',claims:[],conflicts:[]}]

it('首次身份请求使用短编号，明确确认的全部单例逐字段保留',async()=>{
  const checkpoints:SynthesisCheckpoint[]=[],before=JSON.stringify(candidates)
  const result=await synthesize(candidates,null,36000,async(system,input)=>{
    const data=JSON.parse(input)
    expect(system).toContain('"singletons"');expect(data.validationFeedback).toBeUndefined()
    expect(data.candidates.map((item:Candidate)=>item.id)).toEqual(['candidate-ref-1','candidate-ref-2','candidate-ref-3'])
    expect(input).not.toContain(candidates[0]!.id)
    return JSON.stringify({groups:[],singletons:data.candidates.map((item:Candidate)=>item.id)})
  },checkpoints,async()=>{},signal(),'zh',3,prior)
  expect(result).toEqual(candidates.map(({claims:_,...item})=>({...item,members:[item.id],conflicts:[]})))
  expect(JSON.stringify(candidates)).toBe(before);expect(JSON.stringify(checkpoints)).not.toContain('-ref-')
})
it('紧凑合并与单例完整覆盖，归并主张仍进入后续冲突核对',async()=>{
  const seen:string[][]=[]
  const result=await synthesize(candidates,null,36000,async(_system,input)=>{
    const data=JSON.parse(input)
    if(data.claims){seen.push(data.claims.map((item:{sourceId:string})=>item.sourceId));return JSON.stringify({conflicts:[data.claims.map((item:{id:string})=>item.id)]})}
    const ids=data.candidates.map((item:Candidate)=>item.id)
    return JSON.stringify(data.candidates.length===3?{groups:[group(ids.slice(0,2))],singletons:ids.slice(2)}:{groups:[],singletons:ids})
  },[],async()=>{},signal(),'zh',3,prior)
  expect(result.flatMap(item=>item.members).sort()).toEqual(candidates.map(item=>item.id).sort())
  expect(result.find(item=>item.members.length===2)!.conflicts).toEqual([candidates.slice(0,2).map(item=>item.claims[0]!.id)])
  expect(seen).toEqual([['source-0','source-1']])
})
it('遗漏单例即使声称完成仍拒绝，不缓存失败输出',async()=>{
  const checkpoints:SynthesisCheckpoint[]=[];let calls=0
  await expect(synthesize(candidates,null,36000,async()=>{calls++;return JSON.stringify({groups:[],singletons:['candidate-ref-1']})},checkpoints,async()=>{},signal(),'zh',3,prior)).rejects.toThrow('未覆盖全部候选')
  expect(calls).toBe(2);expect(checkpoints).toEqual([])
})
it('合并组与单例重复引用同一编号时拒绝',async()=>{
  await expect(synthesize(candidates,null,36000,async()=>JSON.stringify({groups:[group(['candidate-ref-1','candidate-ref-2'])],singletons:['candidate-ref-2','candidate-ref-3']}),[],async()=>{},signal(),'zh',3,prior)).rejects.toThrow('重复')
})
it('单例混用主张编号或未知编号时拒绝',async()=>{
  await expect(synthesize(candidates,null,36000,async()=>JSON.stringify({groups:[],singletons:['claim-ref-1','candidate-ref-2','candidate-ref-3']}),[],async()=>{},signal(),'zh',3,prior)).rejects.toThrow('未知候选或主张编号')
})
it('紧凑身份不能将固定分类的既有页改成其他类型',async()=>{
  const fixed=[{...candidates[0]!,type:'entity' as const,fixedType:true as const},...candidates.slice(1)]
  await expect(synthesize(fixed,null,36000,async()=>JSON.stringify({groups:[group(['candidate-ref-1','candidate-ref-2'])],singletons:['candidate-ref-3']}),[],async()=>{},signal(),'zh',3,prior)).rejects.toThrow('既有页面类型')
})
it('身份协议拒绝在合并组夹带冲突或把单例放进合并组',async()=>{
  await expect(synthesize(candidates,null,36000,async()=>JSON.stringify({groups:[{...group(['candidate-ref-1']),conflicts:[['claim-ref-1','claim-ref-2']]}],singletons:['candidate-ref-2','candidate-ref-3']}),[],async()=>{},signal(),'zh',3,prior)).rejects.toThrow()
})
it('小输入完整综合首次映射候选和主张，保存完整原文且不要求单例协议',async()=>{
  const checkpoints:SynthesisCheckpoint[]=[]
  const result=await synthesize(candidates,null,36000,async(system,input)=>{
    const data=JSON.parse(input);expect(system).not.toContain('"singletons"')
    expect(data.candidates[0].claims[0].id).toBe('claim-ref-1');expect(data.candidates[0].claims[0].evidence).toEqual(candidates[0]!.claims[0]!.evidence)
    return JSON.stringify({groups:[{...group(data.candidates.map((item:Candidate)=>item.id)),conflicts:[data.candidates.map((item:Candidate)=>item.claims[0]!.id)]}]})
  },checkpoints,async()=>{},signal())
  expect(result[0]!.members).toEqual(candidates.map(item=>item.id));expect(result[0]!.conflicts[0]).toEqual(candidates.map(item=>item.claims[0]!.id))
  expect(checkpoints[0]!.output).not.toContain('-ref-')
})
it('首次短编号校验失败仅纠正一次，不能把长ID当作有效编号',async()=>{
  const checkpoints:SynthesisCheckpoint[]=[];let calls=0
  await expect(synthesize(candidates,null,36000,async()=>{calls++;return JSON.stringify({groups:[{...group(candidates.map(item=>item.id)),conflicts:[]}]})},checkpoints,async()=>{},signal())).rejects.toThrow('未知候选或主张编号')
  expect(calls).toBe(2);expect(checkpoints).toEqual([])
})
it('旧分层身份成功检查点按完整输入复用，不写新协议键或重发请求',async()=>{
  const legacy=GROUP_PROMPT+'\n本次仅比对候选身份，claims 为空。成员只能使用输入候选的 id，每组保留 conflicts: []，冲突由后续主张比较处理。不因名称相同而忽略语境差异。'
  const checkpoints:SynthesisCheckpoint[]=[{key:signature(legacy+'\n'+JSON.stringify({language:'zh',schema:null,candidates:candidates.map(item=>({...item,claims:[]}))})),output:JSON.stringify({groups:candidates.map(item=>({type:item.type,title:item.title,identity:item.identity,aliases:item.aliases,tags:item.tags,members:[item.id],conflicts:[]}))})}]
  const saved=JSON.stringify(checkpoints)
  const result=await synthesize(candidates,null,36000,async()=>{throw new Error('不应调用模型')},checkpoints,async()=>{},signal(),'zh',3,prior)
  expect(result).toHaveLength(3);expect(JSON.stringify(checkpoints)).toBe(saved)
})
it('新协议成功检查点按原ID保存，接续不发请求且保留原字节',async()=>{
  const checkpoints:SynthesisCheckpoint[]=[]
  const first=await synthesize(candidates,null,36000,async()=>JSON.stringify({groups:[],singletons:['candidate-ref-1','candidate-ref-2','candidate-ref-3']}),checkpoints,async()=>{},signal(),'zh',3,prior)
  const saved=JSON.stringify(checkpoints)
  expect(await synthesize(candidates,null,36000,async()=>{throw new Error('不应调用模型')},checkpoints,async()=>{},signal(),'zh',3,prior)).toEqual(first)
  expect(JSON.stringify(checkpoints)).toBe(saved)
})
it('完整综合截断后分层协议仍遵守父级取消，不追加检查点',async()=>{
  const abort=new AbortController(),checkpoints:SynthesisCheckpoint[]=[];let calls=0
  await expect(synthesize(candidates,null,36000,async()=>{calls++;abort.abort(new Error('用户停止'));throw new ModelCallError('截断','max-tokens')},checkpoints,async()=>{},abort.signal)).rejects.toThrow()
  expect(calls).toBe(1);expect(checkpoints).toEqual([])
})
