import { describe, expect, it } from 'vitest'
import type { Candidate } from '../src/ingest/extraction.js'
import { ModelCallError } from '../src/llm/client.js'
import { synthesize } from '../src/wiki/synthesis.js'
import type { SynthesisCheckpoint } from '../src/wiki/synthesis.js'
import { groupingResponse } from './synthesis-fixture.js'

const candidates: Candidate[] = Array.from({ length: 6 }, (_, index) => ({
  id: `candidate-${index}`, type: 'concept', title: '抽样流程', identity: '抽样流程', aliases: [], tags: [],
  claims: [{ id: `claim-${index}`, text: '完整条件。'.repeat(50), evidence: { sourceId: `source-${index}`, hash: 'version', chunkId: 'chunk', quote: '完整原文。'.repeat(50), cleanStart: 0, originalStart: 0, line: 1 } }],
}))
const group = (members: string[]) => ({ type: 'concept', title: '抽样流程', identity: '抽样流程', aliases: [], tags: [], members, conflicts: [] })
const oversized = JSON.stringify({ groups: [group(Array(5000).fill('unknown-candidate'))] })
const valid = (system:string,data: { candidates?: Candidate[] }) => data.candidates ? groupingResponse(system,[group(data.candidates.map(candidate => candidate.id))]) : JSON.stringify({ conflicts: [] })

describe('综合纠正反馈预算', () => {
  it('完整综合的无效输出令纠正超预算时转入分级综合，候选不丢失', async () => {
    const checkpoints: SynthesisCheckpoint[] = []; let oversizedCalls = 0
    const groups = await synthesize(candidates, null, 20000, async (_system, input) => {
      expect(Buffer.byteLength(input)).toBeLessThanOrEqual(20000)
      const data = JSON.parse(input); expect(data.validationFeedback).toBeUndefined()
      if (data.candidates?.some((candidate: Candidate) => candidate.claims.length)) { oversizedCalls++; return oversized }
      return valid(_system,data)
    }, checkpoints, async () => {}, new AbortController().signal)
    expect(groups.flatMap(item => item.members).sort()).toEqual(candidates.map(candidate => candidate.id))
    expect(oversizedCalls).toBe(1); expect(checkpoints.every(item => item.output !== oversized)).toBe(true)
  })
  it('身份比较纠正超预算时缩小分组，保留跨组成员和全部主张比较', async () => {
    const compared = new Set<string>(), checkpoints: SynthesisCheckpoint[] = []
    const groups = await synthesize(candidates, null, 5000, async (_system, input) => {
      expect(Buffer.byteLength(input)).toBeLessThanOrEqual(5000)
      const data = JSON.parse(input)
      if (data.candidates?.length > 2) return oversized
      if (data.claims) for (const a of data.claims) for (const b of data.claims) if (a.id !== b.id) compared.add([a.sourceId, b.sourceId].sort().join(':'))
      return valid(_system,data)
    }, checkpoints, async () => {}, new AbortController().signal)
    expect(groups.flatMap(item => item.members).sort()).toEqual(candidates.map(candidate => candidate.id))
    expect(compared.size).toBe(15); expect(checkpoints.every(item => item.output !== oversized)).toBe(true)
  })
  it('冲突比较纠正超预算也缩批，跨组冲突和全部原始证据保留', async () => {
    const bad = JSON.stringify({ conflicts: [Array(5000).fill('unknown-claim')] }), checkpoints: SynthesisCheckpoint[] = []
    const groups = await synthesize(candidates, null, 20000, async (_system, input) => {
      const data = JSON.parse(input)
      if (data.candidates?.some((candidate: Candidate) => candidate.claims.length)) throw new ModelCallError('模拟截断', 'max-tokens')
      if (data.claims?.length > 2) return bad
      if (data.claims?.some((claim: { sourceId: string }) => claim.sourceId === 'source-0') && data.claims.some((claim: { sourceId: string }) => claim.sourceId === 'source-5')) return JSON.stringify({ conflicts: [data.claims.map((claim:{id:string})=>claim.id)] })
      return valid(_system,data)
    }, checkpoints, async () => {}, new AbortController().signal)
    expect(groups[0]!.conflicts).toEqual([['claim-0', 'claim-5']])
    expect(groups[0]!.members).toHaveLength(6); expect(checkpoints.every(item => item.output !== bad)).toBe(true)
  })
  it('最小组纠正仍超预算时明确停止，不缓存无效输出或无限重试', async () => {
    const checkpoints: SynthesisCheckpoint[] = []; let calls = 0
    await expect(synthesize(candidates.slice(0, 2), null, 20000, async () => { calls++; return oversized }, checkpoints, async () => {}, new AbortController().signal)).rejects.toThrow('综合纠正输入超出模型预算')
    expect(calls).toBe(2); expect(checkpoints).toEqual([])
  })
  it('父级取消后不发送纠正或转入缩批', async () => {
    const abort = new AbortController(), checkpoints: SynthesisCheckpoint[] = []; let calls = 0
    await expect(synthesize(candidates, null, 20000, async () => { calls++; abort.abort(new Error('用户停止')); return oversized }, checkpoints, async () => {}, abort.signal)).rejects.toThrow('用户停止')
    expect(calls).toBe(1); expect(checkpoints).toEqual([])
  })
})
