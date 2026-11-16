import { expect, it, vi } from 'vitest'
import { extractionProcessing, extractionPromptHash, processingFingerprint, reusableExtractionPlan, sameProcessing } from '../src/layered/extraction.js'
import { customBook, customBookFixture, legacyCustom } from './extraction-custom-book-fixture.js'

vi.mock('../src/layered/files.js', async original => ({ ...await original<typeof import('../src/layered/files.js')>(), writeJson: async () => {}, appendLog: async () => {} }))

it('仅自定义整篇身份升级，已知旧协议成功组仍兼容，普通档身份不变', () => {
  const requested = { tier: 50, granularity: 'custom' as const, prompt_version: '测试' }, legacy = { ...requested, prompt_hash: extractionPromptHash() }
  const current = extractionProcessing(requested), ordinary = extractionProcessing({ ...requested, granularity: 'standard' })
  expect(current.prompt_hash).not.toBe(legacy.prompt_hash)
  expect(processingFingerprint(current)).not.toBe(processingFingerprint(legacy))
  expect(sameProcessing(legacy, current)).toBe(true)
  expect(sameProcessing({ ...legacy, prompt_hash: '未知旧协议' }, current)).toBe(false)
  expect(ordinary.prompt_hash).toBe(extractionPromptHash())
})

it('旧自定义书计划本就满足上限时复用计划和全部成功组', async () => {
  const source = customBook(700), first = customBookFixture(), previous = legacyCustom(await first.run(source), extractionPromptHash())
  const next = customBookFixture()
  expect(reusableExtractionPlan(previous, 'S-0001', source, next.processing, next.options, 6500)).toEqual(previous.chunk_plan)
  const result = await next.run(source, previous)
  expect(next.extracts()).toHaveLength(0)
  expect(result.point_limit).toBe(50)
  expect(result.segments.flatMap(segment => segment.points.map(point => point.point_id))).toEqual(previous.segments.flatMap(segment => segment.points.map(point => point.point_id)))
})

it('旧错误扩额计划拒复用，但上限内的成功事实保留且不重提成功组', async () => {
  const source = customBook(700), first = customBookFixture(), previous = legacyCustom(await first.run(source), extractionPromptHash())
  previous.point_limit = 100; previous.plan_quotas = previous.plan_quotas!.map(quota => quota * 2)
  for (const group of Object.values(previous.group_cache ?? {})) group.quota *= 2
  const next = customBookFixture()
  expect(reusableExtractionPlan(previous, 'S-0001', source, next.processing, next.options, 6500)).toBeUndefined()
  const result = await next.run(source, previous)
  expect(next.extracts()).toHaveLength(0)
  expect(result.point_limit).toBe(50)
  expect(result.plan_hard_limit).toBe(50)
  expect(result.segments.flatMap(segment => segment.points.map(point => point.point_id))).toEqual(previous.segments.flatMap(segment => segment.points.map(point => point.point_id)))
})
