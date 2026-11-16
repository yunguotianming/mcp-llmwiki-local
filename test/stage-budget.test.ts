import { expect, it } from 'vitest'
import { resolveStagePlan } from '../src/domain/stage-policy.js'
import { candidateInputBudget, stageInputBudgets, stageInputEstimationMethod } from '../src/layered/input-budget.js'
import { jsonProtocol } from '../src/llm/protocol.js'
import { hostExecution, stagePolicy, resolveCandidate } from './stage-policy-fixture.js'
const plan = () => resolveStagePlan(stagePolicy(), 'extract', hostExecution(), 3, resolveCandidate)

it('阶段预算计入完整 UTF-8 提示、协议和输入，输出字段符合契约', async () => {
  const p = await plan(), schema = { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false }
  const request = { system: '系统规则', input: '原文证据', structuredSchema: schema }
  const result = candidateInputBudget('extract', p.candidates[0]!, request)
  expect(result).toEqual({ candidateId: p.candidates[0]!.candidateId, inputLimitBytes: 131072 - 4096,
    estimatedInputTokens: Buffer.byteLength(jsonProtocol(request.system, schema) + request.input), maxOutputTokens: 4096, capabilityRevision: p.candidates[0]!.capabilityRevision })
  expect(stageInputEstimationMethod).toContain('utf8-byte-upper-bound')
  expect(candidateInputBudget('topicReview', p.candidates[0]!, request).inputLimitBytes).toBe(131072 - 4096 - Math.ceil(131072 * .1))
})

it('较小候选只在完整输入装下时准入，无兼容候选明确暂停', async () => {
  const p = await plan(); p.candidates[0]!.capabilities.contextWindowTokens = 5000
  const input = { system: '', input: '证据'.repeat(200) }
  expect(stageInputBudgets(p, input).map(item => item.candidateId)).toEqual([p.candidates[1]!.candidateId])
  p.candidates[1]!.capabilities.contextWindowTokens = 5000
  expect(() => stageInputBudgets(p, input)).toThrow(/NO_COMPATIBLE_CANDIDATE.*extract.*flash\/flash.*terra\/terra/)
  try { stageInputBudgets(p, input) } catch (error) { expect(error).toMatchObject({ stagePause: true, causes: [{ code: 'CONTEXT_LIMIT' }, { code: 'CONTEXT_LIMIT' }] }) }
})

it('图片能力和图片 token 成本分别核对，不能只按图片字节估算', async () => {
  const p = await plan(), c = p.candidates[0]!, request = { system: '', input: '证据', imageCount: 1, imageTokens: 1000 }
  expect(() => candidateInputBudget('extractionReview', c, request)).toThrow(/extractionReview.*flash\/flash.*图片/)
  c.capabilities.inputModalities.push('image')
  const result = candidateInputBudget('extract', c, request)
  expect(result.estimatedInputTokens).toBe(1006)
  expect(result.inputLimitBytes).toBe(131072 - 4096 - 1000)
  expect(() => candidateInputBudget('extract', c, { ...request, imageTokens: 0 })).toThrow('图片输入缺少')
})

it('输出硬上限、未知窗口及本地输入限制在派发前拒绝', async () => {
  const p = await plan(), c = p.candidates[0]!, request = { system: '', input: '正文' }
  c.parameters.maxOutputTokens = 40000
  expect(() => candidateInputBudget('topic', c, request)).toThrow(/OUTPUT_LIMIT.*topic.*flash\/flash/)
  c.parameters.maxOutputTokens = 4096; c.capabilities.contextWindowTokens = 0
  expect(() => candidateInputBudget('parent', c, request)).toThrow('CAPABILITY_UNKNOWN')
  c.capabilities.contextWindowTokens = 131072
  expect(() => candidateInputBudget('term', c, request, 0, 5)).toThrow('CONTEXT_LIMIT')
})
