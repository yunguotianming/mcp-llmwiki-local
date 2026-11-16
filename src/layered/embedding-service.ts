interface GateEntry { concurrency: number; start: () => void }
// 向量端点只限制在途数量，不设槽位冷却；系统时间回拨不应阻塞空闲槽位。
class EmbeddingGate {
  private readonly active = new Set<GateEntry>()
  private readonly queue: GateEntry[] = []
  run<T>(work: () => Promise<T>, concurrency: number, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted()
    return new Promise<T>((resolve, reject) => {
      const cancelled = () => {
        const index = this.queue.indexOf(entry)
        if (index < 0) return
        this.queue.splice(index, 1); signal?.removeEventListener('abort', cancelled)
        reject(signal!.reason); this.dispatch()
      }
      const entry: GateEntry = { concurrency, start: () => {
        signal?.removeEventListener('abort', cancelled)
        this.active.add(entry)
        // 在途调用实际结束后才归还名额；排队取消则立即移除。
        void Promise.resolve().then(() => { signal?.throwIfAborted(); return work() }).then(
          value => { this.active.delete(entry); resolve(value); this.dispatch() },
          error => { this.active.delete(entry); reject(error); queueMicrotask(() => this.dispatch()) },
        )
      } }
      this.queue.push(entry); signal?.addEventListener('abort', cancelled, { once: true })
      this.dispatch()
    })
  }
  private dispatch(): void {
    while (this.queue.length) {
      const entry = this.queue[0]!
      const limit = Math.min(16, entry.concurrency, ...[...this.active].map(item => item.concurrency))
      if (this.active.size >= limit) return
      this.queue.shift(); entry.start()
    }
  }
}

export interface EmbeddingClock {
  now(): number
  schedule(callback: () => void, milliseconds: number): () => void
}
export const systemEmbeddingClock: EmbeddingClock = {
  now: () => Date.now(),
  schedule: (callback, milliseconds) => { const timer = setTimeout(callback, milliseconds); return () => clearTimeout(timer) },
}

interface Probe {
  model: string; run: (signal: AbortSignal) => Promise<unknown>
}
interface Circuit {
  number: number; openedAt: number
  controller: AbortController; recovery?: Promise<void>; error?: Error
}
const failureWindowMs = 10_000, failureThreshold = 5, probeIntervalMs = 15_000, probeTimeoutMs = 5_000, circuitLimitMs = 600_000
const services = new Map<string, EmbeddingService>()

// 端点只在本进程共享；模型、精度和库路径不参与服务限流身份。
export function embeddingService(url: string, clock: EmbeddingClock = systemEmbeddingClock): EmbeddingService {
  const key = new URL(url).href.replace(/\/+$/, '')
  let service = services.get(key)
  if (!service) { service = new EmbeddingService(key, clock); services.set(key, service) }
  return service
}
export function embeddingBackoff(ms: number, signal?: AbortSignal, clock: EmbeddingClock = systemEmbeddingClock): Promise<void> {
  signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const cancelled = () => { cancel(); reject(signal!.reason) }
    const cancel = clock.schedule(() => { signal?.removeEventListener('abort', cancelled); resolve() }, ms)
    signal?.addEventListener('abort', cancelled, { once: true })
  })
}
export function abortableEmbedding<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise
  signal.throwIfAborted()
  return new Promise<T>((resolve, reject) => {
    const aborted = () => reject(signal.reason)
    signal.addEventListener('abort', aborted, { once: true })
    promise.then(value => { signal.removeEventListener('abort', aborted); resolve(value) },
      error => { signal.removeEventListener('abort', aborted); reject(error) })
  })
}
class EmbeddingService {
  private readonly gate = new EmbeddingGate()
  private readonly probeGate = new EmbeddingGate()
  private activeProbe?: { hung: boolean; settled: Promise<void> } | undefined
  private failures: number[] = []
  private circuit: Circuit | undefined
  private openings = 0
  private users = 0
  private readonly probes = new Set<Probe>()
  constructor(private readonly url: string, private readonly clock: EmbeddingClock) {}
  retain(probe?: Probe): void { this.users++; if (probe) this.probes.add(probe) }
  release(probe?: Probe): void {
    if (probe) this.probes.delete(probe)
    if (--this.users || !this.circuit) return
    const circuit = this.circuit
    circuit.controller.abort(new Error('向量请求已全部结束。'))
    if (!circuit.error) this.log('embedding.circuit.close', circuit, { reason: 'cancelled' })
    this.circuit = undefined; this.failures = []
  }
  private log(event: string, circuit: Circuit, detail: Record<string, unknown> = {}): void {
    console.warn(event, { endpoint: this.url, count: circuit.number, durationMs: this.clock.now() - circuit.openedAt, ...detail })
  }
  success(): void { if (!this.circuit) this.failures = [] }
  failure(): void {
    if (this.circuit) return
    const now = this.clock.now()
    this.failures = this.failures.filter(at => now - at <= failureWindowMs)
    this.failures.push(now)
    if (this.failures.length >= failureThreshold) this.open('failure_threshold')
  }
  open(reason: string): void {
    if (this.circuit) return
    const circuit: Circuit = { number: ++this.openings, openedAt: this.clock.now(), controller: new AbortController() }
    this.circuit = circuit
    this.log('embedding.circuit.open', circuit, { reason, failures: this.failures.length })
  }
  async wait(signal?: AbortSignal): Promise<boolean> {
    signal?.throwIfAborted()
    const circuit = this.circuit
    if (!circuit) return false
    if (circuit.error) throw circuit.error
    circuit.recovery ??= this.recover(circuit)
    await abortableEmbedding(circuit.recovery, signal)
    return true
  }
  // 排队后再核实熔断状态；普通请求在闸门外等待熔断恢复。
  async run<T>(work: () => Promise<T>, concurrency: number, signal?: AbortSignal): Promise<T> {
    for (;;) {
      await this.wait(signal)
      const result = await this.gate.run(async () => this.circuit ? { blocked: true as const }
        : { blocked: false as const, value: await work() }, concurrency, signal)
      if (!result.blocked) return result.value
    }
  }
  private async deadline<T>(milliseconds: number, signal: AbortSignal, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    const controller = new AbortController(), combined = AbortSignal.any([signal, controller.signal])
    const cancel = this.clock.schedule(() => controller.abort(new DOMException('向量服务检测超时。', 'TimeoutError')), milliseconds)
    try { return await abortableEmbedding(Promise.resolve().then(() => { combined.throwIfAborted(); return action(combined) }), combined) }
    finally { cancel() }
  }
  private async probe(circuit: Circuit, probe: Probe, signal: AbortSignal): Promise<void> {
    // 悬挂请求仍占单槽；等待它结束可被取消，也受本次熔断总预算约束。
    if (this.activeProbe) await abortableEmbedding(this.activeProbe.settled, signal)
    await this.deadline(probeTimeoutMs, signal, probeSignal => {
      const active = { hung: false, settled: Promise.resolve() }
      const detach = () => { active.hung = true }
      probeSignal.addEventListener('abort', detach, { once: true })
      // 闸门跟随底层 Promise；超时仅结束外层等待，不归还槽位。
      const work = this.probeGate.run(() => probe.run(probeSignal), 1, probeSignal)
      this.activeProbe = active
      const finish = (ok: boolean) => {
        probeSignal.removeEventListener('abort', detach)
        if (this.activeProbe === active) this.activeProbe = undefined
        if (active.hung) this.log('embedding.circuit.probe.settled', circuit, { model: probe.model, ok, ignored: true })
      }
      active.settled = work.then(() => finish(true), () => finish(false))
      return work
    })
  }
  private async recover(circuit: Circuit): Promise<void> {
    const expires = circuit.openedAt + circuitLimitMs
    let successes = 0, nextProbe = circuit.openedAt + probeIntervalMs, round = 0
    let preferred: string | undefined, cursor: string | undefined
    // 降频状态仅属于本次熔断；连续失败两次起，间隔按 2、4、8 轮封顶。
    const attempts = new Map<string, { failures: number; nextRound: number }>()
    try {
      await this.deadline(Math.max(1, expires - this.clock.now()), circuit.controller.signal, async signal => {
        for (;;) {
          await embeddingBackoff(Math.max(0, nextProbe - this.clock.now()), signal, this.clock)
          nextProbe = this.clock.now() + probeIntervalMs
          let ok = false
          round++
          // 同一模型每轮只探一次；成功模型优先，其余模型每轮轮换起点。
          const models = new Map<string, Probe>()
          for (const probe of this.probes) if (!models.has(probe.model)) models.set(probe.model, probe)
          const candidates = [...models.values()]
          const start = (candidates.findIndex(probe => probe.model === cursor) + 1) % (candidates.length || 1)
          const ordered = [...candidates.slice(start), ...candidates.slice(0, start)]
          const previous = preferred && models.get(preferred)
          if (previous) ordered.unshift(...ordered.splice(ordered.indexOf(previous), 1))
          preferred = undefined
          cursor = candidates[start]?.model
          for (const probe of ordered) {
            const attempt = attempts.get(probe.model) ?? { failures: 0, nextRound: 0 }
            if (attempt.nextRound > round) continue
            try {
              // 探活独占端点的单槽通道，不消耗普通请求的 embeddingConcurrency。
              await this.probe(circuit, probe, signal)
              attempts.delete(probe.model)
              preferred = probe.model; ok = true; break
            } catch {
              signal.throwIfAborted()
              attempt.failures++
              attempt.nextRound = round + (attempt.failures < 2 ? 1 : Math.min(8, 2 ** Math.min(3, attempt.failures - 1)))
              attempts.set(probe.model, attempt)
            }
          }
          successes = ok ? successes + 1 : 0
          this.log('embedding.circuit.probe', circuit, { ok, successes })
          if (successes >= 2 && this.clock.now() < expires) return
        }
      })
      if (this.circuit === circuit) {
        this.circuit = undefined; this.failures = []
        this.log('embedding.circuit.close', circuit, { reason: 'recovered' })
      }
    } catch (cause) {
      if (!circuit.controller.signal.aborted) {
        circuit.error = new Error('向量服务熔断已达 10 分钟，保留断点后暂停。', { cause })
        this.log('embedding.circuit.timeout', circuit)
      }
      throw circuit.error ?? cause
    }
  }
}
