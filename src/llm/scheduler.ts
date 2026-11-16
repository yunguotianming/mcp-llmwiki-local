import { defaultPolicy } from '../domain/policy.js'
import { ExecutionError, positive, snapshot } from './execution.js'
import type { AdaptiveOptions, CandidateDescriptor, HostExecution, StageBudget } from './execution.js'

export interface LineStatus {
  state: 'healthy' | 'degraded' | 'open' | 'half-open'; effectiveConcurrency: number
  consecutiveFailures: number; nextProbeAt: number | null; blockedUntil: number; retryAfterMissing: boolean
}
class LineHealth {
  private samples: boolean[] = []
  private lastDecrease = -Infinity
  private healthySince = Date.now()
  private successes = 0
  private trips = 0
  private status: LineStatus
  constructor(private readonly limits: CandidateDescriptor['limits'], private readonly adaptive?: AdaptiveOptions) {
    this.status = { state: 'healthy', effectiveConcurrency: adaptive?.enabled ? limits.initialConcurrency : limits.maxConcurrency,
      consecutiveFailures: 0, nextProbeAt: null, blockedUntil: 0, retryAfterMissing: false }
  }
  get(): LineStatus {
    if (this.status.state === 'open' && Date.now() >= this.status.nextProbeAt!) this.status.state = 'half-open'
    return { ...this.status }
  }
  finish(outcome: 'success' | 'failure' | 'neutral', retryAfterMs = 0, missing = false): void {
    const now = Date.now(), state = this.status, options = this.adaptive
    if (outcome === 'neutral') return
    if (outcome === 'failure') { state.blockedUntil = Math.max(state.blockedUntil, now + retryAfterMs); state.retryAfterMissing = missing }
    if (!options?.enabled) return
    this.samples.push(outcome === 'success')
    if (this.samples.length > options.failureRateWindow) this.samples.shift()
    if (outcome === 'failure') {
      state.consecutiveFailures++; this.successes = 0; this.healthySince = now
      if (now - this.lastDecrease >= options.healthWindowMs) {
        state.effectiveConcurrency = Math.max(this.limits.minConcurrency, Math.floor(state.effectiveConcurrency / 2)); this.lastDecrease = now
      }
      const rate = this.samples.filter(success => !success).length / this.samples.length
      if (state.state === 'half-open' || state.consecutiveFailures >= options.consecutiveFailureLimit
        || this.samples.length === options.failureRateWindow && rate >= options.failureRateThreshold) {
        state.state = 'open'
        state.nextProbeAt = Math.max(state.blockedUntil, now + Math.min(options.maxCooldownMs, options.cooldownMs * 2 ** Math.min(this.trips++, 30)))
      } else if (state.state !== 'open') state.state = 'degraded'
      return
    }
    state.consecutiveFailures = 0
    // 熔断前的在途成功不能提前关闭开路状态。
    if (state.state === 'open') return
    if (state.state === 'half-open') {
      state.state = 'degraded'; state.nextProbeAt = null; state.effectiveConcurrency = this.limits.minConcurrency
      this.healthySince = now; this.successes = 0; this.samples = []; return
    }
    this.successes++
    if (now - this.healthySince >= options.healthWindowMs && this.successes >= options.minSuccesses) {
      state.effectiveConcurrency = Math.min(this.limits.maxConcurrency, state.effectiveConcurrency + Math.max(1, Math.floor(state.effectiveConcurrency * 0.05)))
      state.state = state.effectiveConcurrency === this.limits.maxConcurrency ? 'healthy' : 'degraded'
      this.healthySince = now; this.successes = 0; this.trips = 0
    }
  }
}
export interface ScheduledCandidate { candidate: CandidateDescriptor; budget: StageBudget }
export interface Admission {
  libraryId: string; libraryLimit: number; callLimit: number; candidates: ScheduledCandidate[]
  selection: 'priority-spillover' | 'failover'; signal: AbortSignal
}
export interface AdmissionLease {
  selected: ScheduledCandidate
  commit(): void
  finish(outcome: 'success' | 'failure' | 'neutral', actualTokens?: number, retryAfterMs?: number, retryAfterMissing?: boolean): void
}
interface RateEntry { at: number; tokens: number }
interface Resource { active: Map<symbol, number>; rate: RateEntry[] }
interface QueuedAdmission { request: Admission; resolve: (lease: AdmissionLease) => void; reject: (error: unknown) => void; abort: () => void }

/** 一次原子取得所有容量；异步预算预留期间持有可释放租约，不嵌套等待其他闸门。 */
export class StageScheduler {
  private config: HostExecution | undefined
  private resources = new Map<string, Resource>()
  private health = new Map<string, LineHealth>()
  private queues = new Map<string, QueuedAdmission[]>()
  private order: string[] = []
  private timer: ReturnType<typeof setTimeout> | undefined
  private draining = false
  private lastLibrary: string | undefined
  private hostWaiters = new Set<() => void>()
  // 旧 modelGate 与新候选调度使用同一个宿主计数，查询/旧建库不能绕开新总上限。
  tryLegacyHost(): (() => void) | undefined {
    const resource = this.resource('host'), cap = this.config?.globalMaxInFlight ?? 1000
    if (resource.active.size >= Math.min(cap, ...resource.active.values())) return undefined
    const id = Symbol(); resource.active.set(id, cap)
    let released = false
    return () => { if (!released) { released = true; resource.active.delete(id); this.wake() } }
  }
  onHostCapacity(wake: () => void): () => void { this.hostWaiters.add(wake); return () => this.hostWaiters.delete(wake) }
  private wake(): void { queueMicrotask(() => { this.drain(); for (const wake of [...this.hostWaiters]) wake() }) }
  configure(value: HostExecution): void {
    positive(value.globalMaxInFlight, 'globalMaxInFlight')
    if (value.globalMaxInFlight > 1000) throw new ExecutionError('INVALID_EXECUTION', '本版宿主总并发上限为 1000。')
    if (!this.config && (this.resources.get('host')?.active.size ?? 0) > 0 && value.globalMaxInFlight !== 1000)
      throw new ExecutionError('EXECUTION_ACTIVE', '请暂停并等在途退出后再变更宿主执行设置。')
    for (const group of Object.values(value.quotaGroups)) {
      positive(group.maxConcurrency, 'quotaGroups.maxConcurrency')
      if (group.rpm !== undefined) positive(group.rpm, 'quotaGroups.rpm')
      if (group.tpm !== undefined) positive(group.tpm, 'quotaGroups.tpm')
    }
    for (const binding of Object.values(value.lineBindings)) {
      for (const key of ['maxConcurrency', 'initialConcurrency', 'minConcurrency'] as const) positive(binding[key], key)
      if (binding.minConcurrency > binding.initialConcurrency || binding.initialConcurrency > binding.maxConcurrency
        || !value.quotaGroups[binding.quotaGroupId]) throw new ExecutionError('INVALID_EXECUTION', '线路并发或额度组配置冲突。')
      const adaptive = binding.adaptive
      if (adaptive?.enabled) {
        for (const key of ['healthWindowMs', 'minSuccesses', 'consecutiveFailureLimit', 'failureRateWindow', 'cooldownMs', 'maxCooldownMs'] as const) positive(adaptive[key], key)
        if (!(adaptive.failureRateThreshold > 0 && adaptive.failureRateThreshold <= 1) || adaptive.maxCooldownMs < adaptive.cooldownMs)
          throw new ExecutionError('INVALID_EXECUTION', '线路健康窗口配置无效。')
      }
    }
    if (this.config && JSON.stringify(this.config) !== JSON.stringify(value)) {
      if (this.order.length || [...this.resources.values()].some(resource => resource.active.size))
        throw new ExecutionError('EXECUTION_ACTIVE', '请暂停并等在途退出后再变更宿主执行设置。')
      this.health.clear()
    }
    this.config = snapshot(value)
  }
  private resource(key: string): Resource {
    let resource = this.resources.get(key)
    if (!resource) { resource = { active: new Map(), rate: [] }; this.resources.set(key, resource) }
    // 未派发预留不随分钟过期；由租约在取消/超时后释放。
    resource.rate = resource.rate.filter(item => Date.now() - item.at < 60_000)
    return resource
  }
  private line(candidate: CandidateDescriptor): LineHealth {
    const key = JSON.stringify([candidate.lineId, candidate.bindingRevision])
    let health = this.health.get(key)
    if (!health) {
      const binding = this.config!.lineBindings[candidate.lineId]!
      health = new LineHealth(binding, binding.adaptive)
      this.health.set(key, health)
    }
    return health
  }
  lineStatus(candidate: CandidateDescriptor): Readonly<LineStatus> { return Object.freeze(this.line(candidate).get()) }
  private specs(request: Admission, selected: ScheduledCandidate) {
    const candidate = selected.candidate, group = this.config!.quotaGroups[candidate.limits.quotaGroupId]!
    const line = this.line(candidate).get()
    const lineLimit = Math.min(candidate.limits.maxConcurrency, line.state === 'half-open' ? 1 : line.effectiveConcurrency)
    return [
      { key: 'host', cap: this.config!.globalMaxInFlight },
      { key: 'library:' + request.libraryId, cap: Math.min(request.libraryLimit, request.callLimit) },
      { key: 'line:' + candidate.lineId, cap: lineLimit, rpm: candidate.limits.rpm, tpm: candidate.limits.tpm },
      { key: 'quota:' + candidate.limits.quotaGroupId, cap: group.maxConcurrency, rpm: group.rpm, tpm: group.tpm },
    ]
  }
  acquire(request: Admission): Promise<AdmissionLease> {
    request.signal.throwIfAborted()
    positive(request.libraryLimit, '库并发上限'); positive(request.callLimit, '调用并发')
    if (!this.config) throw new ExecutionError('INVALID_EXECUTION', '宿主执行快照未装配。')
    for (const selected of request.candidates) {
      const binding = this.config.lineBindings[selected.candidate.lineId], limits = selected.candidate.limits
      if (!binding || binding.provider !== selected.candidate.provider || binding.quotaGroupId !== limits.quotaGroupId)
        throw new ExecutionError('LINE_UNBOUND', `线路 ${selected.candidate.lineId} 与执行快照不一致。`)
      if (limits.maxConcurrency > binding.maxConcurrency) throw new ExecutionError('INVALID_EXECUTION', '候选不得放大宿主线路上限。')
    }
    // 单请求比分钟总额还大时明确失败，不能无限排队。
    const candidates = request.candidates.filter(selected => this.specs(request, selected).every(spec => spec.tpm === undefined
      || selected.budget.estimatedInputTokens + selected.budget.maxOutputTokens <= spec.tpm))
    if (!candidates.length) return Promise.reject(new ExecutionError('RATE_BUDGET_EXCEEDED', '完整请求超过候选每分钟 Token 上限。'))
    return new Promise((resolve, reject) => {
      const item: QueuedAdmission = { request: { ...request, candidates }, resolve, reject, abort: () => {
        const queue = this.queues.get(request.libraryId), index = queue?.indexOf(item) ?? -1
        if (index >= 0) queue!.splice(index, 1)
        request.signal.removeEventListener('abort', item.abort); reject(request.signal.reason); this.drain()
      } }
      if (!this.queues.has(request.libraryId)) { this.queues.set(request.libraryId, []); this.order.push(request.libraryId) }
      this.queues.get(request.libraryId)!.push(item); request.signal.addEventListener('abort', item.abort, { once: true })
      this.drain()
    })
  }
  private drain(): void {
    if (this.draining) return
    this.draining = true
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    let wakeAt = Infinity
    try {
      const last = this.lastLibrary === undefined ? -1 : this.order.indexOf(this.lastLibrary)
      if (last >= 0) this.order.push(...this.order.splice(0, last + 1))
      let misses = 0
      while (this.order.length && misses < this.order.length) {
        const libraryId = this.order.shift()!, queue = this.queues.get(libraryId)!
        if (!queue.length) { this.queues.delete(libraryId); continue }
        this.order.push(libraryId)
        const item = queue[0]!, request = item.request
        let chosen: ScheduledCandidate | undefined
        for (const selected of request.candidates) {
          const status = this.line(selected.candidate).get(), now = Date.now()
          if (status.state === 'open') { wakeAt = Math.min(wakeAt, status.nextProbeAt!); continue }
          if (status.blockedUntil > now) { wakeAt = Math.min(wakeAt, status.blockedUntil); continue }
          const tokens = selected.budget.estimatedInputTokens + selected.budget.maxOutputTokens
          const ready = this.specs(request, selected).every(spec => {
            const resource = this.resource(spec.key), cap = Math.min(spec.cap, ...resource.active.values())
            if (resource.active.size >= cap) return false
            const blocked = spec.rpm !== undefined && resource.rate.length >= spec.rpm
              || spec.tpm !== undefined && resource.rate.reduce((sum, entry) => sum + entry.tokens, 0) + tokens > spec.tpm
            if (blocked) for (const entry of resource.rate) wakeAt = Math.min(wakeAt, entry.at + 60_000)
            return !blocked
          })
          if (ready) { chosen = selected; break }
          if (request.selection === 'failover') break
        }
        if (!chosen) { misses++; continue }
        misses = 0; queue.shift(); this.lastLibrary = libraryId; request.signal.removeEventListener('abort', item.abort)
        item.resolve(this.reserve(request, chosen))
      }
    } finally {
      this.draining = false
      if (this.order.length && Number.isFinite(wakeAt)) this.timer = setTimeout(() => this.drain(), Math.min(2_147_483_647, Math.max(1, wakeAt - Date.now())))
    }
  }
  private reserve(request: Admission, selected: ScheduledCandidate): AdmissionLease {
    const id = Symbol(), tokens = selected.budget.estimatedInputTokens + selected.budget.maxOutputTokens
    const held = this.specs(request, selected).map(spec => {
      const resource = this.resource(spec.key), rate = { at: Infinity, tokens }
      resource.active.set(id, spec.cap)
      if ('rpm' in spec) resource.rate.push(rate)
      return { resource, rate }
    })
    let committed = false, released = false
    return { selected,
      commit: () => {
        if (released) throw new ExecutionError('LEASE_RELEASED', '已释放的准入不能派发。')
        if (!committed) { committed = true; for (const { rate } of held) rate.at = Date.now() }
      },
      finish: (outcome, actualTokens, retryAfterMs, retryAfterMissing) => {
        if (released) return
        released = true
        for (const { resource, rate } of held) {
          resource.active.delete(id)
          if (!committed) resource.rate = resource.rate.filter(entry => entry !== rate)
          else if (actualTokens !== undefined) rate.tokens = Math.max(0, Math.ceil(actualTokens))
        }
        this.line(selected.candidate).finish(outcome, retryAfterMs, retryAfterMissing)
        this.wake()
      },
    }
  }
}
// 同一宿主进程中的所有 ModelClient 共用，不能按 runtime 对象或库分别建立。
export const stageScheduler = new StageScheduler()

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
  private stopHostWait: (() => void) | undefined
  constructor(globalConcurrency: number, limits: ProviderGateLimits, private readonly sharesHost = false) { this.globalConcurrency = globalConcurrency; this.limits = { concurrency: limits.concurrency, requestsPerMinute: limits.requestsPerMinute, tokensPerMinute: limits.tokensPerMinute, intervalMs: limits.intervalMs ?? 0 } }
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
    this.stopHostWait?.(); this.stopHostWait = undefined
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
      const releaseHost = this.sharesHost ? stageScheduler.tryLegacyHost() : undefined
      if (this.sharesHost && !releaseHost) { this.stopHostWait = stageScheduler.onHostCapacity(() => this.dispatch()); return }
      this.queue.shift()
      this.requests.push(now); const tokenRecord = { at: now, amount: item.tokens }; this.tokens.push(tokenRecord); this.active++; this.activeSlots.set(slot, item.concurrencyCap)
      const finish = () => {
        const actual = item.actualTokens?.(); if (actual !== undefined) tokenRecord.amount = Math.max(0, Math.ceil(actual))
        this.active--; this.activeSlots.delete(slot); this.readyAt[slot] = Date.now() + item.intervalMs
        releaseHost?.()
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
  if (!gate) { gate = new ProviderGate(concurrency ?? defaultPolicy().pageGenerationConcurrency, { concurrency: 1000 }, true); sharedModelGates.set(runtime, gate) }
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
