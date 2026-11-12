import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { Candidate } from '../src/ingest/extraction.js'
import { newLibrary } from '../src/domain/config.js'
import { defaultPolicy } from '../src/domain/policy.js'
import { ModelCallError, ModelClient } from '../src/llm/client.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { synthesize } from '../src/wiki/synthesis.js'
import type { SynthesisCheckpoint } from '../src/wiki/synthesis.js'
import { selectSourceCandidates } from '../src/wiki/source-selection.js'
import { groupingResponse } from './synthesis-fixture.js'

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const candidates = (count: number, separate = false): Candidate[] => Array.from({ length: count }, (_, index) => ({
  id: `candidate-${index}`, type: 'concept', title: '流程' + (separate ? Math.floor(index / 2) : index % 2), identity: '流程' + (separate ? Math.floor(index / 2) : index % 2), aliases: [], tags: [],
  claims: [{ id: `claim-${index}`, text: '完整条件。'.repeat(40), evidence: { sourceId: `source-${index}`, hash: 'version', chunkId: 'chunk', quote: '完整原文。'.repeat(40), cleanStart: 0, originalStart: 0, line: 1 } }],
}))
function response(system:string,data: { candidates?: Candidate[]; claims?: { id: string;sourceId:string }[] }) {
  if (!data.candidates) {const pair=data.claims?.filter(claim=>['source-0','source-2'].includes(claim.sourceId))??[];return JSON.stringify({ conflicts:pair.length===2?[pair.map(claim=>claim.id)]:[] })}
  const identities = [...new Set(data.candidates.map(candidate => candidate.identity))]
  return groupingResponse(system,identities.map(identity => ({ type: 'concept', title: identity, identity, aliases: [], tags: [], members: data.candidates!.filter(candidate => candidate.identity === identity).map(candidate => candidate.id), conflicts: [] })))
}
const splitLarge = (data: { candidates?: Candidate[]; claims?: unknown[] }) => { if ((data.candidates?.length ?? data.claims?.length ?? 0) > 2) throw new ModelCallError('模拟缩批', 'max-tokens') }

describe('综合独立比较的并行调度', () => {
  it('缩批子项填满50路，逆序完成仍与串行归并一致并复用原检查点', async () => {
    const items = candidates(12), barrier = deferred(), checkpoints: SynthesisCheckpoint[] = []
    let active = 0, peak = 0, successful = 0
    const call = async (_system: string, input: string) => {
      const data = JSON.parse(input); splitLarge(data)
      successful++; peak = Math.max(peak, ++active); if (active === 50) barrier.resolve()
      try { await barrier.promise; await new Promise(resolve => setTimeout(resolve, (data.candidates?.[0]?.id.length ?? 0) % 3)); return response(_system,data) } finally { active-- }
    }
    const parallel = await synthesize(items, null, 5000, call, checkpoints, async () => {}, new AbortController().signal, undefined, 50)
    expect(peak).toBe(50); expect(active).toBe(0)
    const serial = await synthesize(items, null, 5000, async (_system, input) => { const data = JSON.parse(input); splitLarge(data); return response(_system,data) }, [], async () => {}, new AbortController().signal)
    expect(parallel).toEqual(serial)
    const saved = JSON.stringify(checkpoints), count = successful
    expect(await synthesize(items, null, 5000, call, checkpoints, async () => {}, new AbortController().signal, undefined, 1)).toEqual(parallel)
    expect(successful).toBe(count); expect(JSON.stringify(checkpoints)).toBe(saved)
  })
  it('不同知识对象的冲突检查共用50路队列，结果仍按原对象顺序归并', async () => {
    const items = candidates(100, true), barrier = deferred(); let active = 0, peak = 0
    const parallel = await synthesize(items, null, 1000000, async (_system, input) => {
      const data = JSON.parse(input)
      if (data.candidates?.some((candidate: Candidate) => candidate.claims.length)) throw new ModelCallError('分阶段处理', 'max-tokens')
      if (data.claims) {
        peak = Math.max(peak, ++active); if (active === 50) barrier.resolve()
        try { await barrier.promise; return response(_system,data) } finally { active-- }
      }
      return response(_system,data)
    }, [], async () => {}, new AbortController().signal, undefined, 50)
    expect(peak).toBe(50); expect(parallel).toHaveLength(50)
    expect(parallel.flatMap(group => group.members)).toHaveLength(100)
    const serial = await synthesize(items, null, 1000000, async (_system, input) => {
      const data = JSON.parse(input)
      if (data.candidates?.some((candidate: Candidate) => candidate.claims.length)) throw new ModelCallError('分阶段处理', 'max-tokens')
      return response(_system,data)
    }, [], async () => {}, new AbortController().signal)
    expect(parallel).toEqual(serial)
  })
  it('分支失败会取消兄弟调用并等待清理，保留已成功的综合检查点', async () => {
    const entered = deferred(), cleanup = deferred(), checkpoints: SynthesisCheckpoint[] = []; let small = 0, settled = false
    const pending = synthesize(candidates(8), null, 5000, async (_system, input, signal) => {
      const data = JSON.parse(input); splitLarge(data)
      const index = ++small
      if (index === 2) { await entered.promise; throw new Error('模拟综合失败') }
      if (index === 3) {
        entered.resolve(); await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true })); await cleanup.promise; signal!.throwIfAborted()
      }
      return response(_system,data)
    }, checkpoints, async () => {}, new AbortController().signal, undefined, 3).catch(error => { settled = true; return error })
    await entered.promise; await new Promise(resolve => setTimeout(resolve, 5)); expect(settled).toBe(false)
    cleanup.resolve(); expect((await pending).message).toBe('模拟综合失败')
    expect(checkpoints.length).toBeGreaterThan(0)
  })
  it('用户取消传播到比较调用，等待清理后退出且不再派发后续比较', async () => {
    const abort = new AbortController(), entered = deferred(), cleanup = deferred(); let calls = 0, active = 0, settled = false
    const pending = synthesize(candidates(8), null, 5000, async (_system, input, signal) => {
      const data = JSON.parse(input); splitLarge(data); calls++; active++; if (active === 3) entered.resolve()
      await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true })); await cleanup.promise; active--; signal!.throwIfAborted(); return ''
    }, [], async () => {}, abort.signal, undefined, 3).catch(error => { settled = true; return error })
    await entered.promise; abort.abort(new Error('用户停止')); const before = calls
    await new Promise(resolve => setTimeout(resolve, 5)); expect(settled).toBe(false)
    cleanup.resolve(); expect((await pending).message).toBe('用户停止'); expect(calls).toBe(before); expect(active).toBe(0)
  })
  it('普通ModelRuntime的筛选和综合共享设置额度，合计不超过模型总槽位', async () => {
    const policy = defaultPolicy(); policy.batchDelayMs = 0; policy.pageGenerationConcurrency = 3
    const library = newLibrary('generic-runtime'); library.models.unified = { provider: 'ordinary-provider', model: 'ordinary-model' }
    const barrier = deferred(); let active = 0, peak = 0
    const runtime: ModelRuntime = { async resolveModelInfo(provider, id) { return { provider, id, name: id } }, async *stream(options): AsyncIterable<StreamChunk> {
      expect(options.provider).toBe('ordinary-provider')
      const data = JSON.parse((options.messages[0]!.content[0] as { text: string }).text)
      peak = Math.max(peak, ++active); if (active === 3) barrier.resolve()
      try {
        await barrier.promise
        const output = data.limits ? JSON.stringify({ ids: data.candidates.slice(-data.limits.total).map((candidate: Candidate) => candidate.id) }) : response(options.system??'',data)
        yield { type: 'text-delta', index: 0, text: output }; yield { type: 'finish', reason: { kind: 'stop' } }
      } finally { active-- }
    } }
    const client = new ModelClient(runtime, library, policy), abort = new AbortController()
    const call = (system: string, input: string, signal = abort.signal) => client.call('ingest', system, input, signal)
    const selection = candidates(60).map((candidate, index) => ({ ...candidate, title: '独立主题' + index, identity: '独立主题' + index, claims: candidate.claims.map(claim => ({ ...claim, text: '文'.repeat(800) })) }))
    await Promise.all([
      selectSourceCandidates(selection, '来源.md', policy, 36000, call, [], async () => {}, abort.signal),
      synthesize(candidates(2), null, 36000, call, [], async () => {}, abort.signal, undefined, 50),
    ])
    expect(peak).toBe(3); expect(active).toBe(0)
  })
})
