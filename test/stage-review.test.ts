import { expect, it, vi } from 'vitest'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { defaultPolicy } from '../src/domain/policy.js'
import { ModelClient } from '../src/llm/client.js'
import { createBuildModelClient, createBuildStageResolver, legacyReviewRoutes } from '../src/host/models.js'
import { stageInputBudgets } from '../src/layered/input-budget.js'
import { reviewExtraction } from '../src/layered/review.js'
import { reviewTopicContent } from '../src/layered/topic-review.js'
import { StagePolicyError } from '../src/domain/stage-policy.js'
import { reviewFixture, point, output } from './quality-fix2-audit-fixture.js'
import { hostExecution, stagePolicy, resolveCandidate } from './stage-policy-fixture.js'

it('两类核对真实入口按独立阶段解析并调用不同候选桩', async () => {
  const registry = emptyRegistry(); registry.modelExecution = hostExecution()
  const resolve = createBuildStageResolver(registry, newLibrary('stage'), { ...defaultPolicy(), buildModels: stagePolicy() }, resolveCandidate)
  const f = reviewFixture(), calls: string[] = [], budgetStages: string[] = []
  f.options.client = {
    info: async (_task, signal, _required, stage) => {
      const selected = await resolve(stage!, signal)
      if (!('plan' in selected)) throw new Error('缺阶段计划')
      return { provider: selected.plan.candidates[0]!.lineId, id: 'terra', name: '离线候选' }
    },
    inputBudget: async (_task, signal, stage) => {
      budgetStages.push(stage!); const selected = await resolve(stage!, signal)
      if (!('plan' in selected)) throw new Error('缺阶段计划')
      return stageInputBudgets(selected.plan, { system: '', input: '' })[0]!.inputLimitBytes
    },
    call: async (_task, system, input, signal, _images, options) => {
      const selected = await resolve(options!.operation!, signal)
      if (!('plan' in selected)) throw new Error('缺阶段计划')
      const admitted = stageInputBudgets(selected.plan, { system, input })
      const candidate = selected.plan.candidates.find(item => item.candidateId === admitted[0]!.candidateId)!
      calls.push(candidate.lineId)
      return JSON.stringify(output(JSON.parse(input)))
    },
  }
  // 故意传入小提取窗口，核对应使用自己的窗口。
  await reviewExtraction(f.extraction, f.source, f.options, 100)
  const result = await reviewTopicContent('T1', '# 结果\n范围：结果提高。\n## 共识\n结果提高。', [point()], f.options)
  expect(result.failure).toBeUndefined()
  expect(calls).toEqual(['review-extract', 'review-topic'])
  expect(budgetStages).toEqual(['extractionReview', 'topicReview'])
})

it('旧宿主装配让两类核对继承 extract 模型和推理参数，登记不双写', async () => {
  const library = newLibrary('stage'); library.models.layeredRoutes.extract = { route: { provider: 'offline', model: 'old-extract' }, reasoningEffort: 'high' }
  const before = structuredClone(library), seen: { model: string; effort: unknown }[] = []
  const runtime = { resolveModelInfo: vi.fn(async (_provider: string, id: string) => ({ provider: 'offline', id, name: id, context: { contextWindow: 100000 }, reasoning: { efforts: [{ id: 'high', name: '高' }] } })),
    stream: async function* (request: any) { seen.push({ model: request.model, effort: request.reasoningEffort }); yield { type: 'text-delta' as const, text: '通过' }; yield { type: 'finish' as const, reason: { kind: 'stop' as const } } } }
  const client = new ModelClient(runtime as any, legacyReviewRoutes(library), { ...defaultPolicy(), batchDelayMs: 0 })
  await client.call('ingest', '核对', '甲', undefined, [], { operation: 'extractionReview' })
  await client.call('ingest', '核对', '乙', undefined, [], { operation: 'topicReview' })
  expect(seen).toEqual([{ model: 'old-extract', effort: 'high' }, { model: 'old-extract', effort: 'high' }])
  expect(library).toEqual(before)
})

it('能力暂停从核对入口向上传递，不能转成拒收或删句', async () => {
  const f = reviewFixture(), pause = new StagePolicyError('NO_COMPATIBLE_CANDIDATE', 'topicReview', 0, 'review-topic/terra', '窗口不足')
  f.call.mockRejectedValue(pause)
  await expect(reviewTopicContent('T1', '# 结果\n结果提高。', [point()], f.options)).rejects.toBe(pause)
  await expect(reviewExtraction(f.extraction, f.source, f.options, 100000)).rejects.toBe(pause)
})

it('新策略延迟解析，未绑定时暂停且禁止误调旧全局模型', async () => {
  const stream = vi.fn(), runtime = { stream, resolveModelInfo: vi.fn() }
  const client = createBuildModelClient(runtime as any, newLibrary('stage'), { ...defaultPolicy(), buildModels: stagePolicy() })
  await expect(client.inputBudget('ingest')).rejects.toThrow('LINE_UNBOUND')
  expect(stream).not.toHaveBeenCalled()
})
