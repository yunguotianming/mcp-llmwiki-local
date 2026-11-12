import { describe, expect, it } from 'vitest'
import type { Candidate } from '../src/ingest/extraction.js'
import { ModelCallError } from '../src/llm/client.js'
import { synthesize } from '../src/wiki/synthesis.js'
import type { SynthesisCheckpoint } from '../src/wiki/synthesis.js'
import { groupingResponse } from './synthesis-fixture.js'

const candidates: Candidate[] = Array.from({ length: 6 }, (_, index) => ({
  id: `candidate-${index}`, type: 'concept', title: '抽样流程', identity: '抽样流程', aliases: [], tags: [],
  claims: [{ id: `claim-${index}`, text: `样本条件${index}`, evidence: { sourceId: `source-${index}`, hash: 'version', chunkId: 'chunk', quote: `原文条件${index}`, cleanStart: 0, originalStart: 0, line: 1 } }],
}))
const timeout = () => new DOMException('模拟请求超时', 'TimeoutError')
function response(system: string,input: string) {
  const data = JSON.parse(input)
  return data.candidates ? groupingResponse(system,[{ type: 'concept', title: '抽样流程', identity: '抽样流程', aliases: [], tags: [], members: data.candidates.map((candidate: Candidate) => candidate.id), conflicts: [] }]) : JSON.stringify({ conflicts: [] })
}

describe('综合超时的有界缩批', () => {
  it('完整综合及身份大组超时后缩小比较，保留所有成员和跨组主张比较', async () => {
    const comparisons = new Set<string>(), checkpoints: SynthesisCheckpoint[] = []
    const groups = await synthesize(candidates, null, 100000, async (_system, input) => {
      const data = JSON.parse(input)
      if (data.candidates?.length > 2) throw timeout()
      if (data.claims) for (const a of data.claims) for (const b of data.claims) if (a.id !== b.id) comparisons.add([a.sourceId, b.sourceId].sort().join(':'))
      return response(_system,input)
    }, checkpoints, async () => {}, new AbortController().signal)
    expect(groups.flatMap(group => group.members).sort()).toEqual(candidates.map(candidate => candidate.id))
    expect(comparisons.size).toBe(15)
    expect(checkpoints.length).toBeGreaterThan(1)
  })
  it('冲突大组超时后缩批，跨组冲突仍被核对且成功检查点可复用', async () => {
    const checkpoints: SynthesisCheckpoint[] = [], successful: string[] = []
    const call = async (_system: string, input: string) => {
      const data = JSON.parse(input)
      if (data.candidates?.some((candidate: Candidate) => candidate.claims.length)) throw timeout()
      if (data.claims?.length > 2) throw timeout()
      successful.push(input)
      if (data.claims?.some((claim: { sourceId: string }) => claim.sourceId === 'source-0') && data.claims.some((claim: { sourceId: string }) => claim.sourceId === 'source-5')) return JSON.stringify({ conflicts: [data.claims.map((claim:{id:string})=>claim.id)] })
      return response(_system,input)
    }
    const first = await synthesize(candidates, null, 100000, call, checkpoints, async () => {}, new AbortController().signal)
    expect(first[0]!.conflicts).toEqual([['claim-0', 'claim-5']])
    const saved = JSON.stringify(checkpoints), successfulCount = successful.length
    const second = await synthesize(candidates, null, 100000, call, checkpoints, async () => {}, new AbortController().signal)
    expect(second).toEqual(first); expect(JSON.stringify(checkpoints)).toBe(saved); expect(successful.length).toBe(successfulCount)
  })
  it('最小两项比较超时停止，不无限重试或缓存失败输出', async () => {
    const checkpoints: SynthesisCheckpoint[] = []; let calls = 0
    await expect(synthesize(candidates.slice(0, 2), null, 100000, async () => { calls++; throw timeout() }, checkpoints, async () => {}, new AbortController().signal)).rejects.toThrow('模拟请求超时')
    expect(calls).toBe(1); expect(checkpoints).toEqual([])
  })
  it('父级取消即使表现为TimeoutError也不缩批或派发后续请求', async () => {
    const abort = new AbortController(), checkpoints: SynthesisCheckpoint[] = []; let calls = 0
    await expect(synthesize(candidates, null, 100000, async () => { calls++; const error = timeout(); abort.abort(error); throw error }, checkpoints, async () => {}, abort.signal)).rejects.toThrow('模拟请求超时')
    expect(calls).toBe(1); expect(checkpoints).toEqual([])
  })
  it('两候选的输出截断仍沿用身份和主张分阶段处理', async () => {
    const groups = await synthesize(candidates.slice(0, 2), null, 100000, async (_system, input) => {
      const data = JSON.parse(input)
      if (data.candidates?.some((candidate: Candidate) => candidate.claims.length)) throw new ModelCallError('模拟输出截断', 'max-tokens')
      return response(_system,input)
    }, [], async () => {}, new AbortController().signal)
    expect(groups[0]!.members).toEqual(['candidate-0', 'candidate-1'])
  })
})
