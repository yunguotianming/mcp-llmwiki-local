import { newLibrary } from '../domain/config.js'
import type { ModelRoutes,Task } from '../domain/config.js'
import type { LibraryPolicy } from '../domain/policy.js'
import { ModelClient } from './client.js'
import type { ModelRuntime } from './client.js'
export { routesSchema } from '../domain/route-schema.js'
export async function testConnection(runtime:ModelRuntime,models:ModelRoutes,policy:LibraryPolicy,task:Task,signal:AbortSignal){
  const library=newLibrary('connection-test');library.models=structuredClone(models)
  const client=new ModelClient(runtime,library,policy),started=Date.now()
  if(task==='vision'){
    const info=await client.info(task,signal,'image')
    return {task,status:'capability-confirmed',model:{provider:info.provider,id:info.id},durationMs:Date.now()-started,message:'路由已声明图片输入能力；实际识图在导入图片时验证。',attempts:client.attempts}
  }
  const response=await client.call(task,'这是连接测试。请仅回复“连接成功”，不输出其他内容。','请确认本次连接。',signal)
  return {task,status:'connected',durationMs:Date.now()-started,message:response,attempts:client.attempts}
}
