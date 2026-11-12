import { mapConcurrent } from '../src/llm/scheduler.js'
import { afterEach,beforeEach,describe,expect,it,vi } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { ModelCallError,ModelClient,ModelTransportError,validatedModelOutput } from '../src/llm/client.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { newLibrary } from '../src/domain/config.js'
import { defaultPolicy } from '../src/domain/policy.js'
function fixture(events: StreamChunk[][]) {
  const routes: string[] = [], library = newLibrary('model'), policy = defaultPolicy()
  library.models.unified = {provider:'host',model:'primary'}; library.models.fallbacks = [{provider:'host',model:'backup'}]
  const runtime: ModelRuntime = {async resolveModelInfo(provider,id) { return {provider,id,name:id} },
    async *stream(options) { routes.push(options.model); for (const event of events.shift() ?? []) yield event } }
  return {client:new ModelClient(runtime,library,policy),routes,runtime,library,policy}
}
const success: StreamChunk[] = [{type:'text-delta',index:0,text:'答案'},{type:'finish',reason:{kind:'stop'}}]
describe('宿主模型调用', () => {
  it('忽略思考正文，记录 usage，只接受完整结束',async () => {
    const f = fixture([[{type:'reasoning-delta',index:0,text:'内部思考'},...success]])
    expect(await f.client.call('ingest','规则','资料')).toBe('答案')
    expect(f.client.attempts[0]?.finish).toBe('stop')
    const missing = fixture([[{type:'text-delta',index:0,text:'不完整'}]])
    await expect(missing.client.call('ingest','','')).rejects.toThrow('终止状态')
    expect(missing.routes).toEqual(['primary'])
  })
  it('供应商瞬时故障按顺序备用，截断与无效参数不切换',async () => {
    const f = fixture([[{type:'finish',reason:{kind:'error',failure:{code:'overload',message:'繁忙',status:503}}}],success])
    expect(await f.client.call('ingest','','')).toBe('答案'); expect(f.routes).toEqual(['primary','backup'])
    const truncated = fixture([[{type:'finish',reason:{kind:'max-tokens'}}],success])
    await expect(truncated.client.call('ingest','','')).rejects.toThrow('max-tokens')
    expect(truncated.routes).toEqual(['primary'])
    f.policy.advancedSettingsMode = 'custom'; f.policy.reasoningEffort = 'unknown'
    await expect(f.client.call('ingest','','')).rejects.toThrow('未声明')
  })
  it('取消挂起的流并停止备用切换',async () => {
    const f = fixture([]), abort = new AbortController()
    let start!:()=>void;const started=new Promise<void>(resolve=>{start=resolve})
    let release!:()=>void,settled=false,closed=false
    f.runtime.stream = async function* (options) {
      try{start();await new Promise<void>(resolve=>options.signal!.addEventListener('abort',()=>{release=resolve},{once:true}));yield {type:'finish',reason:{kind:'stop'}}}
      finally{closed=true}
    }
    const pending = f.client.call('ingest','','',abort.signal)
    void pending.catch(()=>{settled=true})
    await started
    abort.abort(new Error('用户取消'))
    await Promise.resolve();expect(settled).toBe(false);expect(closed).toBe(false);release()
    await expect(pending).rejects.toThrow('用户取消')
    expect(f.client.attempts).toHaveLength(1);expect(closed).toBe(true)
  })
  it('主路由请求超时尝试备用，外部取消不作为超时切换',async()=>{
    const f=fixture([]);f.policy.ingestRequestTimeoutSeconds=0.01
    f.runtime.stream=async function* (options) {
      f.routes.push(options.model)
      if(options.model==='primary')await new Promise<void>(resolve=>options.signal!.addEventListener('abort',()=>resolve(),{once:true}))
      for(const event of success)yield event
    }
    expect(await f.client.call('ingest','','')).toBe('答案')
    expect(f.routes).toEqual(['primary','backup'])
    expect(f.client.attempts[0]?.finish).toBe('aborted')
  })
  it('无效结构只纠正一次，反馈原输出和校验错误，纠正结果仍须验证',async()=>{
    const feedbacks:unknown[]=[]
    const result=await validatedModelOutput(async feedback=>{feedbacks.push(feedback);return feedback?'[1]':'错误JSON'},text=>JSON.parse(text) as number[])
    expect(result).toEqual({output:'[1]',value:[1]});expect(feedbacks).toHaveLength(2)
    expect(feedbacks[1]).toMatchObject({output:'错误JSON',error:expect.any(String)})
    let calls=0
    await expect(validatedModelOutput(async()=>{calls++;return '错误JSON'},JSON.parse)).rejects.toThrow()
    expect(calls).toBe(2)
  })
  it('关闭思考映射到模型声明的 none 推理强度',async()=>{
    const f=fixture([[...success]]);f.policy.advancedSettingsMode='custom';f.policy.disableThinking=true
    let effort:string|undefined
    f.runtime.resolveModelInfo=async(provider,id)=>({provider,id,name:id,reasoning:{efforts:[{id:'none',name:'关闭'}]}})
    f.runtime.stream=async function* (options) { effort=options.reasoningEffort;for(const event of success)yield event }
    expect(await f.client.call('ingest','','')).toBe('答案');expect(effort).toBe('none')
    const unsupported=fixture([[...success]]);unsupported.policy.advancedSettingsMode='custom';unsupported.policy.disableThinking=true
    await expect(unsupported.client.call('ingest','','')).rejects.toThrow('未声明 none 推理强度')
  })
  it('请求异常不进入输出纠正',async()=>{
    let calls=0
    await expect(validatedModelOutput(async()=>{calls++;throw new Error('用户取消')},JSON.parse)).rejects.toThrow('用户取消')
    expect(calls).toBe(1)
  })
})

describe('传输错误重试', () => {
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
function transportFixture(work: (input: string, signal: AbortSignal) => Promise<string>) {
  const library = newLibrary('transport'), policy = defaultPolicy()
  library.models.unified = { provider: 'codex-cli', model: 'mock' }; library.models.fallbacks = []
  policy.pageGenerationConcurrency = 2; policy.batchDelayMs = 0
  const runtime: ModelRuntime = {
    async resolveModelInfo(provider, id) { return { provider, id, name: id } },
    async *stream(options) {
      const message = options.messages[0]!.content[0]!
      const text = await work(message.type === 'text' ? message.text : '', options.signal!)
      yield { type: 'text-delta', index: 0, text }; yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  return new ModelClient(runtime, library, policy)
}
const failure = () => new ModelTransportError('error decoding response body', 'codex-transport', undefined, { rawOutput: '未完成输出' })

it('首次传输失败两秒后成功，调度器保留其他在途任务且记录失败用量', async () => {
  let attempts = 0, otherSignal: AbortSignal | undefined
  const release = Promise.withResolvers<string>()
  const client = transportFixture(async (input, signal) => {
    if (input === '甲') { if (++attempts === 1) throw failure(); return '甲完成' }
    otherSignal = signal; return release.promise
  })
  const pending = mapConcurrent(['甲', '乙'], 2, new AbortController().signal, (input, signal) => client.call('ingest', '', input, signal))
  await vi.advanceTimersByTimeAsync(1999)
  expect(attempts).toBe(1); expect(otherSignal?.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect(attempts).toBe(2); expect(otherSignal?.aborted).toBe(false)
  release.resolve('乙完成'); expect(await pending).toEqual(['甲完成', '乙完成'])
  expect(client.attempts).toHaveLength(3)
  expect(client.attempts.filter(attempt => attempt.error)[0]?.failure?.rawOutput).toBe('未完成输出')
})

it('两次指数退避用尽才失败并按原调度语义取消其他任务', async () => {
  let attempts = 0, otherSignal: AbortSignal | undefined
  const client = transportFixture(async (input, signal) => {
    if (input === '甲') { attempts++; throw failure() }
    otherSignal = signal
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    signal.throwIfAborted(); return '乙完成'
  })
  const pending = mapConcurrent(['甲', '乙'], 2, new AbortController().signal, (input, signal) => client.call('ingest', '', input, signal)).catch(error => error)
  await vi.advanceTimersByTimeAsync(2000)
  expect(attempts).toBe(2); expect(otherSignal?.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(3999); expect(attempts).toBe(2); expect(otherSignal?.aborted).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  expect((await pending).message).toContain('error decoding response body')
  expect(attempts).toBe(3); expect(otherSignal?.aborted).toBe(true)
})

it('退避期间用户取消立即退出且不重试', async () => {
  const work = vi.fn(async () => { throw failure() }), client = transportFixture(work), abort = new AbortController()
  const pending = client.call('ingest', '', '甲', abort.signal).catch(error => error)
  await vi.advanceTimersByTimeAsync(0); abort.abort(new Error('用户取消'))
  expect((await pending).message).toBe('用户取消')
  await vi.advanceTimersByTimeAsync(10000); expect(work).toHaveBeenCalledTimes(1)
})

it('在途取消不重试，业务错误也不进入传输退避', async () => {
  const abort = new AbortController(), work = vi.fn(async (_input, signal: AbortSignal) => {
    await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
    signal.throwIfAborted(); return ''
  })
  const pending = transportFixture(work).call('ingest', '', '甲', abort.signal).catch(error => error)
  await vi.advanceTimersByTimeAsync(0); abort.abort(new Error('取消'))
  expect((await pending).message).toBe('取消'); expect(work).toHaveBeenCalledTimes(1)
  const business = vi.fn(async () => { throw new ModelCallError('无效模型输出', 'empty-output') })
  await expect(transportFixture(business).call('ingest', '', '甲')).rejects.toThrow('无效模型输出')
  expect(business).toHaveBeenCalledTimes(1)
})

})
