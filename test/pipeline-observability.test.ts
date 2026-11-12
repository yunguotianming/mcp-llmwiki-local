import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ModelCallError } from '../src/llm/client.js'
import { costMarkdown, costReport, meteredOptions } from '../src/layered/costs.js'
import { schemaJSON } from '../src/llm/protocol.js'
import { outputSchema, wireOutput, extractSource } from '../src/layered/extraction.js'
import type { PendingBuild } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, layeredFixture, modelOutput } from './layered-fixture.js'
import { readLocalSource } from '../src/layered/snapshot.js'
import { writeFile } from 'node:fs/promises'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => { vi.useRealTimers(); cleanupLayeredFixtures() })

it('供应商排队与实际执行分别计时，退避不进入执行耗时', async () => {
  const f = await layeredFixture()
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-10T00:00:00Z'))
  let active = 0
  f.runtime.stream = async function* () {
    active++; await new Promise(resolve => setTimeout(resolve, 20)); active--
    yield { type: 'text-delta', index: 0, text: '{}' }; yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const jobs = [1, 2].map(() => f.client.call('ingest', '', '{}', undefined, [], { operation: 'extract' }))
  await vi.advanceTimersByTimeAsync(40); await Promise.all(jobs)
  expect(active).toBe(0)
  expect(f.client.attempts.map(attempt => [attempt.queueMs, attempt.executionMs, attempt.durationMs])).toEqual([[0, 20, 20], [20, 20, 20]])
  f.library.models.providerProfiles.mock = { concurrency: 1, retryLimit: 1, backoffMs: 100, cacheMode: 'automatic-prefix' }
  let failures = 0
  f.runtime.stream = async function* () {
    await new Promise(resolve => setTimeout(resolve, 10))
    if (!failures++) throw new ModelCallError('重试', 'http', 503)
    yield { type: 'text-delta', index: 0, text: '{}' }; yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const retry = f.client.call('ingest', '', '{}', undefined, [], { operation: 'extract' })
  await vi.advanceTimersByTimeAsync(120); await retry
  expect(f.client.attempts.slice(2).map(attempt => [attempt.executionMs, attempt.durationMs])).toEqual([[10, 10], [10, 10]])
})

it('首提结构通过率跨落盘续跑保留首次结果，纠正重试不能覆盖失败', async () => {
  const f = await layeredFixture(), pending = { started_at: new Date().toISOString(), costs: costReport() } as PendingBuild
  const schema = schemaJSON(z.object({ points: z.array(z.string()) }), 'observed_extraction')
  let raw = '{"points":"格式错误"}'
  f.call.mockImplementation(async () => raw)
  let measured = meteredOptions(f.root, pending, f.options)
  const args = ['ingest', '提取', JSON.stringify({ source_id: 'S-0001', paragraphs: [{ paragraph_id: 0 }] }), undefined, [],
    { operation: 'extract', structuredSchemaKind: 'extraction', structuredSchema: { name: 'observed_extraction', schema } }] as const
  await measured.client.call(args[0], args[1], args[2], args[3], [], args[5])
  const restored = JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8')) as PendingBuild
  expect(Object.values(restored.costs!.first_extractions!)).toEqual([{ source_id: 'S-0001', status: 'failed' }])
  measured = meteredOptions(f.root, restored, f.options); raw = '{"points":["合格"]}'
  await measured.client.call(args[0], args[1], args[2], args[3], [], args[5])
  await measured.client.call('ingest', args[1], JSON.stringify({ source_id: 'S-0002', paragraphs: [{ paragraph_id: 0 }] }), undefined, [], args[5])
  expect(Object.values(restored.costs!.first_extractions!).map(item => item.status)).toEqual(['failed', 'passed'])
  expect(costMarkdown(restored.costs!)).toContain('1/2（50.0%）')
})

it('纠正尚未返回时计数已经落盘，恢复继续累加排队与执行时间', async () => {
  const f = await layeredFixture(), pending = { started_at: new Date().toISOString(), costs: costReport() } as PendingBuild
  const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  f.call.mockImplementation(async (...args) => {
    args[5]?.beforeAttempt?.()
    args[5]?.onAttempt?.({ route: { provider: 'mock', model: 'test' }, startedAt: new Date().toISOString(), durationMs: 7, queueMs: 11, executionMs: 7, finish: 'stop' })
    started.resolve(); await release.promise; return '{}'
  })
  const measured = meteredOptions(f.root, pending, f.options)
  const work = measured.client.call('ingest', '', JSON.stringify({ correction_stage: 'structure', items: [] }), undefined, [], { operation: 'extract' })
  await started.promise
  expect(JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8')).costs.stages['提取'].corrections).toBe(1)
  release.resolve(); await work
  expect(pending.costs!.stages['提取']).toMatchObject({ corrections: 1, queue_ms: 11, execution_ms: 7 })
  const restored = JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8')) as PendingBuild
  await meteredOptions(f.root, restored, f.options).client.call('ingest', '', JSON.stringify({ correction_stage: 'structure', items: [] }), undefined, [], { operation: 'extract' })
  expect(restored.costs!.stages['提取']).toMatchObject({ corrections: 2, queue_ms: 22, execution_ms: 14 })
})

it('完整提取Schema允许0至8个标签，空白标签和超限仍被拒绝', () => {
  const value = { tags: [], credibility: 'low', credibility_reason: '测试', points: [], terms: [] }
  for (const count of [0, 1, 2, 8]) {
    const tags = Array.from({ length: count }, (_, index) => '标签' + index)
    expect(outputSchema.safeParse({ ...value, tags }).success).toBe(true)
    expect(wireOutput.safeParse({ ...value, tags }).success).toBe(true)
  }
  expect(outputSchema.safeParse({ ...value, tags: [' '] }).success).toBe(false)
  expect(wireOutput.safeParse({ ...value, tags: Array(9).fill('标签') }).success).toBe(false)
})

it('零标签不影响逐字证据校验，提取提示仍要求3至8个并记录标签不足', async () => {
  const f = await layeredFixture(), file = path.join(f.knowledgeRoot, 'source.md')
  await writeFile(file, '研究发现结果改善。')
  const source = await readLocalSource(file, 'Markdown')
  f.call.mockImplementation(async (_task, prompt, input) => {
    expect(prompt).toContain('要求3–8个')
    return JSON.stringify({ ...JSON.parse(modelOutput(JSON.parse(input))), tags: [] })
  })
  const result = await extractSource(f.root, 'S-0001', source, { tier: 50, prompt_version: '观测', model: 'mock' }, f.options, 64000)
  expect(result.tags).toEqual([])
  expect(result.tag_status).toMatchObject({ count: 0, message: '标签不足' })
  expect(result.segments.flatMap(segment => segment.points)).toHaveLength(4)
})
