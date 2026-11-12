import { defaultPolicy } from '../domain/policy.js'

interface Entry {run:()=>Promise<void>;cancelled:()=>boolean}
interface ProviderGateEntry { work: () => Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void; cancelled: () => boolean; tokens: number; intervalMs: number; concurrencyCap: number; actualTokens?: (() => number | undefined) | undefined }
export interface ProviderGateLimits { concurrency: number; requestsPerMinute?: number | undefined; tokensPerMinute?: number | undefined; intervalMs?: number | undefined }
export class ProviderGate {
  private queue: ProviderGateEntry[] = []
  private active = 0
  private requests: number[] = []
  private tokens: { at: number; amount: number }[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private reducedUntil = 0
  private readyAt: number[] = []
  private activeSlots = new Map<number, number>()
  private limits: { concurrency: number; requestsPerMinute: number | undefined; tokensPerMinute: number | undefined; intervalMs: number }
  private globalConcurrency: number
  constructor(globalConcurrency: number, limits: ProviderGateLimits) { this.globalConcurrency = globalConcurrency; this.limits = { concurrency: limits.concurrency, requestsPerMinute: limits.requestsPerMinute, tokensPerMinute: limits.tokensPerMinute, intervalMs: limits.intervalMs ?? 0 } }
  configure(globalConcurrency: number, limits: ProviderGateLimits): void {
    this.globalConcurrency = globalConcurrency
    this.limits = { concurrency: limits.concurrency, requestsPerMinute: limits.requestsPerMinute, tokensPerMinute: limits.tokensPerMinute, intervalMs: limits.intervalMs ?? 0 }
    this.dispatch()
  }
  penalize(durationMs: number): void { this.reducedUntil = Math.max(this.reducedUntil, Date.now() + durationMs); this.dispatch() }
  run<T>(work: () => Promise<T>, tokens = 0, signal?: AbortSignal, actualTokens?: () => number | undefined, concurrencyCap = Infinity, intervalMs = this.limits.intervalMs): Promise<T> {
    signal?.throwIfAborted()
    if (this.limits.tokensPerMinute !== undefined && tokens > this.limits.tokensPerMinute) return Promise.reject(new Error('单次请求超过供应商每分钟 Token 上限，请缩小输入或调整限流设置。'))
    return new Promise<T>((resolve, reject) => {
      let running = false
      const entry: ProviderGateEntry = { work, resolve: resolve as (value: unknown) => void, reject, cancelled: () => signal?.aborted ?? false, tokens: Math.max(0, Math.ceil(tokens)), intervalMs, concurrencyCap, actualTokens }
      const aborted = () => { if (!running) { signal?.removeEventListener('abort', aborted); reject(signal!.reason); this.dispatch() } }
      signal?.addEventListener('abort', aborted, { once: true })
      // 在途调用退出后才归还槽位和报告取消，避免检查点早于真实调用结束。
      this.queue.push({ ...entry, work: async () => { running = true; try { signal?.throwIfAborted(); return await work() } finally { signal?.removeEventListener('abort', aborted) } } })
      this.dispatch()
    })
  }
  private dispatch(): void {
    if (this.timer !== undefined) { clearTimeout(this.timer); this.timer = undefined }
    const now = Date.now()
    this.requests = this.requests.filter(at => now - at < 60_000)
    this.tokens = this.tokens.filter(item => now - item.at < 60_000)
    this.queue = this.queue.filter(item => !item.cancelled())
    const configured = Math.min(this.globalConcurrency, this.limits.concurrency)
    while (this.readyAt.length < configured) this.readyAt.push(0)
    while (this.queue.length) {
      const activeLimit = this.activeSlots.size ? Math.min(...this.activeSlots.values()) : Infinity
      const baseConcurrency = Math.min(configured, activeLimit, this.queue[0]!.concurrencyCap)
      const concurrency = now >= this.reducedUntil ? baseConcurrency : Math.max(1, Math.floor(baseConcurrency / 2))
      if (this.active >= concurrency) break
      const slot = this.readyAt.findIndex((at, index) => index < concurrency && at <= now && !this.activeSlots.has(index))
      if (slot < 0) {
        const next = this.readyAt.slice(0, concurrency).filter((at, index) => !this.activeSlots.has(index)).sort((a, b) => a - b)[0]
        if (next !== undefined && next > now) this.timer = setTimeout(() => { this.timer = undefined; this.dispatch() }, next - now)
        return
      }
      const item = this.queue[0]!, requestBlocked = this.limits.requestsPerMinute !== undefined && this.requests.length >= this.limits.requestsPerMinute
      const usedTokens = this.tokens.reduce((sum, token) => sum + token.amount, 0)
      const tokenBlocked = this.limits.tokensPerMinute !== undefined && usedTokens + item.tokens > this.limits.tokensPerMinute && (usedTokens > 0 || this.active > 0)
      if (requestBlocked || tokenBlocked) {
        const nextRequest = requestBlocked ? this.requests[0]! + 60_000 : Infinity
        const nextToken = tokenBlocked ? this.tokens[0]!.at + 60_000 : Infinity
        this.timer = setTimeout(() => { this.timer = undefined; this.dispatch() }, Math.max(1, Math.min(nextRequest, nextToken) - now))
        return
      }
      this.queue.shift()
      this.requests.push(now); const tokenRecord = { at: now, amount: item.tokens }; this.tokens.push(tokenRecord); this.active++; this.activeSlots.set(slot, item.concurrencyCap)
      const finish = () => {
        const actual = item.actualTokens?.(); if (actual !== undefined) tokenRecord.amount = Math.max(0, Math.ceil(actual))
        this.active--; this.activeSlots.delete(slot); this.readyAt[slot] = Date.now() + item.intervalMs
      }
      void item.work().then(value => { finish(); item.resolve(value); this.dispatch() }, error => { finish(); item.reject(error); queueMicrotask(() => this.dispatch()) })
    }
    if (now < this.reducedUntil && this.queue.length && this.active >= Math.max(1, Math.floor(configured / 2))) {
      this.timer = setTimeout(() => { this.timer = undefined; this.dispatch() }, this.reducedUntil - now)
    }
  }
}
const sharedProviderGates = new WeakMap<object, Map<string, ProviderGate>>()
const sharedModelGates = new WeakMap<object, ProviderGate>()
// 各任务和供应商共享实际调用总闸门；重试退避发生在 run 外，不占调用名额。
export function modelGate(runtime: object, concurrency?: number): ProviderGate {
  let gate = sharedModelGates.get(runtime)
  if (!gate) { gate = new ProviderGate(concurrency ?? defaultPolicy().pageGenerationConcurrency, { concurrency: 1000 }); sharedModelGates.set(runtime, gate) }
  else if (concurrency !== undefined) gate.configure(concurrency, { concurrency: 1000 })
  return gate
}
export function providerGate(runtime: object, supplier: string, globalConcurrency: number, limits: ProviderGateLimits): ProviderGate {
  let gates = sharedProviderGates.get(runtime)
  if (!gates) { gates = new Map(); sharedProviderGates.set(runtime, gates) }
  let gate = gates.get(supplier)
  if (!gate) { gate = new ProviderGate(globalConcurrency, limits); gates.set(supplier, gate) }
  else gate.configure(globalConcurrency, limits)
  return gate
}
export class CallGate {
  private queue:Entry[]=[]
  private readonly readyAt:number[]
  private timer:ReturnType<typeof setTimeout>|undefined
  constructor(concurrency:number,private readonly intervalMs:number){this.readyAt=Array(concurrency).fill(0)}
  run<T>(work:()=>Promise<T>,signal?:AbortSignal):Promise<T>{
    signal?.throwIfAborted()
    return new Promise<T>((resolve,reject)=>{
      let running=false
      const aborted=()=>{if(!running)reject(signal!.reason);queueMicrotask(()=>this.drain())}
      signal?.addEventListener('abort',aborted,{once:true})
      this.queue.push({cancelled:()=>signal?.aborted??false,run:async()=>{
        running=true
        try{signal?.throwIfAborted();const value=await work();signal?.throwIfAborted();resolve(value)}catch(error){reject(signal?.aborted?signal.reason:error)}finally{signal?.removeEventListener('abort',aborted)}
      }})
      queueMicrotask(()=>this.drain())
    })
  }
  private drain():void{
    if(this.timer!==undefined){clearTimeout(this.timer);this.timer=undefined}
    this.queue=this.queue.filter(entry=>!entry.cancelled())
    while(this.queue.length){
      const next=Math.min(...this.readyAt)
      if(next>Date.now()){
        if(Number.isFinite(next))this.timer=setTimeout(()=>{this.timer=undefined;this.drain()},next-Date.now())
        return
      }
      const slot=this.readyAt.indexOf(next),entry=this.queue.shift()!
      this.readyAt[slot]=Infinity
      // 每个槽位独立冷却，空位补发不等待其他慢请求；取消也须等待实际调用退出。
      void entry.run().then(()=>{this.readyAt[slot]=Date.now()+this.intervalMs;this.drain()})
    }
  }
}
// 工作完成后才派发其子项；父项不占着工作位等待子项，拆分深度不会放大并发。
export async function walkConcurrent<T>(items:T[],concurrency:number,signal:AbortSignal,work:(item:T,signal:AbortSignal)=>Promise<T[]>,recover?:(error:unknown,item:T)=>Promise<T[]>|T[]):Promise<void>{
  signal.throwIfAborted()
  const abort=new AbortController(),combined=AbortSignal.any([signal,abort.signal]),queue=[...items]
  let active=0,next=0,error:unknown,failed=false
  await new Promise<void>(resolve=>{
    const dispatch=()=>{
      while(!combined.aborted&&active<concurrency&&next<queue.length){
        const item=queue[next++]!;active++
        void Promise.resolve().then(async()=>{
          combined.throwIfAborted()
          try{return await work(item,combined)}catch(error){combined.throwIfAborted();if(!recover)throw error;return await recover(error,item)}
        }).then(children=>{
          if(!combined.aborted)queue.push(...children)
        }).catch(cause=>{
          if(!failed){failed=true;error=cause;abort.abort(cause)}
        }).finally(()=>{active--;dispatch()})
      }
      if(active===0)resolve()
    }
    dispatch()
  })
  signal.throwIfAborted();if(failed)throw error
}
export async function mapConcurrent<T,R>(items:T[],concurrency:number,signal:AbortSignal,work:(item:T,signal:AbortSignal)=>Promise<R>,recover?:(error:unknown,item:T,index:number)=>Promise<R>|R):Promise<R[]>{
  const abort=new AbortController(),combined=AbortSignal.any([signal,abort.signal]),results:R[]=new Array(items.length)
  let next=0,error:unknown,failed=false
  await Promise.all(Array.from({length:Math.min(concurrency,items.length)},async()=>{
    while(!combined.aborted){
      const index=next++;if(index>=items.length)return
      try{
        try{results[index]=await work(items[index]!,combined)}catch(cause){combined.throwIfAborted();if(!recover)throw cause;results[index]=await recover(cause,items[index]!,index)}
      }catch(cause){if(!failed){failed=true;error=cause;abort.abort(cause)}return}
    }
  }))
  signal.throwIfAborted();if(failed)throw error
  return results
}
