import { it, expect } from 'vitest'
import { defaultPolicy } from '../src/domain/policy.js'
import { policySchema } from '../src/domain/policy-schema.js'
import type { Candidate } from '../src/ingest/extraction.js'
import { selectSourceCandidates } from '../src/wiki/source-selection.js'
import type { SynthesisCheckpoint } from '../src/wiki/synthesis.js'
const candidate = (n: number, type: Candidate['type'] = 'concept'): Candidate => ({ id: 'c' + n, type, title: '主题' + n, identity: '主题' + n, aliases: [], tags: [],
  claims: [{ id: 'claim' + n, text: '完整主张' + n, evidence: { sourceId: 'source', hash: 'hash', chunkId: 'chunk' + n, quote: '原文' + n, cleanStart: n, originalStart: n, line: n + 1 } }] })

it.each([['balanced',25],['detailed',75]] as const)('%s整篇合计上限生效，超额须纠正并保留选中主题证据',async(granularity,limit)=>{
  const policy=policySchema.parse({...defaultPolicy(),extractionGranularity:granularity})
  expect(policySchema.parse(defaultPolicy()).extractionGranularity).toBe('standard')
  const items=Array.from({length:limit+2},(_,n)=>candidate(n,n%2?'concept':'entity'))
  const extra=candidate(limit+1,items.at(-1)!.type);extra.id='extra';extra.claims=candidate(999).claims
  const checkpoints:SynthesisCheckpoint[]=[];let calls=0
  const call=async(_system:string,input:string)=>{
    calls++;const data=JSON.parse(input);expect(data.limits.total).toBe(limit)
    return JSON.stringify({ids:data.candidates.slice(-(data.validationFeedback?limit:limit+1)).map((item:Candidate)=>item.id)})
  }
  const run=()=>selectSourceCandidates([...items,extra],'整篇.md',policy,200000,call,checkpoints,async()=>{},new AbortController().signal)
  const result=await run();expect(calls).toBe(2);expect(result).toHaveLength(limit)
  expect(result.filter(item=>item.type==='entity').length).toBeGreaterThan(0)
  expect(result.filter(item=>item.type==='concept').length).toBeGreaterThan(0)
  expect(result.at(-1)!.claims).toEqual([...items.at(-1)!.claims,...extra.claims])
  expect(await run()).toEqual(result);expect(calls).toBe(2)
  expect(JSON.parse(checkpoints[0]!.output).ids).toEqual(result.map(item=>item.id))
  expect(await selectSourceCandidates(items.slice(0,2),'短文.md',policy,200000,async()=>{throw new Error('不应为未达上限的内容调用筛选')},[],async()=>{},new AbortController().signal)).toEqual(items.slice(0,2))
})

it('标准按整篇最多50个，筛选能选择后段主题并复用检查点', async () => {
  const policy = defaultPolicy(); policy.extractionGranularity = 'standard'
  const candidates = Array.from({ length: 60 }, (_, n) => candidate(n)), checkpoints: SynthesisCheckpoint[] = []
  let calls = 0
  const call = async (_system: string, input: string) => { calls++; const data = JSON.parse(input); expect(data.candidates).toHaveLength(60); expect(data.limits.total).toBe(50); return JSON.stringify({ ids: data.candidates.slice(-50).map((item: Candidate) => item.id) }) }
  const run = () => selectSourceCandidates(candidates, '整篇.md', policy, 40000, call, checkpoints, async () => {}, new AbortController().signal)
  const result = await run(); expect(result).toHaveLength(50); expect(result.at(-1)).toEqual(candidates.at(-1)); expect(result[0]?.id).toBe('c10')
  expect(await run()).toEqual(result); expect(calls).toBe(1)
})

it('粗放跨片段合并同主题证据，整篇合计不超过10个', async () => {
  const policy = defaultPolicy(); policy.extractionGranularity = 'coarse'
  const items = Array.from({ length: 12 }, (_, n) => candidate(n)), extra = candidate(0); extra.id = 'extra'; extra.claims = candidate(99).claims
  const result = await selectSourceCandidates([...items, extra], '整篇.md', policy, 40000, async (_system, input) => JSON.stringify({ ids: JSON.parse(input).candidates.slice(0, 10).map((item: Candidate) => item.id) }), [], async () => {}, new AbortController().signal)
  expect(result).toHaveLength(10); expect(result[0]?.claims).toHaveLength(2); expect(result[0]?.claims.at(-1)).toEqual(extra.claims[0])
})

it('自定义按篇分别限制实体和概念，不丢失选中候选的证据', async () => {
  const policy = defaultPolicy(); policy.extractionGranularity = 'custom'; policy.customEntityLimit = 2; policy.customConceptLimit = 1
  const items = [candidate(0, 'entity'), candidate(1, 'entity'), candidate(2, 'entity'), candidate(3), candidate(4)]
  const result = await selectSourceCandidates(items, '来源.md', policy, 40000, async () => JSON.stringify({ ids: ['c1', 'c2', 'c4'] }), [], async () => {}, new AbortController().signal)
  expect(result).toEqual([items[1], items[2], items[4]])
})

it('无效ID和超额筛选纠正后仍失败则停止，不生成错误结果', async () => {
  const policy = defaultPolicy(); policy.extractionGranularity = 'minimal'; let calls = 0
  await expect(selectSourceCandidates(Array.from({ length: 6 }, (_, n) => candidate(n)), '来源.md', policy, 40000, async () => { calls++; return JSON.stringify({ ids: ['unknown'] }) }, [], async () => {}, new AbortController().signal)).rejects.toThrow('未知')
  expect(calls).toBe(2)
})

it('长文分组小于整篇上限时仍主动缩减，保留后段主题和完整证据', async () => {
  const policy = defaultPolicy(); policy.extractionGranularity = 'standard'
  const items = Array.from({ length: 51 }, (_, n) => { const item = candidate(n); item.claims[0]!.text = '文'.repeat(800); return item })
  const checkpoints: SynthesisCheckpoint[] = []; let calls = 0
  const run = () => selectSourceCandidates(items, '长文.md', policy, 36000, async (system, input) => {
    calls++; expect(Buffer.byteLength(system + input)).toBeLessThanOrEqual(36000)
    const data = JSON.parse(input); expect(data.limits.total).toBeLessThan(data.candidates.length)
    return JSON.stringify({ ids: data.candidates.slice(-data.limits.total).map((item: Candidate) => item.id) })
  }, checkpoints, async () => {}, new AbortController().signal)
  const result = await run()
  expect(calls).toBeGreaterThan(0); expect(result.length).toBeLessThanOrEqual(50)
  expect(result.at(-1)).toEqual(items.at(-1)); expect(result.every(item => item.claims[0]!.text.length === 800)).toBe(true)
  const before = calls; expect(await run()).toEqual(result); expect(calls).toBe(before)
})

it('自定义长文分组缩减同时保留实体和概念各自上限', async () => {
  const policy = defaultPolicy(); policy.extractionGranularity = 'custom'; policy.customEntityLimit = 2; policy.customConceptLimit = 1
  const items = Array.from({ length: 32 }, (_, n) => { const item = candidate(n, n % 2 ? 'concept' : 'entity'); item.claims[0]!.text = '文'.repeat(800); return item })
  let calls = 0
  const result = await selectSourceCandidates(items, '自定义长文.md', policy, 36000, async (system, input) => {
    calls++; expect(Buffer.byteLength(system + input)).toBeLessThanOrEqual(36000)
    const data = JSON.parse(input), selected: Candidate[] = []
    for (const item of data.candidates as Candidate[]) {
      if (selected.length >= (data.limits.total ?? Infinity)) break
      const cap = item.type === 'entity' ? data.limits.entities : data.limits.concepts
      if (selected.filter(known => known.type === item.type).length < cap) selected.push(item)
    }
    return JSON.stringify({ ids: selected.map(item => item.id) })
  }, [], async () => {}, new AbortController().signal)
  expect(calls).toBeGreaterThan(1); expect(result.filter(item => item.type === 'entity').length).toBeLessThanOrEqual(2)
  expect(result.filter(item => item.type === 'concept').length).toBeLessThanOrEqual(1)
  expect(result.every(item => item.claims[0]!.text.length === 800)).toBe(true)
})

it('纠正反馈超预算后缩小分组，严格筛选并保留全部原候选证据',async()=>{
  const policy=defaultPolicy();policy.extractionGranularity='minimal'
  const items=Array.from({length:12},(_,n)=>{const item=candidate(n);item.claims[0]!.text='文'.repeat(100);return item})
  const checkpoints:SynthesisCheckpoint[]=[],sizes:number[]=[];let first=true
  const call=async(system:string,input:string)=>{
    sizes.push(Buffer.byteLength(system+input));const data=JSON.parse(input)
    if(first){first=false;return JSON.stringify({ids:['unknown'.repeat(1500)]})}
    return JSON.stringify({ids:data.candidates.slice(-data.limits.total).map((item:Candidate)=>item.id)})
  }
  const result=await selectSourceCandidates(items,'资料.md',policy,7000,call,checkpoints,async()=>{},new AbortController().signal)
  expect(sizes.every(size=>size<=7000)).toBe(true);expect(sizes.length).toBeGreaterThan(1)
  expect(result.length).toBeLessThanOrEqual(5);expect(result.at(-1)).toEqual(items.at(-1))
  expect(result.every(item=>items.some(original=>JSON.stringify(original)===JSON.stringify(item)))).toBe(true)
  expect(checkpoints.every(item=>!item.output.includes('unknown'))).toBe(true)
})

it('按篇筛选请求超时后减半候选分组，证据和检查点继续复用',async()=>{
  const policy=defaultPolicy();policy.extractionGranularity='minimal'
  const items=Array.from({length:12},(_,n)=>candidate(n)),checkpoints:SynthesisCheckpoint[]=[],sizes:number[]=[]
  let timeout=true
  const call=async(_system:string,input:string)=>{
    const data=JSON.parse(input);sizes.push(data.candidates.length)
    if(timeout){timeout=false;throw new DOMException('模拟请求超时','TimeoutError')}
    return JSON.stringify({ids:data.candidates.slice(-data.limits.total).map((item:Candidate)=>item.id)})
  }
  const run=()=>selectSourceCandidates(items,'来源.md',policy,40000,call,checkpoints,async()=>{},new AbortController().signal)
  const result=await run();expect(sizes[0]).toBe(12);expect(sizes.slice(1).every(size=>size<=6)).toBe(true)
  expect(result.length).toBeLessThanOrEqual(5);expect(result.at(-1)).toEqual(items.at(-1))
  expect(result.every(item=>items.some(original=>JSON.stringify(original)===JSON.stringify(item)))).toBe(true)
  const before=sizes.length;timeout=true;expect(await run()).toEqual(result);expect(sizes.length).toBe(before+1)
})

it('按篇筛选持续超时时有界停止，不将未筛选候选保存为成功',async()=>{
  const policy=defaultPolicy();policy.extractionGranularity='minimal'
  const checkpoints:SynthesisCheckpoint[]=[],sizes:number[]=[]
  await expect(selectSourceCandidates(Array.from({length:12},(_,n)=>candidate(n)),'来源.md',policy,40000,async(_system,input)=>{
    sizes.push(JSON.parse(input).candidates.length);throw new DOMException('持续超时','TimeoutError')
  },checkpoints,async()=>{},new AbortController().signal)).rejects.toThrow('检查点已保留')
  // 独立分组可同时超时，核对缩组层级及有界请求数，不固定并行请求的先后。
  expect([...new Set(sizes)]).toEqual([12,6,3]);expect(sizes.length).toBeLessThanOrEqual(7);expect(checkpoints).toEqual([])
})

it('用户取消按篇筛选时立即停止，不因超时原因继续缩组',async()=>{
  const policy=defaultPolicy();policy.extractionGranularity='minimal'
  const abort=new AbortController();let calls=0
  await expect(selectSourceCandidates(Array.from({length:12},(_,n)=>candidate(n)),'来源.md',policy,40000,async()=>{
    calls++;const error=new DOMException('父级已取消','TimeoutError');abort.abort(error);throw error
  },[],async()=>{},abort.signal)).rejects.toThrow('父级已取消')
  expect(calls).toBe(1)
})

it.each(['unknown','duplicate'])('长编号%s经短编号纠正后严格回填原身份，旧缓存可直接复用',async(kind)=>{
  const policy=defaultPolicy();policy.extractionGranularity='minimal'
  const items=Array.from({length:6},(_,n)=>({...candidate(n),id:n.toString(16).padStart(64,'0')})),checkpoints:SynthesisCheckpoint[]=[]
  let calls=0
  const run=()=>selectSourceCandidates(items,'来源.md',policy,40000,async(_system,input)=>{
    calls++;const data=JSON.parse(input)
    if(!data.validationFeedback){
      expect(data.candidates.map((item:Candidate)=>item.id)).toEqual(items.map(item=>item.id))
      return JSON.stringify({ids:kind==='unknown'?['c5c261c?']:[items[0]!.id,items[0]!.id]})
    }
    expect(data.candidates.every((item:Candidate)=>/^ref-\d+$/.test(item.id))).toBe(true)
    expect(data.validationFeedback.error).toContain('短编号')
    return JSON.stringify({ids:data.candidates.slice(-5).map((item:Candidate)=>item.id)})
  },checkpoints,async()=>{},new AbortController().signal)
  const result=await run();expect(result).toEqual(items.slice(-5));expect(calls).toBe(2)
  expect(JSON.parse(checkpoints[0]!.output).ids).toEqual(result.map(item=>item.id))
  expect(await run()).toEqual(result);expect(calls).toBe(2)
})

it.each(['unknown','duplicate'])('短编号仍%s时拒绝结果，不猜测或去重后保存',async(kind)=>{
  const policy=defaultPolicy();policy.extractionGranularity='minimal'
  const checkpoints:SynthesisCheckpoint[]=[];let calls=0
  await expect(selectSourceCandidates(Array.from({length:6},(_,n)=>candidate(n)),'来源.md',policy,40000,async(_system,input)=>{
    calls++;const data=JSON.parse(input)
    return JSON.stringify({ids:data.validationFeedback?(kind==='unknown'?['ref-999']:['ref-1','ref-1']):['unknown']})
  },checkpoints,async()=>{},new AbortController().signal)).rejects.toThrow('重复或未知')
  expect(calls).toBe(2);expect(checkpoints).toEqual([])
})

it('旧版长编号缓存保持原字节，直接验证原身份且不请求模型',async()=>{
  const policy=defaultPolicy();policy.extractionGranularity='minimal'
  const items=Array.from({length:6},(_,n)=>({...candidate(n),id:n.toString(16).padStart(64,'0')})),checkpoints:SynthesisCheckpoint[]=[]
  await selectSourceCandidates(items,'来源.md',policy,40000,async()=>JSON.stringify({ids:items.slice(-5).map(item=>item.id)}),checkpoints,async()=>{},new AbortController().signal)
  const before=JSON.stringify(checkpoints)
  const result=await selectSourceCandidates(items,'来源.md',policy,40000,async()=>{throw new Error('不应重新筛选')},checkpoints,async()=>{},new AbortController().signal)
  expect(result).toEqual(items.slice(-5));expect(JSON.stringify(checkpoints)).toBe(before)
})
