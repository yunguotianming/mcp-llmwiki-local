import { describe, expect, it } from 'vitest'
import type { Candidate } from '../src/ingest/extraction.js'
import { ModelCallError } from '../src/llm/client.js'
import { synthesize } from '../src/wiki/synthesis.js'
import type { SynthesisCheckpoint } from '../src/wiki/synthesis.js'
import { GROUP_PROMPT } from '../src/wiki/synthesis.js'
import { signature } from '../src/storage/files.js'
import { groupingResponse } from './synthesis-fixture.js'

const items: Candidate[] = Array.from({ length: 2 }, (_, index) => ({
  id: String(index).padStart(64, 'a'), type: 'concept', title: '主题' + index, identity: '主题' + index, aliases: [], tags: [],
  claims: [{ id: String(index).padStart(64, 'b'), text: '完整主张', evidence: { sourceId: '原始来源' + index, hash: '版本', chunkId: '段落', quote: '连续原文', cleanStart: 0, originalStart: 0, line: 1 } }],
}))
const group = (members: string[], conflicts: string[][] = []) => ({ type: 'concept', title: '主题', identity: '主题', aliases: [], tags: [], members, conflicts })
const signal = () => new AbortController().signal

describe('综合首次与纠正的短编号严格回填', () => {
  it('最小身份比较漏抄编号末尾时，纠正只用短编号并保存原候选身份', async () => {
    const checkpoints: SynthesisCheckpoint[] = []; let corrections = 0
    const result = await synthesize(items, null, 36000, async (_system, input) => {
      const data = JSON.parse(input)
      if (data.candidates.some((item: Candidate) => item.claims.length)) throw new ModelCallError('转分阶段', 'max-tokens')
      if (!data.validationFeedback) return JSON.stringify({ groups:[],singletons:data.candidates.map((item: Candidate, index: number) => index ? item.id.slice(0, -1) : item.id) })
      corrections++; expect(data.candidates.map((item: Candidate) => item.id)).toEqual(['candidate-ref-1', 'candidate-ref-2'])
      return groupingResponse(_system,data.candidates.map((item: Candidate) => group([item.id])))
    }, checkpoints, async () => {}, signal(), 'zh', 50)
    expect(corrections).toBe(1); expect(result.flatMap(value => value.members)).toEqual(items.map(item => item.id))
    expect(checkpoints.every(value => !value.output.includes('candidate-ref-'))).toBe(true)
  })
  it('完整综合分别映射候选和主张，冲突回填后仍保留原引文及来源', async () => {
    const checkpoints: SynthesisCheckpoint[] = [], original = JSON.stringify(items)
    const result = await synthesize(items, null, 36000, async (_system, input) => {
      const data = JSON.parse(input)
      if (!data.validationFeedback) return JSON.stringify({ groups: [group(['unknown'])] })
      expect(data.candidates[0].claims[0].evidence).toEqual(items[0]!.claims[0]!.evidence)
      expect(data.candidates.map((item: Candidate) => item.claims[0]!.id)).toEqual(['claim-ref-1', 'claim-ref-2'])
      return JSON.stringify({ groups: [group(data.candidates.map((item: Candidate) => item.id), [data.candidates.map((item: Candidate) => item.claims[0]!.id)])] })
    }, checkpoints, async () => {}, signal())
    expect(result[0]!.members).toEqual(items.map(item => item.id)); expect(result[0]!.conflicts).toEqual([items.map(item => item.claims[0]!.id)])
    expect(JSON.stringify(items)).toBe(original); expect(checkpoints[0]!.output).not.toContain('-ref-')
  })
  it('分阶段冲突纠正映射回完整主张ID，新检查点可直接接续', async () => {
    const checkpoints: SynthesisCheckpoint[] = []
    const run = () => synthesize(items, null, 36000, async (_system, input) => {
      const data = JSON.parse(input)
      if (data.candidates?.some((item: Candidate) => item.claims.length)) throw new ModelCallError('转分阶段', 'max-tokens')
      if (data.candidates) return groupingResponse(_system,[group(data.candidates.map((item: Candidate) => item.id))])
      if (!data.validationFeedback) return JSON.stringify({ conflicts: [['unknown', data.claims[1].id]] })
      expect(data.claims.map((claim: { id: string }) => claim.id)).toEqual(['claim-ref-1', 'claim-ref-2'])
      return JSON.stringify({ conflicts: [data.claims.map((claim: { id: string }) => claim.id)] })
    }, checkpoints, async () => {}, signal())
    const result = await run(), saved = JSON.stringify(checkpoints)
    expect(result[0]!.conflicts).toEqual([items.map(item => item.claims[0]!.id)])
    expect(await run()).toEqual(result); expect(JSON.stringify(checkpoints)).toBe(saved)
  })
  it('纠正仍返回原长ID时拒绝，不猜测编号或缓存失败输出', async () => {
    const checkpoints: SynthesisCheckpoint[] = []; let calls = 0
    await expect(synthesize(items, null, 36000, async () => {
      calls++; return JSON.stringify({ groups: [group([items[0]!.id.slice(0, -1)])] })
    }, checkpoints, async () => {}, signal())).rejects.toThrow('未知候选或主张编号')
    expect(calls).toBe(2); expect(checkpoints).toEqual([])
  })
  it('旧版已验证的长ID检查点保持原字节，不请求或重写模型结果', async () => {
    const expected=[group(items.map(item=>item.id))]
    const checkpoints: SynthesisCheckpoint[] = [{key:signature(GROUP_PROMPT+'\n'+JSON.stringify({schema:null,candidates:items})),output:JSON.stringify({groups:expected})}]
    const saved = JSON.stringify(checkpoints)
    expect(await synthesize(items, null, 36000, async () => { throw new Error('不应调用模型') }, checkpoints, async () => {}, signal())).toEqual(expected)
    expect(JSON.stringify(checkpoints)).toBe(saved)
  })
})
