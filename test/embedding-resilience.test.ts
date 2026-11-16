import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { setImmediate as yieldTurn } from 'node:timers/promises'
import path from 'node:path'
import { layeredSettings } from '../src/domain/config.js'
import { buildRegistrationKey } from '../src/domain/build-identity.js'
import { buildConfiguration } from '../src/layered/build-configuration.js'
import { embedInputs, OllamaEmbeddingClient } from '../src/layered/embedding.js'
import { embeddingBackoff, embeddingService, type EmbeddingClock } from '../src/layered/embedding-service.js'
import { buildLayeredLibrary as runBuild, readLayeredPage } from '../src/layered/index.js'
import { vectorPath } from '../src/layered/vectors.js'
import type { EmbeddingIdentity, PendingBuild } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, layeredFixture as createFixture, layeredIncrementalFixture as createIncrementalFixture, restoreFixture, snapshotFixture, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
const temporaryRoots = new Set<string>()
const activeBuilds = new Map<AbortController, ReturnType<typeof runBuild>>()
async function trackFixture<T extends { knowledgeRoot: string }>(fixture: Promise<T>): Promise<T> {
  const value = await fixture; temporaryRoots.add(value.knowledgeRoot); return value
}
const layeredFixture = () => trackFixture(createFixture())
const layeredIncrementalFixture = () => trackFixture(createIncrementalFixture())
function buildLayeredLibrary(options: Parameters<typeof runBuild>[0]): ReturnType<typeof runBuild> {
  const controller = new AbortController()
  const running = runBuild({ ...options, signal: options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal })
  activeBuilds.set(controller, running)
  void running.finally(() => activeBuilds.delete(controller)).catch(() => {})
  return running
}
afterEach(async () => {
  const running = [...activeBuilds.values()]
  for (const controller of activeBuilds.keys()) controller.abort(new Error('测试结束，取消未完成建库。'))
  await Promise.allSettled(running)
  vi.useRealTimers(); cleanupLayeredFixtures()
  // 先等取消释放文件，再按 7166543 的参数重试 Windows 临时占用。
  const results = await Promise.allSettled([...temporaryRoots].map(root => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })))
  temporaryRoots.clear()
  const errors = results.filter(result => result.status === 'rejected').map(result => result.reason)
  if (errors.length) throw new AggregateError(errors, '临时夹具清理失败。')
})
function fakeEmbeddingClock() {
  let now = 0, sequence = 0
  const timers = new Map<number, { at: number; callback: () => void }>()
  const clock: EmbeddingClock = {
    now: () => now,
    schedule(callback, milliseconds) {
      const id = ++sequence; timers.set(id, { at: now + milliseconds, callback })
      return () => { timers.delete(id) }
    },
  }
  return { clock, pending: () => timers.size, async advance(milliseconds: number) {
    const until = now + milliseconds
    // 让响应正文解析及 Promise 链先登记退避；不推进页面时间或依赖真实探活等待。
    await yieldTurn()
    for (;;) {
      const next = [...timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0]
      if (!next || next[1].at > until) break
      now = next[1].at; timers.delete(next[0]); next[1].callback()
      await yieldTurn()
    }
    now = until
  } }
}
function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(done => { resolve = done })
  return { promise, resolve }
}
let endpoint = 0
const settingsFor = (concurrency = 3) => layeredSettings({ localEmbeddingUrl: 'http://embedding-' + ++endpoint + '.invalid', embeddingConcurrency: concurrency, embeddingBatchSize: 1, topicMergeMinSources: 1 })
const good = (input: string[]) => new Response(JSON.stringify({ embeddings: input.map(() => [1, 0]) }))
const bad = (error = 'Post http://127.0.0.1:54587/tokenize: dial tcp: connectex: actively refused') => new Response(JSON.stringify({ error }), { status: 400 })
const identityFor = (settings: ReturnType<typeof settingsFor>): EmbeddingIdentity => ({ provider: 'ollama', model: settings.localEmbeddingModel, revision: 'fixture-weights-v1', dimensions: 2, precision: settings.vectorPrecision, document_preprocessing: 'utf8-normalized-v1', query_preprocessing: 'qwen3-retrieval-v1' })
function fakeService(settings: ReturnType<typeof settingsFor>, respond: (input: string[], signal: AbortSignal) => Response | Promise<Response> = good) {
  return vi.fn<typeof fetch>(async (url, init) => String(url).endsWith('/api/tags')
    ? new Response(JSON.stringify({ models: [{ name: settings.localEmbeddingModel, digest: 'fixture-weights-v1' }] }))
    : respond(JSON.parse(String(init!.body)).input, init!.signal!))
}
function events() {
  const opened = deferred(), records: { event: string; detail: Record<string, unknown> }[] = []
  vi.spyOn(console, 'warn').mockImplementation((event, detail) => {
    records.push({ event, detail }); if (event === 'embedding.circuit.open') opened.resolve()
  })
  return { opened: opened.promise, records }
}
async function products(f: Awaited<ReturnType<typeof layeredIncrementalFixture>>) {
  const manifest = await snapshotManifest(f.root), bytes: Record<string, string> = {}
  for (const page of Object.keys(manifest.pages ?? {}).sort()) bytes[page] = await readLayeredPage(f.knowledgeRoot, page)
  for (const file of (await readdir(path.join(f.root, 'objects/vectors'))).sort()) bytes['vectors/' + file] = (await readFile(path.join(f.root, 'objects/vectors', file))).toString('base64')
  return bytes
}
async function buildFixture(concurrency: number) {
  const f = await layeredIncrementalFixture()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组旧证据。')
  await buildLayeredLibrary(f.options)
  const settings = settingsFor(concurrency)
  f.policy.pageGenerationConcurrency = concurrency
  f.options.topics = settings
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), Array.from({ length: 8 }, (_, i) => '甲组新增证据' + i + '。').join('\n\n'))
  return { f, settings }
}

describe('请求与恢复', () => {
  it('同端点空闲后回拨系统时间不阻塞下一批，也不生成槽位等待定时器', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    vi.setSystemTime(new Date('2030-01-01T00:00:00Z'))
    const settings = settingsFor(1), request = fakeService(settings)
    const client = new OllamaEmbeddingClient(settings, request), controller = new AbortController()
    expect(await client.embed(['回拨前正文'])).toEqual([[1, 0]])
    vi.setSystemTime(new Date('2020-01-01T00:00:00Z'))
    const running = client.embed(['回拨后正文'], controller.signal)
    void running.catch(() => {})
    try {
      await vi.advanceTimersByTimeAsync(0)
      expect(request).toHaveBeenCalledTimes(2)
      expect(vi.getTimerCount()).toBe(0)
      expect(await running).toEqual([[1, 0]])
    } finally {
      controller.abort(new Error('测试结束，取消未完成向量请求。'))
      await Promise.allSettled([running])
    }
  })

  it('瞬时400和连接超时按2、4、8秒退避后成功，正文窄匹配', async () => {
    vi.useFakeTimers()
    const settings = settingsFor(), request = fakeService(settings)
    request.mockResolvedValueOnce(bad('Post "http://127.0.0.1:54587": connectex'))
      .mockResolvedValueOnce(bad('/tokenize: actively refused')).mockResolvedValueOnce(bad('/embedding: dial tcp'))
    const result = new OllamaEmbeddingClient(settings, request).embed(['正文'])
    for (const [delay, calls] of [[2000, 1], [4000, 2], [8000, 3]]) {
      await vi.advanceTimersByTimeAsync(delay! - 1); expect(request).toHaveBeenCalledTimes(calls!)
      await vi.advanceTimersByTimeAsync(1)
    }
    expect(await result).toEqual([[1, 0]]); expect(request).toHaveBeenCalledTimes(4)
    for (const marker of ['/tokenize: connectex', '/embedding: connection refused', '/completion: dial tcp']) {
      const another = fakeService(settingsFor()).mockResolvedValueOnce(bad(marker))
      const run = new OllamaEmbeddingClient(settingsFor(), another).embed(['正文'])
      await vi.advanceTimersByTimeAsync(2000); expect(await run).toEqual([[1, 0]]); expect(another).toHaveBeenCalledTimes(2)
    }
    const transport = fakeService(settingsFor()).mockRejectedValueOnce(new TypeError('fetch failed')).mockImplementationOnce(async (_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })))
    const run = new OllamaEmbeddingClient({ ...settingsFor(), embeddingTimeoutMs: 100 }, transport).embed(['正文'])
    await vi.advanceTimersByTimeAsync(6100); expect(await run).toEqual([[1, 0]]); expect(transport).toHaveBeenCalledTimes(3)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('真正400不重试，保留错误正文且不触发熔断', async () => {
    vi.useFakeTimers(); const log = events()
    for (const message of ['model "x" not found', 'invalid input', 'input length exceeds', 'invalid parameter', 'invalid timeout', 'beforeof', '/tokenize', '/embedding', '/completion', 'connectex', 'actively refused', 'dial tcp']) {
      const request = fakeService(settingsFor()).mockResolvedValue(bad(message))
      const error = await new OllamaEmbeddingClient(settingsFor(), request).embed(['正文']).catch(error => error)
      expect(error.cause).toMatchObject({ status: 400, body: JSON.stringify({ error: message }) })
      expect(request).toHaveBeenCalledTimes(1)
    }
    expect(log.records).toEqual([]); expect(vi.getTimerCount()).toBe(0)
  })

  it('正文含EOF但没有内部转发特征的400不重试', async () => {
    vi.useFakeTimers(); const settings = settingsFor(), log = events()
    const message = 'invalid input: EOF is a reserved word', request = fakeService(settings).mockResolvedValue(bad(message))
    const error = await new OllamaEmbeddingClient(settings, request).embed(['正文']).catch(error => error)
    await vi.advanceTimersByTimeAsync(60000)
    expect(error.cause).toMatchObject({ status: 400, body: JSON.stringify({ error: message }) })
    expect(request).toHaveBeenCalledTimes(1); expect(log.records).toEqual([]); expect(vi.getTimerCount()).toBe(0)
  }, 9000)

  it('正文含connection refused但没有内部转发特征的400不重试', async () => {
    vi.useFakeTimers(); const settings = settingsFor(), log = events()
    const message = 'invalid input: connection refused', request = fakeService(settings).mockResolvedValue(bad(message))
    const error = await new OllamaEmbeddingClient(settings, request).embed(['正文']).catch(error => error)
    await vi.advanceTimersByTimeAsync(60000)
    expect(error.cause).toMatchObject({ status: 400, body: JSON.stringify({ error: message }) })
    expect(request).toHaveBeenCalledTimes(1); expect(log.records).toEqual([]); expect(vi.getTimerCount()).toBe(0)
  }, 9000)

  it('同端点缺失模型先触发熔断，恢复由另一个等待模型探活且各自完成或报错', async () => {
    vi.useFakeTimers({ toFake: ['Date'] }); const time = fakeEmbeddingClock(), log = events()
    const settings = { ...settingsFor(1), localEmbeddingModel: 'qwen3-embedding:0.6b' }
    const other = { ...settings, localEmbeddingUrl: settings.localEmbeddingUrl + '/', localEmbeddingModel: 'qwen3-embedding:8b' }
    const controller = new AbortController(), missing = 'model "qwen3-embedding:0.6b" not found'
    let offline = true, finished = false
    const request = vi.fn<typeof fetch>(async (_url, init) => {
      const { model, input } = JSON.parse(String(init!.body)) as { model: string; input: string[] }
      if (offline) return bad()
      if (model === settings.localEmbeddingModel) return new Response(JSON.stringify({ error: missing }), { status: 404 })
      return good(input)
    })
    const unavailable = new OllamaEmbeddingClient(settings, request, 1, time.clock).embed(['缺失模型正文'], controller.signal).catch(error => error)
    let available: Promise<unknown> | undefined
    try {
      await time.advance(2000); await log.opened
      available = new OllamaEmbeddingClient(other, request, 3, time.clock).embed(['正常模型正文'], controller.signal)
        .then(value => { finished = true; return value }, error => error)
      offline = false
      await time.advance(14999); expect(request).toHaveBeenCalledTimes(2); expect(finished).toBe(false)
      await time.advance(1); expect(finished).toBe(false)
      expect(log.records.filter(r => r.event === 'embedding.circuit.probe').map(r => r.detail.successes)).toEqual([1])
      await time.advance(15000); expect(finished).toBe(true)
      expect(await available).toEqual([[1, 0]])
      expect((await unavailable).cause).toMatchObject({ status: 404, body: JSON.stringify({ error: missing }) })
      const bodies = request.mock.calls.map(call => JSON.parse(String(call[1]!.body)) as { model: string; input: string[] })
      expect(bodies.filter(body => body.model === settings.localEmbeddingModel && body.input[0] === '.')).toHaveLength(1)
      expect(bodies.filter(body => body.model === other.localEmbeddingModel && body.input[0] === '.')).toHaveLength(2)
      expect(log.records.filter(r => r.event === 'embedding.circuit.open')).toHaveLength(1)
      expect(log.records.find(r => r.event === 'embedding.circuit.close')!.detail).toMatchObject({ reason: 'recovered', durationMs: 30000 })
      expect(time.pending()).toBe(0)
    } finally {
      controller.abort(new Error('测试结束，取消未完成向量请求。'))
      await Promise.allSettled([unavailable, available])
    }
  }, 9000)

  it('20个慢失败模型排在健康模型前仍在预算内恢复，第二轮优先健康模型', async () => {
    const time = fakeEmbeddingClock(), log = events(), settings = settingsFor()
    const service = embeddingService(settings.localEmbeddingUrl, time.clock), controller = new AbortController()
    const calls: string[] = [], aborted: number[] = []
    const probes = Array.from({ length: 21 }, (_, index) => ({
      model: '模型' + index,
      run: async (signal: AbortSignal) => {
        calls.push('模型' + index)
        if (index === 20) return
        const startedAt = time.clock.now()
        try { await embeddingBackoff(90_000, signal, time.clock) }
        finally { aborted.push(time.clock.now() - startedAt) }
      },
    }))
    for (const probe of probes) service.retain(probe)
    service.open('failure_threshold')
    let finished = false
    const running = service.run(async () => { finished = true }, 3, controller.signal)
    void running.catch(() => {})
    try {
      await time.advance(114_999); expect(finished).toBe(false)
      expect(aborted).toEqual(Array(19).fill(5000))
      // 首轮已超过轮次间隔，下一轮到期后立即优先复探健康模型。
      await time.advance(1); await running
      expect(calls.slice(0, 21)).toEqual(probes.map(probe => probe.model))
      expect(log.records.filter(r => r.event === 'embedding.circuit.probe').map(r => r.detail.successes)).toEqual([1, 2])
      expect(finished).toBe(true)
      expect(calls.slice(21)).toEqual(['模型20'])
      expect(aborted).toEqual(Array(20).fill(5000))
      expect(log.records.some(r => r.event === 'embedding.circuit.timeout')).toBe(false)
      expect(log.records.find(r => r.event === 'embedding.circuit.close')!.detail).toMatchObject({ reason: 'recovered', durationMs: 115000 })
      expect(time.pending()).toBe(0)
    } finally {
      controller.abort(new Error('测试结束，取消未完成向量请求。'))
      await Promise.allSettled([running])
      for (const probe of probes) service.release(probe)
    }
  }, 9000)

  it('没有成功模型时每轮轮换起点，连续失败两次的模型跳过下一轮', async () => {
    const time = fakeEmbeddingClock(), log = events(), settings = settingsFor()
    const service = embeddingService(settings.localEmbeddingUrl, time.clock), controller = new AbortController()
    const calls: string[] = []
    const probes = ['甲', '乙', '丙'].map(model => ({ model, run: async () => { calls.push(model); throw new TypeError('连接失败') } }))
    for (const probe of probes) service.retain(probe)
    service.open('failure_threshold')
    const running = service.wait(controller.signal).catch(error => error)
    try {
      await time.advance(15_000); expect(calls).toEqual(['甲', '乙', '丙'])
      await time.advance(15_000); expect(calls.slice(3)).toEqual(['乙', '丙', '甲'])
      await time.advance(15_000); expect(calls).toHaveLength(6)
      await time.advance(15_000); expect(calls.slice(6)).toEqual(['甲', '乙', '丙'])
      expect(log.records.filter(r => r.event === 'embedding.circuit.probe').map(r => r.detail.successes)).toEqual([0, 0, 0, 0])
    } finally {
      controller.abort(new Error('测试结束，取消未完成向量请求。'))
      for (const probe of probes) service.release(probe)
      await running; await time.advance(0)
    }
    expect(time.pending()).toBe(0)
  }, 9000)

  it.each([3, 7])('探活独占单槽，普通请求并发%s个时仍能探活且恢复后不超限', async cap => {
    const time = fakeEmbeddingClock(), log = events(), settings = settingsFor(cap)
    const service = embeddingService(settings.localEmbeddingUrl, time.clock), controller = new AbortController(), release = deferred()
    let normal = 0, normalPeak = 0, probes = 0, probePeak = 0, totalPeak = 0, completed = 0
    const request = fakeService(settings, async (input, signal) => {
      const probe = input[0] === '.'
      if (probe) { probes++; probePeak = Math.max(probePeak, probes) }
      else { normal++; normalPeak = Math.max(normalPeak, normal) }
      totalPeak = Math.max(totalPeak, normal + probes)
      try {
        if (probe) await embeddingBackoff(1000, signal, time.clock)
        else await release.promise
        return good(input)
      } finally { if (probe) probes--; else normal-- }
    })
    const client = new OllamaEmbeddingClient(settings, request, 3, time.clock)
    const start = (text: string) => client.embed([text], controller.signal).then(value => { completed++; return value })
    const running = Array.from({ length: cap }, (_, index) => start('在途' + index))
    for (const work of running) void work.catch(() => {})
    try {
      await time.advance(0); expect(normal).toBe(cap)
      service.open('failure_threshold')
      running.push(...Array.from({ length: cap + 1 }, (_, index) => start('等待' + index)))
      for (const work of running) void work.catch(() => {})
      await time.advance(15_000)
      expect(normal).toBe(cap); expect(probes).toBe(1); expect(totalPeak).toBe(cap + 1)
      await time.advance(1000)
      expect(completed).toBe(0); expect(probes).toBe(0)
      await time.advance(14_000); expect(probes).toBe(1)
      await time.advance(1000)
      expect(log.records.find(r => r.event === 'embedding.circuit.close')!.detail.reason).toBe('recovered')
      expect(normal).toBe(cap); expect(completed).toBe(0)
      release.resolve()
      expect(await Promise.all(running)).toEqual(Array.from({ length: cap * 2 + 1 }, () => [[1, 0]]))
      expect(normalPeak).toBe(cap); expect(probePeak).toBe(1); expect(totalPeak).toBe(cap + 1)
      expect(normal).toBe(0); expect(probes).toBe(0); expect(time.pending()).toBe(0)
    } finally {
      controller.abort(new Error('测试结束，取消未完成向量请求。')); release.resolve()
      await Promise.allSettled(running)
    }
  }, 9000)

  it('连续瞬时失败熔断，连续两次探活成功自动续建，页面和向量字节一致', async () => {
    const { f, settings } = await buildFixture(3), baseline = await snapshotFixture(f.knowledgeRoot)
    // 页面时间固定，两轮共用单调前进的向量时钟，仅推进重试与探活。
    vi.useFakeTimers({ toFake: ['Date'] }); const time = fakeEmbeddingClock(), log = events()
    let failures = 0, probes = 0
    const firstWave = deferred()
    const request = fakeService(settings, input => {
      if (input[0] === '.') { probes++; return probes === 2 ? bad() : good(input) }
      if (failures < 5) { if (++failures === 3) firstWave.resolve(); return bad() }
      return good(input)
    })
    const client = new OllamaEmbeddingClient(settings, request, 3, time.clock), embed = client.embed.bind(client)
    const pending = new Set<string>(), completed = new Set<string>()
    vi.spyOn(client, 'embed').mockImplementation(async (input, signal) => {
      input.forEach(text => pending.add(text))
      try { const result = await embed(input, signal); input.forEach(text => completed.add(text)); return result }
      finally { input.forEach(text => pending.delete(text)) }
    })
    f.options.embeddingClient = client
    let finished = false
    const running = buildLayeredLibrary(f.options).finally(() => { finished = true })
    void running.catch(() => {})
    await firstWave.promise; await time.advance(2000); await log.opened
    const queued = [...pending]
    expect(queued).toHaveLength(3)
    const calls = request.mock.calls.length
    await time.advance(14999); expect(request).toHaveBeenCalledTimes(calls); expect(finished).toBe(false)
    await time.advance(1); expect(probes).toBe(1); expect(finished).toBe(false)
    await time.advance(30000); expect(probes).toBe(3); expect(finished).toBe(false)
    await time.advance(15000)
    expect(await running).toMatchObject({ unchanged: false })
    expect(probes).toBe(4)
    expect(log.records.filter(r => r.event === 'embedding.circuit.open')).toHaveLength(1)
    expect(log.records.filter(r => r.event === 'embedding.circuit.probe').map(r => [r.detail.ok, r.detail.successes])).toEqual([[true, 1], [false, 0], [true, 1], [true, 2]])
    expect(log.records.find(r => r.event === 'embedding.circuit.close')!.detail).toMatchObject({ reason: 'recovered', count: 1, durationMs: 60000 })
    expect(queued.every(text => completed.has(text))).toBe(true); expect(pending.size).toBe(0)
    expect(time.pending()).toBe(0)
    expect((await snapshotManifest(f.root)).vector_state!.coverage.missing).toEqual([])
    await expect(stat(path.join(f.root, 'work/pending.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const recovered = await products(f)
    expect(Object.keys(recovered).some(key => key.startsWith('topics/'))).toBe(true)
    expect(Object.keys(recovered).some(key => key.startsWith('vectors/'))).toBe(true)
    await restoreFixture(baseline, f.knowledgeRoot)
    // 健康对照复用端点且无需推进时钟，直接证明闸门与排队请求已释放；完整页头仍逐字节比较。
    f.options.embeddingClient = new OllamaEmbeddingClient(settings, fakeService(settings), 3, time.clock)
    expect(await buildLayeredLibrary(f.options)).toMatchObject({ unchanged: false })
    expect(time.pending()).toBe(0)
    expect(await products(f)).toEqual(recovered)
  }, 9000)

  it('低并发重试用尽转熔断，满10分钟才落盘暂停，断点续跑不重提', async () => {
    const { f, settings } = await buildFixture(1), currentFile = path.join(f.root, 'state/current.json'), current = await readFile(currentFile, 'utf8')
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); const log = events(), failed = deferred()
    let normal = 0, offline = true
    const request = fakeService(settings, input => {
      if (!offline || input[0] !== '.' && ++normal === 1) return good(input)
      failed.resolve(); return bad()
    })
    f.options.embeddingClient = new OllamaEmbeddingClient(settings, request)
    let finished = false
    const running = buildLayeredLibrary(f.options).catch(error => error).finally(() => { finished = true })
    await failed.promise; await vi.advanceTimersByTimeAsync(14000); await log.opened
    expect(log.records[0]!.detail.reason).toBe('retry_exhausted')
    await vi.advanceTimersByTimeAsync(599999); expect(finished).toBe(false)
    const pendingFile = path.join(f.root, 'work/pending.json')
    expect(JSON.parse(await readFile(pendingFile, 'utf8')).paused).toBeUndefined()
    expect(await readFile(currentFile, 'utf8')).toBe(current)
    await vi.advanceTimersByTimeAsync(1); expect(await running).toMatchObject({ message: '本地向量模型不可用，主题聚类已暂停。' })
    const pending = JSON.parse(await readFile(pendingFile, 'utf8')) as PendingBuild
    expect(pending.paused?.reason).toBe('embedding'); expect(pending.manifest.vector_state!.coverage.missing.length).toBeGreaterThan(0)
    expect(log.records.find(r => r.event === 'embedding.circuit.timeout')!.detail.durationMs).toBe(600000)
    expect(await readFile(currentFile, 'utf8')).toBe(current)
    const cached = JSON.parse(await readFile(path.join(f.root, 'state/embeddings.json'), 'utf8'))
    const preserved = await Promise.all(Object.values(cached.vectors as Record<string, { vector_id: string }>).map(async ref => [vectorPath(ref.vector_id), await readFile(path.join(f.root, vectorPath(ref.vector_id)))] as const))
    offline = false; request.mockClear(); f.requests.length = 0
    await buildLayeredLibrary(f.options)
    expect(f.requests).toHaveLength(0)
    const inputs = request.mock.calls.filter(call => String(call[0]).endsWith('/api/embed')).flatMap(call => JSON.parse(String(call[1]!.body)).input)
    expect(inputs).not.toContain('甲组旧证据。'); expect(inputs).not.toContain('甲组新增证据0。'); expect(inputs).not.toContain('.')
    for (const [file, bytes] of preserved) expect(await readFile(path.join(f.root, file))).toEqual(bytes)
    expect(await readFile(currentFile, 'utf8')).not.toBe(current)
  }, 30000)

  it('两个库与不同向量身份共用端点闸门，配置1到16且不改变内容指纹', async () => {
    const a = await layeredFixture(), b = await layeredFixture(), settings = settingsFor(2)
    const other = { ...settings, localEmbeddingUrl: settings.localEmbeddingUrl + '/', localEmbeddingModel: '另一个模型' }
    const release = deferred(), full = deferred()
    let active = 0, peak = 0
    const respond = async (input: string[]) => {
      active++; peak = Math.max(peak, active); if (active === 2) full.resolve()
      await release.promise; active--; return good(input)
    }
    const inputs = Array.from({ length: 8 }, (_, i) => '正文' + i)
    const work = Promise.all([embedInputs(a.root, inputs, settings, new OllamaEmbeddingClient(settings, fakeService(settings, respond)), undefined, 16),
      embedInputs(b.root, inputs, other, new OllamaEmbeddingClient(other, fakeService(other, respond)), undefined, 16)])
    await full.promise; expect(peak).toBe(2); release.resolve(); await work; expect(peak).toBe(2)
    expect(layeredSettings().embeddingConcurrency).toBe(3)
    for (const value of [0, 17, 1.5, NaN]) expect(() => layeredSettings({ embeddingConcurrency: value })).toThrow()
    expect(layeredSettings({ embeddingConcurrency: 16 }).embeddingConcurrency).toBe(16)
    expect(buildConfiguration(settings)).toBe(buildConfiguration({ ...settings, embeddingConcurrency: 16 }))
    expect(buildRegistrationKey({ ...a.library, layered: settings })).toBe(buildRegistrationKey({ ...a.library, layered: { ...settings, embeddingConcurrency: 16 } }))
  })
})

describe('悬挂探活', () => {
  it('忽略abort的请求超时后仍占单槽，其他模型不探活且熔断总预算继续计时', async () => {
    const time = fakeEmbeddingClock(), log = events(), settings = settingsFor()
    const service = embeddingService(settings.localEmbeddingUrl, time.clock), controller = new AbortController(), release = deferred()
    let active = 0, peak = 0, finished = false
    const signals: AbortSignal[] = []
    const probes = ['甲', '乙'].map(model => ({ model, run: async (signal: AbortSignal) => {
      signals.push(signal); active++; peak = Math.max(peak, active)
      try { await release.promise; throw new TypeError('悬挂请求最终失败') }
      finally { active-- }
    } }))
    for (const probe of probes) service.retain(probe)
    service.open('failure_threshold')
    const running = service.wait(controller.signal).catch(error => error).finally(() => { finished = true })
    try {
      await time.advance(15_000); expect(active).toBe(1)
      await time.advance(5000); expect(signals[0]!.aborted).toBe(true)
      await time.advance(15_000)
      expect(signals).toHaveLength(1); expect(active).toBe(1); expect(peak).toBe(1)
      await time.advance(564_999)
      expect(finished).toBe(false); expect(signals).toHaveLength(1); expect(active).toBe(1)
      await time.advance(1)
      expect(await running).toMatchObject({ message: '向量服务熔断已达 10 分钟，保留断点后暂停。' })
      expect(signals).toHaveLength(1); expect(peak).toBe(1); expect(active).toBe(1)
      expect(log.records.find(r => r.event === 'embedding.circuit.timeout')!.detail.durationMs).toBe(600_000)
      expect(time.pending()).toBe(0)
    } finally {
      controller.abort(new Error('测试结束，取消探活等待。'))
      for (const probe of probes) service.release(probe)
      release.resolve(); await running; await time.advance(0)
    }
    expect(active).toBe(0); expect(time.pending()).toBe(0)
    expect(log.records.find(r => r.event === 'embedding.circuit.probe.settled')!.detail).toMatchObject({ ok: false, ignored: true })
  }, 9000)

  it('悬挂请求最终成功只记日志，恢复仍需后续连续两轮成功', async () => {
    const time = fakeEmbeddingClock(), log = events(), settings = settingsFor()
    const service = embeddingService(settings.localEmbeddingUrl, time.clock), controller = new AbortController(), release = deferred()
    let calls = 0, finished = false
    const probe = { model: settings.localEmbeddingModel, run: async () => { if (++calls === 1) await release.promise } }
    service.retain(probe); service.open('failure_threshold')
    const running = service.wait(controller.signal).then(() => { finished = true })
    void running.catch(() => {})
    const successes = () => log.records.filter(r => r.event === 'embedding.circuit.probe').map(r => r.detail.successes)
    try {
      await time.advance(25_000)
      expect(calls).toBe(1); expect(successes()).toEqual([0]); expect(finished).toBe(false)
      release.resolve(); await time.advance(0)
      expect(log.records.find(r => r.event === 'embedding.circuit.probe.settled')!.detail).toMatchObject({ ok: true, ignored: true })
      expect(calls).toBe(1); expect(successes()).toEqual([0]); expect(finished).toBe(false)
      await time.advance(5000)
      expect(calls).toBe(2); expect(successes()).toEqual([0, 1]); expect(finished).toBe(false)
      await time.advance(14_999); expect(finished).toBe(false)
      await time.advance(1); await running
      expect(calls).toBe(3); expect(successes()).toEqual([0, 1, 2]); expect(finished).toBe(true)
      expect(log.records.find(r => r.event === 'embedding.circuit.close')!.detail).toMatchObject({ reason: 'recovered', durationMs: 45_000 })
      expect(time.pending()).toBe(0)
    } finally {
      controller.abort(new Error('测试结束，取消探活等待。')); service.release(probe)
      release.resolve(); await Promise.allSettled([running]); await time.advance(0)
    }
  }, 9000)

  it('悬挂时取消建库立即收尾，无残留计时器，迟到结果不改写断点和已发布状态', async () => {
    const { f, settings } = await buildFixture(1)
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
    const time = fakeEmbeddingClock(), log = events(), failed = deferred(), release = deferred(), controller = new AbortController()
    let active = 0, probes = 0
    const signals: AbortSignal[] = []
    const request = fakeService(settings, async (input, signal) => {
      if (input[0] !== '.') { failed.resolve(); return bad() }
      probes++; active++; signals.push(signal)
      try { await release.promise; return good(input) }
      finally { active-- }
    })
    // 请求本身的超时远晚于探活超时，以检查取消是否主动撤销它。
    f.options.embeddingClient = new OllamaEmbeddingClient({ ...settings, embeddingTimeoutMs: 90_000 }, request, 1, time.clock)
    const running = buildLayeredLibrary({ ...f.options, signal: controller.signal }).catch(error => error)
    try {
      await failed.promise; await time.advance(2000); await log.opened
      await time.advance(20_000)
      expect(probes).toBe(1); expect(active).toBe(1); expect(signals[0]!.aborted).toBe(true)
      const reason = new Error('用户取消悬挂中的建库。')
      controller.abort(reason)
      // 底层尚未结束，建库就必须完成取消，不能依赖释放夹具来退出。
      expect(await running).toBe(reason)
      await time.advance(0)
      expect(active).toBe(1); expect(activeBuilds.size).toBe(0)
      expect(time.pending()).toBe(0); expect(vi.getTimerCount()).toBe(0)
      const pendingFile = path.join(f.root, 'work/pending.json'), currentFile = path.join(f.root, 'state/current.json')
      const pending = await readFile(pendingFile, 'utf8'), current = await readFile(currentFile, 'utf8')
      const records = log.records.filter(r => r.event !== 'embedding.circuit.probe.settled')
      release.resolve(); await time.advance(0)
      expect(active).toBe(0); expect(probes).toBe(1)
      expect(await readFile(pendingFile, 'utf8')).toBe(pending); expect(await readFile(currentFile, 'utf8')).toBe(current)
      expect(log.records.filter(r => r.event !== 'embedding.circuit.probe.settled')).toEqual(records)
      expect(log.records.find(r => r.event === 'embedding.circuit.probe.settled')!.detail.ignored).toBe(true)
      expect(time.pending()).toBe(0); expect(vi.getTimerCount()).toBe(0)
    } finally {
      controller.abort(new Error('测试结束，取消未完成建库。')); release.resolve()
      await running; await time.advance(0)
    }
  }, 9000)
})

describe('缓存', () => {
  it('锁定身份的缓存命中零请求零探活且对象不重写，重算字节一致', async () => {
    const f = await layeredFixture(), settings = settingsFor(), identity = identityFor(settings), request = fakeService(settings), log = events()
    const client = new OllamaEmbeddingClient(settings, request)
    const [reference] = await embedInputs(f.root, ['相同正文'], settings, client, undefined, 3, identity)
    const object = path.join(f.root, vectorPath(reference!.vector_id)), cache = path.join(f.root, 'state/embeddings.json')
    const before = await readFile(object), metadata = await stat(object), cacheBefore = await readFile(cache)
    request.mockClear()
    const unavailable = fakeService(settings).mockRejectedValue(new Error('缓存命中不得探测服务'))
    await embedInputs(f.root, ['相同正文'], settings, new OllamaEmbeddingClient(settings, unavailable), undefined, 3, identity)
    expect(unavailable).not.toHaveBeenCalled(); expect(log.records).toEqual([])
    expect(await readFile(object)).toEqual(before); expect((await stat(object)).mtimeMs).toBe(metadata.mtimeMs); expect(await readFile(cache)).toEqual(cacheBefore)
    await unlink(cache); await unlink(object)
    await embedInputs(f.root, ['相同正文'], settings, client, undefined, 3, identity)
    expect(await readFile(object)).toEqual(before)
    expect(request.mock.calls.filter(call => String(call[0]).endsWith('/api/embed'))).toHaveLength(1)
  })
})
