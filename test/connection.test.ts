import { describe,expect,it } from 'vitest'
import { testConnection } from '../src/llm/connection.js'
import { newLibrary } from '../src/domain/config.js'
import { defaultPolicy } from '../src/domain/policy.js'
import type { ModelRuntime } from '../src/llm/client.js'
describe('草稿连接测试',()=>{
  it('沿用草稿任务路由和自定义参数，不保存配置',async()=>{
    const models=newLibrary('test').models,policy=defaultPolicy()
    models.unified={provider:'host',model:'base'};models.perTask=true;models.query={provider:'host',model:'query'}
    policy.advancedSettingsMode='custom';policy.chatTemperature=0.3
    const before=JSON.stringify([models,policy])
    const runtime:ModelRuntime={async resolveModelInfo(provider,id){return{provider,id,name:id}},async*stream(options){
      expect(options.model).toBe('query');expect(options.temperature).toBe(0.3)
      yield {type:'text-delta',index:0,text:'连接成功'};yield {type:'finish',reason:{kind:'stop'}}
    }}
    expect((await testConnection(runtime,models,policy,'query',new AbortController().signal)).status).toBe('connected')
    expect(JSON.stringify([models,policy])).toBe(before)
  })
  it('图片能力探测不发文本请求，不把声明检查称为已识图',async()=>{
    const models=newLibrary('test').models;models.unified={provider:'host',model:'image'}
    const runtime:ModelRuntime={async resolveModelInfo(provider,id){return{provider,id,name:id,inputModalities:['text','image']}},async*stream(){throw new Error('不应发送图片或文本请求')}}
    const result=await testConnection(runtime,models,defaultPolicy(),'vision',new AbortController().signal)
    expect(result.status).toBe('capability-confirmed');expect(result.message).toContain('实际识图在导入图片时验证')
  })
})
