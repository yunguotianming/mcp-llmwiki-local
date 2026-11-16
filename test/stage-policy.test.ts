import { expect, it, vi } from 'vitest'
import { buildModelsSchema } from '../src/domain/route-schema.js'
import { defaultPolicy, processingPolicy, validatePolicy } from '../src/domain/policy.js'
import { policySchema } from '../src/domain/policy-schema.js'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { buildStageSelection, canonicalJson, resolveStagePlan } from '../src/domain/stage-policy.js'
import { createBuildStageResolver } from '../src/host/models.js'
import { hostExecution, stagePolicy, candidateModel, resolveCandidate } from './stage-policy-fixture.js'

it('七阶段完整显式登记，拒绝重复线路、未知字段和无效参数', () => {
  expect(buildModelsSchema.parse(stagePolicy())).toEqual(stagePolicy())
  const missing: any = stagePolicy(); delete missing.stages.topicReview
  expect(() => buildModelsSchema.parse(missing)).toThrow('topicReview')
  const duplicate = stagePolicy(); duplicate.stages.extract.candidates.push(duplicate.stages.extract.candidates[0]!)
  expect(() => buildModelsSchema.parse(duplicate)).toThrow('同阶段')
  expect(() => buildModelsSchema.parse({ ...stagePolicy(), retry: { maxAttempts: 1, maxAttemptsPerLine: 2, deadlineMs: 1 } })).toThrow()
  expect(() => buildModelsSchema.parse({ ...stagePolicy(), fallback: 'flash' })).toThrow()
  const bad = stagePolicy(); bad.stages.topic.candidates[0]!.parameters!.maxOutputTokens = 0
  expect(validatePolicy({ ...defaultPolicy(), buildModels: bad }).join()).toContain('topic.candidates.0')
})

it('旧策略读取不补写，新策略独占候选，查询视觉仍保留原配置', () => {
  const old = defaultPolicy(), library = newLibrary('stage')
  library.models.fallbacks = [{ provider: 'old', model: 'fallback' }]
  library.models.layeredRoutes.extract = { route: { provider: 'old', model: 'extract' }, reasoningEffort: 'high' }
  expect(policySchema.parse(old)).toEqual(old)
  expect(buildStageSelection(library, old, 'topicReview')).toMatchObject({ source: 'models', routes: [{ provider: 'old', model: 'extract' }, { provider: 'old', model: 'fallback' }], reasoningEffort: 'high' })
  const next = { ...old, libraryFormat: '0.3.0' as const, buildModels: stagePolicy() }, before = structuredClone(library)
  expect(buildStageSelection(library, next, 'extractionReview')).toMatchObject({ source: 'policy.buildModels', selection: { candidates: [{ line: 'review-extract' }] } })
  expect(library).toEqual(before)
  expect(processingPolicy(next)).toEqual(processingPolicy(old))
  expect(() => policySchema.parse({ ...old, libraryFormat: 'broken' })).toThrow()
})

it('未绑定、缺能力和不支持参数定位到候选，未验收模型按 D-61 准入', async () => {
  const policy = stagePolicy(), host = hostExecution(); delete host.lineBindings['review-topic']
  await expect(resolveStagePlan(policy, 'topicReview', host, 3, resolveCandidate)).rejects.toMatchObject({ code: 'LINE_UNBOUND', stage: 'topicReview', candidateIndex: 0 })
  await expect(resolveStagePlan(policy, 'topicReview', hostExecution(), 3, async () => ({ ...candidateModel(), capabilities: {} as any }))).rejects.toThrow(/topicReview.*review-topic\/terra/)
  const unverified = stagePolicy(); unverified.stages.topicReview.candidates = [{ line: 'flash', model: 'flash' }]
  const admitted = await resolveStagePlan(unverified, 'topicReview', hostExecution(), 3, resolveCandidate)
  expect(admitted.candidates).toHaveLength(1)
  expect(admitted.candidates[0]).toMatchObject({ requestedModel: 'flash', qualityEvidence: [] })
  expect(await resolveStagePlan(unverified, 'topicReview', hostExecution(), 3, resolveCandidate, { evaluationOnly: true })).toEqual(admitted)
  const bad = stagePolicy(); bad.stages.topic.candidates[0]!.parameters!.maxOutputTokens = 40000
  await expect(resolveStagePlan(bad, 'topic', hostExecution(), 3, resolveCandidate)).rejects.toMatchObject({ code: 'OUTPUT_LIMIT', stage: 'topic' })
  bad.stages.topic.candidates[0]!.parameters = { temperature: 3 }
  await expect(resolveStagePlan(bad, 'topic', hostExecution(), 3, resolveCandidate)).rejects.toMatchObject({ code: 'PARAMETER_UNSUPPORTED' })
})

it('候选和绑定身份排除限额，执行快照包含限额且隔离后续修改', async () => {
  const registry = emptyRegistry(); registry.modelExecution = hostExecution()
  const library = newLibrary('stage'), policy = { ...defaultPolicy(), buildModels: stagePolicy() }, resolve = vi.fn(resolveCandidate)
  const fixed = createBuildStageResolver(registry, library, policy, resolve)
  expect(resolve).not.toHaveBeenCalled()
  registry.modelExecution.globalMaxInFlight = 20
  const old = await fixed('topicReview'); expect(old.source).toBe('policy.buildModels')
  if (!('plan' in old)) throw new Error('应解析阶段计划')
  const next = await resolveStagePlan(policy.buildModels, 'topicReview', registry.modelExecution, 3, resolveCandidate)
  expect(next.executionRevision).not.toBe(old.plan.executionRevision)
  expect(next.candidates[0]!.candidateId).toBe(old.plan.candidates[0]!.candidateId)
  expect(next.candidates[0]!.bindingRevision).toBe(old.plan.candidates[0]!.bindingRevision)
  const changed = await resolveStagePlan(policy.buildModels, 'topicReview', registry.modelExecution, 3, async () => ({ ...candidateModel(), defaultsRevision: 'v2' }))
  expect(changed.candidates[0]!.capabilityRevision).not.toBe(next.candidates[0]!.capabilityRevision)
  expect(canonicalJson({ b: 1, a: [2, 1] })).toBe('{"a":[2,1],"b":1}')
  expect(() => canonicalJson({ bad: undefined })).toThrow()
})

it('未暴露参数明确标运行时默认，验收记录不能借用其他参数组合', async () => {
  const policy = stagePolicy(); policy.stages.extract.candidates = [{ line: 'flash', model: 'flash' }]
  const model = candidateModel('flash'); model.defaults = {}; model.qualityEvidence = [{ stage: 'extract', model: 'flash',
    parameters: { reasoningEffort: 'runtime-default', temperature: 'runtime-default', maxOutputTokens: 'runtime-default' }, reference: '隔离验收' }]
  const plan = await resolveStagePlan(policy, 'extract', hostExecution(), 3, async () => model)
  expect(Object.values(plan.candidates[0]!.parameters)).toEqual(['runtime-default', 'runtime-default', 'runtime-default'])
  model.qualityEvidence[0]!.parameters.maxOutputTokens = 100
  const unverified = await resolveStagePlan(policy, 'extract', hostExecution(), 3, async () => model)
  expect(unverified.candidates[0]!.qualityEvidence).toEqual([])
  expect(unverified.candidates[0]!.parameters).toEqual(plan.candidates[0]!.parameters)
})
