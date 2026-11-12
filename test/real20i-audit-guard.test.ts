import { afterEach, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { costReport, meteredOptions } from '../src/layered/costs.js'
import { layeredSettings } from '../src/domain/config.js'
import type { PendingBuild } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, layeredFixture } from './layered-fixture.js'
import { reviewExtraction } from '../src/layered/review.js'
import { point, reviewFixture } from './quality-fix2-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it.each([['提取', 9, 20], ['主题', 11, 22]] as const)('G-%s：默认阈值边界及阶段隔离，拒绝调用前保留断点', async (phase, initial, cap) => {
  const f = await layeredFixture(), costs = costReport(), pending = { started_at: costs.started_at, costs } as PendingBuild
  Object.assign(costs.stages[phase]!, { initial_calls: initial, actual_calls: initial + cap - 1, corrections: cap - 1 })
  f.call.mockResolvedValue('{}')
  const client = meteredOptions(f.root, pending, f.options).client
  const correction = phase === '提取' ? { source_id: 'S1', correction_stage: 'structure', items: [] } : { topic_id: 'T1', validationFeedback: {} }
  await client.call('ingest', '', JSON.stringify(correction))
  await expect(client.call('ingest', '', JSON.stringify(correction))).rejects.toMatchObject({ budgetPause: true })
  const other = phase === '提取' ? { topic_id: 'T2', validationFeedback: {} } : { source_id: 'S2', correction_stage: 'structure', items: [] }
  await client.call('ingest', '', JSON.stringify(other))
  expect(f.call).toHaveBeenCalledTimes(2)
  const saved = JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8'))
  expect(saved.paused.reason).toBe('budget')
  expect(saved.costs.correction_rates[phase].corrections).toBe(cap)
  // 调高配置后续做使用既有首轮与纠正计数，不重置历史成本。
  f.options.topics = { extractionCorrectionRatio: 3, topicCorrectionRatio: 3 }
  await meteredOptions(f.root, pending, f.options).client.call('ingest', '', JSON.stringify(correction))
  expect(costs.correction_rates![phase]!.corrections).toBe(cap + 1)
})

it('G3：非法阈值拒绝，合法分阶段配置独立保留', () => {
  for (const config of [{ extractionCorrectionRatio: 0 }, { topicCorrectionRatio: -1 }, { extractionCorrectionRatio: Infinity }, { correctionMinCalls: 0 }, { correctionMinCalls: 1.5 }]) expect(() => layeredSettings(config)).toThrow()
  expect(layeredSettings({ extractionCorrectionRatio: 3, topicCorrectionRatio: 4, correctionMinCalls: 5 })).toMatchObject({ extractionCorrectionRatio: 3, topicCorrectionRatio: 4, correctionMinCalls: 5 })
})

it('G4：同篇一个核对包触发护栏应取消另一在途包', async () => {
  const f = reviewFixture([point('甲'.repeat(2500)), point('乙'.repeat(2500), '方法', 'P2')])
  f.options.client.concurrency = () => 2
  const gate = Promise.withResolvers<void>(), started = Promise.withResolvers<void>(), failed = Promise.withResolvers<void>()
  let inflight: AbortSignal | undefined, calls = 0
  f.call.mockImplementation(async (...args: any[]) => {
    if (++calls === 1) {
      inflight = args[3]; started.resolve()
      await gate.promise
      return JSON.stringify({ items: JSON.parse(args[2]).points.map((p: any) => ({ id: p.id, support: '完整支撑', missing: null })) })
    }
    failed.resolve()
    throw Object.assign(new Error('提取阶段护栏'), { budgetPause: true })
  })
  const run = reviewExtraction(f.extraction, f.source, f.options, 15000).catch(error => error)
  await started.promise; await failed.promise
  await new Promise(resolve => setTimeout(resolve, 0))
  const cancelled = inflight?.aborted
  gate.resolve()
  expect(await run).toMatchObject({ budgetPause: true })
  expect(cancelled).toBe(true)
})
