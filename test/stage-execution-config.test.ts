import { expect, it } from 'vitest'
import { emptyRegistry, parseRegistry } from '../src/domain/config.js'
import { modelExecutionSchema } from '../src/domain/route-schema.js'
import { resolveStagePlan } from '../src/domain/stage-policy.js'
import { hostExecution, stagePolicy, resolveCandidate } from './stage-policy-fixture.js'

it('执行限额与自适应使用一份校验，无设置时不启用自适应', () => {
  const execution = hostExecution()
  expect(modelExecutionSchema.parse(execution).lineBindings.flash!.adaptive).toBeUndefined()
  const invalid = structuredClone(execution); invalid.lineBindings.flash!.minConcurrency = 4
  expect(() => modelExecutionSchema.parse(invalid)).toThrow('min ≤ initial ≤ max')
  invalid.lineBindings.flash!.minConcurrency = 1; invalid.lineBindings.flash!.adaptive = { enabled: true }
  expect(() => modelExecutionSchema.parse(invalid)).toThrow('显式填写')
  const registry = emptyRegistry(); registry.modelExecution = { ...execution, globalMaxInFlight: 0 }
  expect(() => parseRegistry(registry)).toThrow()
  expect(() => modelExecutionSchema.parse({ ...execution, apiKey: '不应保存的测试字段' })).toThrow()
})

it('共享额度组缺失及显式未定义的能力值给出阶段候选错误', async () => {
  const execution = hostExecution(); delete execution.quotaGroups.account
  await expect(resolveStagePlan(stagePolicy(), 'topic', execution, 3, resolveCandidate)).rejects.toMatchObject({ code: 'QUOTA_GROUP_UNKNOWN', stage: 'topic', candidateIndex: 0 })
  await expect(resolveStagePlan(stagePolicy(), 'topic', hostExecution(), 3, async (...args) => ({ ...await resolveCandidate(...args),
    defaults: { reasoningEffort: undefined } }))).rejects.toMatchObject({ code: 'CAPABILITY_UNKNOWN', stage: 'topic' })
})
