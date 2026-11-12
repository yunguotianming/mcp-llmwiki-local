import { describe,expect,it,vi } from 'vitest'
import { CallGate,mapConcurrent,walkConcurrent } from '../src/llm/scheduler.js'
describe('作业并发与请求批次',()=>{
  it('50路设置限制峰值，完成一个槽位后立即补发一个请求',async()=>{
    const gate=new CallGate(50,0),finish:(()=>void)[]=[],started:number[]=[]
    let active=0,peak=0
    const pending=Array.from({length:100},(_,index)=>gate.run(async()=>{
      started.push(index);peak=Math.max(peak,++active)
      await new Promise<void>(resolve=>{finish[index]=resolve});active--
    }))
    await vi.waitFor(()=>expect(started).toHaveLength(50))
    finish[0]!();await pending[0]
    await vi.waitFor(()=>expect(started).toHaveLength(51))
    expect(active).toBe(50);expect(peak).toBe(50)
    for(let index=1;index<100;index++){
      await vi.waitFor(()=>expect(finish[index]).toBeTypeOf('function'));finish[index]!()
    }
    await Promise.all(pending);expect(active).toBe(0);expect(peak).toBe(50)
  })
  it('限制并发和槽位冷却间隔，排队取消不执行',async()=>{
    vi.useFakeTimers()
    try{
      const gate=new CallGate(2,20),started:number[]=[],abort=new AbortController()
      const work=async()=>{started.push(Date.now());await new Promise(resolve=>setTimeout(resolve,10));return '完成'}
      const first=gate.run(work),second=gate.run(work),cancelled=gate.run(work,abort.signal),last=gate.run(work)
      const rejected=cancelled.catch(error=>error.message);abort.abort(new Error('用户取消'))
      await vi.advanceTimersByTimeAsync(0);expect(started).toHaveLength(2)
      // 精确推进任务耗时与冷却边界，避免真实计时器的毫秒取整影响断言。
      await vi.advanceTimersByTimeAsync(10);await Promise.all([first,second])
      await vi.advanceTimersByTimeAsync(19);expect(started).toHaveLength(2)
      await vi.advanceTimersByTimeAsync(1);expect(started).toHaveLength(3)
      expect(started[2]!-started[0]!).toBe(30)
      await vi.advanceTimersByTimeAsync(10)
      expect(await Promise.all([first,second,last])).toEqual(['完成','完成','完成']);expect(await rejected).toBe('用户取消')
    }finally{vi.useRealTimers()}
  })
  it('快请求完成立即补发，慢请求不阻塞空位且峰值受限',async()=>{
    const gate=new CallGate(2,0),started:string[]=[]
    let finishFast!:()=>void,finishSlow!:()=>void,active=0,peak=0
    const work=async(name:string,wait:Promise<void>)=>{started.push(name);peak=Math.max(peak,++active);await wait;active--;return name}
    const fast=gate.run(()=>work('快',new Promise(resolve=>{finishFast=resolve})))
    const slow=gate.run(()=>work('慢',new Promise(resolve=>{finishSlow=resolve})))
    const next=gate.run(()=>work('补发',Promise.resolve()))
    await vi.waitFor(()=>expect(started).toEqual(['快','慢']))
    finishFast();await next
    expect(started).toEqual(['快','慢','补发']);expect(active).toBe(1);expect(peak).toBe(2)
    finishSlow();await Promise.all([fast,slow])
  })
  it('槽位独立冷却，等待期间其他槽位保持运行',async()=>{
    vi.useFakeTimers()
    try{
      const gate=new CallGate(2,50),started:number[]=[]
      let finishFast!:()=>void,finishSlow!:()=>void
      const fast=gate.run(async()=>{await new Promise<void>(resolve=>{finishFast=resolve})})
      const slow=gate.run(async()=>{await new Promise<void>(resolve=>{finishSlow=resolve})})
      const next=gate.run(async()=>{started.push(Date.now())})
      await vi.advanceTimersByTimeAsync(0);finishFast();await fast
      await vi.advanceTimersByTimeAsync(49);expect(started).toHaveLength(0)
      await vi.advanceTimersByTimeAsync(1);await next;expect(started).toHaveLength(1)
      finishSlow();await slow
    }finally{vi.useRealTimers()}
  })
  it('取消中的调用实际退出前仍占槽位，失败退出后继续补发',async()=>{
    const gate=new CallGate(1,0),abort=new AbortController();let finish!:()=>void,started=false
    const current=gate.run(async()=>{await new Promise<void>(resolve=>{finish=resolve});throw new Error('调用已结束')},abort.signal)
    let settled=false
    const rejected=current.catch(error=>{settled=true;return error.message}),next=gate.run(async()=>{started=true})
    await vi.waitFor(()=>expect(finish).toBeTypeOf('function'))
    abort.abort(new Error('用户取消'));await Promise.resolve();expect(settled).toBe(false);expect(started).toBe(false)
    finish();expect(await rejected).toBe('用户取消');await next;expect(started).toBe(true)
  })
  it('并发来源失败时停止后续派发，等待正在取消的工作结束',async()=>{
    const started:number[]=[],finished:number[]=[],abort=new AbortController()
    await expect(mapConcurrent([0,1,2,3],2,abort.signal,async(item,signal)=>{
      started.push(item)
      if(item===0){await Promise.resolve();throw new Error('来源失败')}
      await new Promise<void>(resolve=>signal.addEventListener('abort',()=>resolve(),{once:true}));finished.push(item);signal.throwIfAborted();return item
    })).rejects.toThrow('来源失败')
    expect(started).toEqual([0,1]);expect(finished).toEqual([1])
  })
  it('单个父项拆分后填满有界工作位，递归不持槽等待且所有叶项只执行一次',async()=>{
    let active=0,peak=0;const visited:number[]=[],releases:(()=>void)[]=[]
    const pending=walkConcurrent([1],2,new AbortController().signal,async item=>{
      visited.push(item);peak=Math.max(peak,++active)
      if(item>=4)await new Promise<void>(resolve=>{releases.push(resolve)})
      active--;return item<4?[item*2,item*2+1]:[]
    })
    await vi.waitFor(()=>expect(releases).toHaveLength(2));expect(peak).toBe(2)
    releases[0]!();releases[1]!()
    await vi.waitFor(()=>expect(releases).toHaveLength(4));releases[2]!();releases[3]!()
    await pending;expect(visited.sort((a,b)=>a-b)).toEqual([1,2,3,4,5,6,7]);expect(active).toBe(0);expect(peak).toBe(2)
  })
})
