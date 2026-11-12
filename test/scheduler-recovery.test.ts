import { expect,it } from 'vitest'
import { mapConcurrent,walkConcurrent } from '../src/llm/scheduler.js'

it('显式恢复失败项后继续补槽，结果仍按输入顺序归并',async()=>{
  let active=0,peak=0;const visited:number[]=[]
  const result=await mapConcurrent([0,1,2,3,4],2,new AbortController().signal,async item=>{
    visited.push(item);peak=Math.max(peak,++active);await Promise.resolve();active--;if(item===1)throw new Error('单项失败');return item*2
  },(error,item)=>{expect((error as Error).message).toBe('单项失败');return -item})
  expect(result).toEqual([0,-1,4,6,8]);expect(visited).toHaveLength(5);expect(peak).toBeLessThanOrEqual(2)
})
it('动态队列恢复一个叶项时其他父子分支仍完整执行',async()=>{
  const visited:number[]=[],failed:number[]=[]
  await walkConcurrent([1],2,new AbortController().signal,async item=>{visited.push(item);if(item===4)throw new Error('坏叶段');return item<3?[item*2,item*2+1]:[]},(_error,item)=>{failed.push(item);return []})
  expect(visited.sort()).toEqual([1,2,3,4,5]);expect(failed).toEqual([4])
})
it('恢复回调拒绝IO错误时保持全局停止行为',async()=>{
  const visited:number[]=[]
  await expect(mapConcurrent([0,1,2],1,new AbortController().signal,async item=>{visited.push(item);throw new Error('IO故障')},error=>{throw error})).rejects.toThrow('IO故障')
  expect(visited).toEqual([0])
})
it('用户取消不调用恢复回调且不继续派发',async()=>{
  const abort=new AbortController(),visited:number[]=[];let recovered=0
  await expect(mapConcurrent([0,1],1,abort.signal,async item=>{visited.push(item);abort.abort(new Error('用户取消'));throw new Error('退出')},()=>{recovered++;return 0})).rejects.toThrow('用户取消')
  expect(recovered).toBe(0);expect(visited).toEqual([0])
})
