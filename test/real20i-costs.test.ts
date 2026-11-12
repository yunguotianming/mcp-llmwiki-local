import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { costReport, meteredOptions } from '../src/layered/costs.js'
import { schemaJSON } from '../src/llm/protocol.js'
import { parseModelJson } from '../src/llm/json.js'
import { extractSource } from '../src/layered/extraction.js'
import { readLocalSource } from '../src/layered/snapshot.js'
import type { PendingBuild } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, layeredFixture } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => { vi.useRealTimers(); cleanupLayeredFixtures() })

it('可空 note 同源产品校验和首提观测均通过，不多发纠正', async () => {
  const f = await layeredFixture(), pending = { started_at: new Date().toISOString(), costs: costReport() } as PendingBuild
  const output = z.object({ terms: z.array(z.object({ note: z.string().nullable() })) })
  const schema = schemaJSON(output, 'real20i_nullable')
  f.call.mockResolvedValue('{"terms":[{"note":null}]}')
  const raw = await meteredOptions(f.root, pending, f.options).client.call('ingest', '', '{"source_id":"S-0001"}', undefined, [], { operation: 'extract', structuredSchema: { name: 'real20i_nullable', schema } })
  expect(output.parse(parseModelJson(raw, schema))).toEqual({ terms: [{ note: null }] })
  expect(Object.values(pending.costs!.first_extractions!).map(v => v.status)).toEqual(['passed'])
  expect(f.call).toHaveBeenCalledTimes(1)
})

it('主题纠正独立于提取额度，阶段率落盘，超过各自两倍才拒绝', async () => {
  const f = await layeredFixture(), pending = { started_at: new Date().toISOString(), costs: costReport() } as PendingBuild
  f.options.topics = { correctionMinCalls: 1 }
  f.call.mockResolvedValue('{}')
  const client = meteredOptions(f.root, pending, f.options).client
  const call = (input: unknown) => client.call('ingest', '', JSON.stringify(input))
  await call({ source_id: 'S1' })
  await call({ topic_id: 'T1' })
  await call({ topic_id: 'T1', review_stage: 'topic', sentences: [] })
  for (let i = 0; i < 4; i++) await call({ topic_id: 'T1', validationFeedback: { error: '引用不符' } })
  expect(pending.costs!.correction_rates!['主题']).toEqual({ calls: 2, corrections: 4, rate: 2, limit: 2, minimum_calls: 1 })
  await expect(call({ topic_id: 'T1', validationFeedback: {} })).rejects.toMatchObject({ budgetPause: true })
  for (let i = 0; i < 2; i++) await call({ source_id: 'S1', correction_stage: 'structure', items: [] })
  await expect(call({ source_id: 'S1', correction_stage: 'structure', items: [] })).rejects.toMatchObject({ budgetPause: true })
  const saved = JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8'))
  expect(saved.costs.correction_rates['提取'].rate).toBe(2)
  expect(f.call).toHaveBeenCalledTimes(9)
})

it('供应商超时保留部分输出字节及首字延迟，闸门排队不算执行', async () => {
  const f = await layeredFixture(); vi.useFakeTimers()
  vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
    const abort = new AbortController()
    setTimeout(() => abort.abort(new DOMException('超时', 'TimeoutError')), milliseconds)
    return abort.signal
  })
  f.policy.ingestRequestTimeoutSeconds = 1
  f.runtime.stream = async function* () {
    await new Promise(resolve => setTimeout(resolve, 50))
    yield { type: 'text-delta', index: 0, text: '部分输出' }
    await new Promise(resolve => setTimeout(resolve, 1000))
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const result = expect(f.client.call('ingest', '提示', '{}', undefined, [], { operation: 'extract' })).rejects.toThrow()
  await vi.advanceTimersByTimeAsync(1100); await result
  expect(f.client.attempts[0]).toMatchObject({ firstTextMs: 50, outputBytes: 12, inputBytes: 8, queueMs: 0, finish: 'aborted' })
})

it('真实产品提取路径保留 note:null，首提一次成功且无需纠正', async () => {
  const f = await layeredFixture(), file = path.join(f.knowledgeRoot, 'nullable.md')
  await writeFile(file, '术语甲。')
  const source = await readLocalSource(file, '资料'), pending = { started_at: new Date().toISOString(), costs: costReport() } as PendingBuild
  f.call.mockResolvedValue(JSON.stringify({ tags: ['研究方法'], credibility: 'unknown', credibility_reason: null, points: [],
    terms: [{ paragraph_id: 0, name: '术语甲', category: '概念', aliases: [], locator: 'L1-L1', note: null }] }))
  const result = await extractSource(f.root, 'S-0001', source, { tier: 50, granularity: 'custom', model: 'mock', prompt_version: '20i' }, meteredOptions(f.root, pending, f.options), 64000)
  expect(result.segments[0]!.terms).toHaveLength(1)
  expect(result.segments[0]!.terms[0]!.note).toBeNull()
  expect(f.call).toHaveBeenCalledTimes(1)
  expect(Object.values(pending.costs!.first_extractions!).map(v => v.status)).toEqual(['passed'])
  expect(result.gaps).toEqual([])
})

it('旧状态恢复后固定首轮基数，少量主题允许完成分块纠正并记录真实率', async () => {
  const f = await layeredFixture(), costs = costReport()
  costs.stages['主题']!.actual_calls = 1
  const pending = { started_at: costs.started_at, costs } as PendingBuild
  f.call.mockResolvedValue('{}')
  const client = meteredOptions(f.root, pending, f.options).client
  for (let i = 0; i < 6; i++) await client.call('ingest', '', JSON.stringify({ topic_id: 'T1', validationFeedback: { error: '分块引用' } }))
  expect(costs.correction_rates!['主题']).toEqual({ calls: 1, corrections: 6, rate: 6, limit: 2, minimum_calls: 10 })
  expect(costs.stages['主题']!.actual_calls).toBe(7)
  expect(pending.paused).toBeUndefined()
})
