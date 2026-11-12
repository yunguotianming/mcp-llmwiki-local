import { describe, expect, it } from 'vitest'
import type { Candidate } from '../src/ingest/extraction.js'
import { defaultPolicy } from '../src/domain/policy.js'
import { selectSourceCandidates } from '../src/wiki/source-selection.js'
import type { SynthesisCheckpoint } from '../src/wiki/synthesis.js'
import { signature } from '../src/storage/files.js'

const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const candidates = (count: number): Candidate[] => Array.from({ length: count }, (_, index) => ({
  id: `candidate-${index}`, type: 'concept', title: '主题' + index, identity: '主题' + index, aliases: [], tags: [],
  claims: [{ id: `claim-${index}`, text: '文'.repeat(800), evidence: { sourceId: 'source', hash: 'version', chunkId: 'chunk', quote: '原文' + index, cleanStart: index, originalStart: index, line: index + 1 } }],
}))
const response = (input: string) => { const data = JSON.parse(input); return JSON.stringify({ ids: data.candidates.slice(-data.limits.total).map((candidate: Candidate) => candidate.id) }) }

describe('长文整篇筛选分组的并行调度', () => {
  it('独立分组填满设置的50路，完成顺序变化仍与串行一致并保留完整证据及缓存', async () => {
    const items = candidates(720), policy = defaultPolicy(), barrier = deferred(), checkpoints: SynthesisCheckpoint[] = []
    policy.pageGenerationConcurrency = 50
    let active = 0, peak = 0, calls = 0
    const call = async (_system: string, input: string) => {
      calls++; peak = Math.max(peak, ++active); if (active === 50) barrier.resolve()
      try { await barrier.promise; await new Promise(resolve => setTimeout(resolve, JSON.parse(input).candidates[0].id.length % 3)); return response(input) } finally { active-- }
    }
    const parallel = await selectSourceCandidates(items, '长文.md', policy, 36000, call, checkpoints, async () => {}, new AbortController().signal)
    expect(peak).toBe(50); expect(parallel.length).toBeLessThanOrEqual(50)
    const serial = await selectSourceCandidates(items, '长文.md', { ...policy, pageGenerationConcurrency: 1 }, 36000, async (_system, input) => response(input), [], async () => {}, new AbortController().signal)
    expect(parallel).toEqual(serial)
    for (const item of parallel) expect(item.claims).toEqual(items.find(original => original.id === item.id)!.claims)
    const saved = JSON.stringify(checkpoints), before = calls
    expect(await selectSourceCandidates(items, '长文.md', policy, 36000, call, checkpoints, async () => {}, new AbortController().signal)).toEqual(parallel)
    expect(calls).toBe(before); expect(JSON.stringify(checkpoints)).toBe(saved)
  })
  it('分组失败取消在途兄弟并等待清理，接续跳过成功分组', async () => {
    const items = candidates(60), policy = defaultPolicy(), entered = deferred(), cleanup = deferred(), checkpoints: SynthesisCheckpoint[] = []
    policy.pageGenerationConcurrency = 3
    let calls = 0, settled = false
    const inputs = new Map<string, string>()
    const pending = selectSourceCandidates(items, '长文.md', policy, 36000, async (system, input, signal) => {
      inputs.set(signature(system + '\n' + input), input)
      const index = ++calls
      if (index === 2) { await entered.promise; throw new Error('模拟分组失败') }
      if (index === 3) { entered.resolve(); await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true })); await cleanup.promise; signal!.throwIfAborted() }
      return response(input)
    }, checkpoints, async () => {}, new AbortController().signal).catch(error => { settled = true; return error })
    await entered.promise; await new Promise(resolve => setTimeout(resolve, 5)); expect(settled).toBe(false)
    cleanup.resolve(); expect((await pending).message).toBe('模拟分组失败'); expect(checkpoints.length).toBeGreaterThan(0)
    const saved = checkpoints.map(item => ({ ...item }))
    // 只有通过验证并保存的响应才能复用；取消时尚未保存的响应允许重新请求。
    const successful = new Set(saved.map(item => inputs.get(item.key)))
    const result = await selectSourceCandidates(items, '长文.md', policy, 36000, async (_system, input) => { expect(successful.has(input)).toBe(false); return response(input) }, checkpoints, async () => {}, new AbortController().signal)
    expect(result.length).toBeLessThanOrEqual(50)
    for (const old of saved) expect(checkpoints.find(item => item.key === old.key)).toEqual(old)
  })
  it('用户取消传播到所有分组，清理结束前不提前返回且停止派发', async () => {
    const policy = defaultPolicy(), entered = deferred(), cleanup = deferred(), abort = new AbortController(), checkpoints: SynthesisCheckpoint[] = []
    policy.pageGenerationConcurrency = 3
    let calls = 0, active = 0, settled = false
    const pending = selectSourceCandidates(candidates(60), '长文.md', policy, 36000, async (_system, _input, signal) => {
      calls++; active++; if (active === 3) entered.resolve()
      await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true })); await cleanup.promise; active--; signal!.throwIfAborted(); return ''
    }, checkpoints, async () => {}, abort.signal).catch(error => { settled = true; return error })
    await entered.promise; abort.abort(new Error('用户停止')); const before = calls
    await new Promise(resolve => setTimeout(resolve, 5)); expect(settled).toBe(false)
    cleanup.resolve(); expect((await pending).message).toBe('用户停止'); expect(calls).toBe(before); expect(active).toBe(0); expect(checkpoints).toEqual([])
  })
})
