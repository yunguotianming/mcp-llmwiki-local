import { expect,it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { defaultPolicy,processingPolicy,validatePolicy } from '../src/domain/policy.js'
import { policySchema } from '../src/domain/policy-schema.js'
import { newLibrary } from '../src/domain/config.js'
import { ModelClient } from '../src/llm/client.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { contextWindowLimit } from '../src/llm/context.js'

const success:StreamChunk[]=[{type:'text-delta',index:0,text:'完成'},{type:'finish',reason:{kind:'stop'}}]
function fixture(){
  const policy=defaultPolicy(),library=newLibrary('context'),sent:unknown[]=[]
  library.models.unified={provider:'fake',model:'primary'}
  const runtime:ModelRuntime={async resolveModelInfo(provider,id){return {provider,id,name:id}},async *stream(options){sent.push(options);yield* success}}
  return {policy,library,sent,runtime,client:new ModelClient(runtime,library,policy)}
}
it('旧策略缺少上下文字段时仍保留处理签名，五档可保存且任意数值被拒绝',()=>{
  const {contextWindowTokens:_,...legacy}=defaultPolicy(),parsed=policySchema.parse(legacy)
  expect(parsed.contextWindowTokens).toBe(0);expect(JSON.stringify(processingPolicy(parsed))).toBe(JSON.stringify(processingPolicy(legacy as typeof parsed)))
  expect([64000,128000,256000,512000,1000000].map(contextWindowTokens=>policySchema.parse({...legacy,contextWindowTokens}).contextWindowTokens)).toEqual([64000,128000,256000,512000,1000000])
  expect(policySchema.safeParse({...legacy,contextWindowTokens:96000}).success).toBe(false)
  expect(validatePolicy({...parsed,contextWindowTokens:96000})).toContain('上下文上限请选择自动、64K、128K、256K、512K 或 1M。')
  expect(processingPolicy({...parsed,contextWindowTokens:128000})).not.toEqual(processingPolicy(parsed))
})
it('未知模型容量使用手动档位并预留输出，不把上下文档位当作输出参数',async()=>{
  const f=fixture();f.policy.contextWindowTokens=64000
  await expect(f.client.call('ingest','规则','a'.repeat(60000))).rejects.toMatchObject({code:'context-limit'})
  expect(f.sent).toEqual([])
  f.policy.contextWindowTokens=128000
  expect(await f.client.call('ingest','规则','a'.repeat(60000))).toBe('完成')
  expect(f.sent[0]).not.toHaveProperty('maxTokens')
})
it('模型已声明容量是手动档位的硬上限，系统提示也占用上下文',async()=>{
  const f=fixture();f.policy.contextWindowTokens=1000000;f.policy.maxTokensPerCall=1000
  f.runtime.resolveModelInfo=async(provider,id)=>({provider,id,name:id,context:{contextWindow:64000}})
  expect(contextWindowLimit(f.policy,{context:{contextWindow:64000}})).toBe(64000)
  await expect(f.client.call('query','s'.repeat(2000),'a'.repeat(62000))).rejects.toMatchObject({code:'context-limit'})
  expect(f.sent).toEqual([])
  expect(await f.client.call('query','s','a'.repeat(62000))).toBe('完成')
  expect(f.sent[0]).toHaveProperty('maxTokens',1000)
})
it('备用路由单独核对容量，不把主模型的大窗口套给较小备用模型',async()=>{
  const f=fixture();f.policy.contextWindowTokens=128000;f.library.models.fallbacks=[{provider:'fake',model:'backup'}]
  f.runtime.resolveModelInfo=async(provider,id)=>({provider,id,name:id,context:{contextWindow:id==='primary'?128000:32000}})
  f.runtime.stream=async function* (options){f.sent.push(options.model);yield {type:'finish',reason:{kind:'error',failure:{code:'busy',message:'繁忙',status:503}}}}
  await expect(f.client.call('lint','','a'.repeat(40000))).rejects.toMatchObject({code:'context-limit'})
  expect(f.sent).toEqual(['primary']);expect(f.client.attempts).toHaveLength(2)
})
it('自动模式沿用已知模型容量，未知容量保持旧行为',async()=>{
  const f=fixture();expect(contextWindowLimit(f.policy,{})).toBeUndefined()
  expect(contextWindowLimit(f.policy,{context:{contextWindow:32000}})).toBe(32000)
  expect(await f.client.call('ingest','','a'.repeat(130000))).toBe('完成')
})
