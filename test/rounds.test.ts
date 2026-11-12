import { describe,expect,it } from 'vitest'
import { analyzeRounds } from '../src/ingest/rounds.js'
import type { AnalysisState } from '../src/ingest/rounds.js'
import type { Candidate,Extraction } from '../src/ingest/extraction.js'
import { defaultPolicy } from '../src/domain/policy.js'
const extracted=(identity:string,text:string):Extraction=>({candidates:[{type:'concept',identity,title:identity,aliases:[],tags:[],mentionOnly:false,claims:[{text,quote:text}]}],images:[]})
const validate=(data:Extraction,round:number):Candidate[]=>data.candidates.map((candidate,index)=>({...candidate,id:round+':'+index,claims:candidate.claims.map((claim,claimIndex)=>({id:round+':'+index+':'+claimIndex,text:claim.text,evidence:{sourceId:'source',hash:'hash',chunkId:'chunk',quote:claim.quote,originalStart:0,cleanStart:0,line:1}}))}))
describe('多轮补充提取与收敛',()=>{
  it('每轮只验证一次且验证失败的输出不进入检查点',async()=>{
    const state:AnalysisState={},policy=defaultPolicy();let checked=0
    await analyzeRounds(state,policy,5000,async(_known,_size,round)=>round===0?extracted('对象','事实'):{candidates:[],images:[]},(data,round)=>{checked++;return validate(data,round)},async()=>{})
    expect(checked).toBe(2);expect(state.rounds).toHaveLength(2)
    const bad:AnalysisState={}
    await expect(analyzeRounds(bad,policy,5000,async()=>extracted('对象','错误'),()=>{throw new Error('无效')},async()=>{})).rejects.toThrow('无效')
    expect(bad.rounds).toEqual([])
  })
  it.each([['balanced',25],['detailed',75]] as const)('%s分段提取遵守新增上限，复用轮次且不为短文凑数',async(granularity,limit)=>{
    const state:AnalysisState={},policy=defaultPolicy();policy.extractionGranularity=granularity
    const result=await analyzeRounds(state,policy,60000,async(_known,batchSize,round)=>({
      candidates:Array.from({length:batchSize},(_,n)=>extracted('主题'+round+':'+n,'原文'+n).candidates[0]!),images:[],
    }),validate,async()=>{})
    expect(result.candidates).toHaveLength(limit);expect(state.convergence).toBe('limit')
    expect(await analyzeRounds(state,policy,60000,async()=>{throw new Error('不应重复调用')},validate,async()=>{})).toEqual(result)
    const shortState:AnalysisState={}
    const short=await analyzeRounds(shortState,policy,1200,async(_known,_batchSize,round)=>({
      candidates:round===0?[extracted('主题甲','原文甲').candidates[0]!,extracted('主题乙','原文乙').candidates[0]!]:[],images:[],
    }),validate,async()=>{})
    expect(short.candidates).toHaveLength(2);expect(shortState.convergence).toBe('exhausted')
  })
  it('补充已有对象的新主张，重复轮终止，检查点可直接重现结果',async()=>{
    const state:AnalysisState={},policy=defaultPolicy();policy.extractionGranularity='coarse'
    const outputs=[extracted('流程','第一项'),extracted('流程','第二项'),extracted('流程','第二项')],known:number[]=[]
    const result=await analyzeRounds(state,policy,5000,async(items)=>{known.push(items.flatMap(item=>item.claims).length);return outputs.shift()!},validate,async()=>{})
    expect(result.candidates).toHaveLength(1);expect(result.candidates[0]!.claims.map(claim=>claim.text)).toEqual(['第一项','第二项'])
    expect(known).toEqual([0,1,2]);expect(state.convergence).toBe('exhausted')
    expect(await analyzeRounds(state,policy,5000,async()=>{throw new Error('不应重复调用')},validate,async()=>{})).toEqual(result)
  })
  it('后续轮失败保留前轮，恢复时继续；自定义限额有明确终止状态',async()=>{
    const state:AnalysisState={},policy=defaultPolicy();policy.extractionGranularity='custom';policy.customConceptLimit=1;policy.customEntityLimit=1
    let calls=0
    await expect(analyzeRounds(state,policy,5000,async()=>{if(calls++)throw new Error('中断');return extracted('流程','第一项')},validate,async()=>{})).rejects.toThrow('中断')
    expect(state.rounds).toHaveLength(1)
    const output=extracted('材料','材料信息');output.candidates[0]!.type='entity'
    const result=await analyzeRounds(state,policy,5000,async()=>output,validate,async()=>{})
    expect(result.candidates.map(item=>item.type)).toEqual(['concept','entity']);expect(state.convergence).toBe('limit')
  })
})
