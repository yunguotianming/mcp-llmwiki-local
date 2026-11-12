import { expect,it } from 'vitest'
import type { Candidate,Claim } from '../src/ingest/extraction.js'
import { ModelCallError } from '../src/llm/client.js'
import { synthesize } from '../src/wiki/synthesis.js'
import type { SynthesisIssueContext } from '../src/wiki/synthesis.js'
import { groupingResponse } from './synthesis-fixture.js'
const claim=(id:string):Claim=>({id,text:'有条件的事实'+id,evidence:{sourceId:'source-'+id,hash:'hash',chunkId:'chunk',quote:'对应原文'+id,cleanStart:0,originalStart:0,line:1}})
const candidate=(id:string,claims=[claim(id)]):Candidate=>({id,type:'concept',title:'流程',identity:'流程',aliases:[],tags:[],claims})

it('身份输出失败有界隔离，保留全部独立候选且不缓存无效输出',async()=>{
  const items=[candidate('a'),candidate('b'),candidate('c')],issues:SynthesisIssueContext[]=[],checkpoints:{key:string;output:string}[]=[]
  const groups=await synthesize(items,null,7000,async()=>'{bad',checkpoints,async()=>{},new AbortController().signal,'zh',3,[],(_error,context)=>issues.push(context))
  expect(groups.flatMap(g=>g.members).sort()).toEqual(['a','b','c']);expect(issues.length).toBeGreaterThan(0)
  expect(issues.every(issue=>issue.phase==='identity-comparison')).toBe(true);expect(checkpoints).toEqual([])
})
it('冲突比较超时不删主张或旧冲突，并留下未完成比较的原始主张编号',async()=>{
  const old=[claim('a'),claim('b')],items=[candidate('old',old),candidate('new',[claim('c')])],issues:SynthesisIssueContext[]=[]
  const groups=await synthesize(items,null,7000,async(system,input)=>{
    const data=JSON.parse(input);if(data.claims)throw new DOMException('比较超时','TimeoutError')
    return groupingResponse(system,[{type:'concept',title:'流程',identity:'流程',aliases:[],tags:[],members:data.candidates.map((c:{id:string})=>c.id),conflicts:[]}])
  },[],async()=>{},new AbortController().signal,'zh',2,[{identity:'流程',claims:old,conflicts:[['a','b']]}],(_error,context)=>issues.push(context))
  expect(groups[0]!.members).toHaveLength(2);expect(groups[0]!.conflicts).toContainEqual(['a','b'])
  expect(issues.some(issue=>issue.claimIds?.includes('c'))).toBe(true)
})
it('单条完整主张超预算时保留证据，不截引文，并标记未核对',async()=>{
  const c=claim('large');c.text='完整主张。'.repeat(500);c.evidence.quote='完整原文。'.repeat(500)
  const items=[candidate('a',[c])],before=JSON.stringify(items),issues:SynthesisIssueContext[]=[];let calls=0
  const groups=await synthesize(items,null,1500,async()=>{calls++;throw new Error('不应发送超大输入')},[],async()=>{},new AbortController().signal,'zh',2,[],(_error,context)=>issues.push(context))
  expect(groups[0]!.members).toEqual(['a']);expect(calls).toBe(0);expect(JSON.stringify(items)).toBe(before)
  expect(issues).toMatchObject([{phase:'conflict-comparison',claimIds:['large']}])
})
it('上游503仍明确停止，不能伪装成部分成功',async()=>{
  let issues=0
  await expect(synthesize([candidate('a'),candidate('b')],null,7000,async()=>{throw new ModelCallError('服务暂不可用','HTTP503',503)},[],async()=>{},new AbortController().signal,'zh',2,[],()=>{issues++})).rejects.toThrow('服务暂不可用')
  expect(issues).toBe(0)
})
it('用户取消后不降级恢复、不发送纠正请求',async()=>{
  const abort=new AbortController();let calls=0,issues=0
  await expect(synthesize([candidate('a'),candidate('b')],null,7000,async()=>{calls++;abort.abort(new Error('用户取消'));return '{bad'},[],async()=>{},abort.signal,'zh',2,[],()=>{issues++})).rejects.toThrow('用户取消')
  expect(calls).toBe(1);expect(issues).toBe(0)
})
