import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { layeredSettings } from '../src/domain/config.js'
import { hash, writeJson } from '../src/layered/files.js'
import { withRecovery } from '../src/layered/accepted.js'
import type { AcceptedRecord, AcceptedRef, RecoveryPending } from '../src/layered/accepted.js'
import { validatedTask } from '../src/layered/extraction-cache.js'
import { synthesizeSourceSummary } from '../src/layered/longdoc.js'
import type { SummaryRecoveryState } from '../src/layered/longdoc.js'
import type { BuildLayeredOptions, Extraction, SourceSummary } from '../src/layered/schema.js'
import { recoveryFixture } from './b1-recovery-fixture.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
type SummaryExtraction = Extraction & SummaryRecoveryState
async function fixture(count = 4, textSize = 50) {
  const root = await mkdtemp(path.join(tmpdir(), 'llmwiki-b1-longdoc-')); roots.push(root)
  await writeJson(root, 'state/revocations.json', { generation: 0, sources: [] })
  const client: BuildLayeredOptions['client'] = {
    info: vi.fn(async () => ({ provider: 'mock', id: 'summary', name: '摘要桩' })), concurrency: () => 1,
    call: vi.fn(async (_task, _system, input) => {
      const request = JSON.parse(input)
      return JSON.stringify({ point_ids: request.children.flatMap((child: { points: { point_id: string }[] }) => child.points.map(point => point.point_id)).slice(0, 1) })
    }),
  }
  const recovery = recoveryFixture(root, client)
  const pending = { format_version: 2, base_version: null, version: null, manifest: { sources: [] }, added: [], started_at: '固定时间', model_calls: 0 } as unknown as RecoveryPending
  const settings = layeredSettings({ sourceSummaryFanout: 8, sourceSummaryMaxPoints: 8 })
  const version = hash('来源版本'), sourceId = 'S-0001'
  const points = Array.from({ length: count }, (_, index) => ({ point_id: 'p' + index, text_hash: hash('原文' + index), locator: 'L1-L1', source_version: version,
    text: '第' + index + '项完整结论：' + 'x'.repeat(textSize), section: '主要发现' as const,
    evidence: [{ source_id: sourceId, source_version: version, locator: 'L1-L1', quote: '完整证据' }], models: [{ provider: 'mock', model: 'old' }] }))
  const groups: Record<string, SourceSummary> = Object.fromEntries(['g0', 'g1'].map((id, index) => [id, {
    id, point_ids: points.slice(index * count / 2, (index + 1) * count / 2).map(point => point.point_id), missing: [], level: 0,
    children: [], fingerprint: hash(id), models: [{ provider: 'mock', model: 'old' }],
  }]))
  const original: SummaryExtraction = { format_version: 1, tag_version: 1, tags: ['测试'], source_id: sourceId, source_hash: version,
    processing: { tier: 50, prompt_version: '摘要测试' }, metadata: { title: '长文', source_type: '文章', credibility: 'unknown', credibility_reason: '', source_date: '', source_date_basis: '原文日期' },
    calls: [], group_summaries: groups, gaps: [], segments: [{ locator: 'L1-L1', text_hash: version, start: 0, end: 1, resource_hashes: [], processing_fingerprint: hash('处理'), points, terms: [] }] }
  const options = { knowledgeRoot: root, client, recovery: recovery.bindings }
  const checkpoint = vi.fn(async () => {})
  const run = (result: SummaryExtraction, replayOnly = false, inputLimit = Infinity) => withRecovery(root, pending, { ...options, replayOnly }, active =>
    synthesizeSourceSummary(result, Object.keys(groups), active, settings, inputLimit, checkpoint, (_error, signal) => signal.aborted))
  return { root, client, recovery, pending, options, original, run, settings, checkpoint }
}

it('摘要节点与块保存接受引用，依赖闭合且换模型离线先复用再查预算', async () => {
  const fixtureData = await fixture(), { root, original, options, pending } = fixtureData
  await withRecovery(root, pending, options, async active => {
    for (const child of Object.values(original.group_summaries!)) {
      const receipt = await validatedTask(active, 'extract', {}, async signal => {
        await active.client.call('ingest', '子摘要', JSON.stringify({ children: [{ points: child.point_ids.map(point_id => ({ point_id })) }] }), signal)
        return child
      }, value => value.point_ids.length > 0, { unitId: child.id, sourceRefs: [{ sourceId: original.source_id, sourceVersion: original.source_hash }],
        operation: 'sourceSummary', input: { ids: child.point_ids }, prompt: '子摘要', schema: {}, validatorVersion: 'test', semanticVersion: 'test' })
      Object.assign(child, { acceptedRef: receipt.acceptedRef })
    }
  })
  const first = structuredClone(original)
  await fixtureData.run(first)
  const nodeRef = (first.summary as SourceSummary & { acceptedRef: AcceptedRef }).acceptedRef
  const block = Object.values(first.summary_blocks!)[0]!
  expect(block.acceptedRef).toBeDefined()
  const record = JSON.parse(await readFile(path.join(root, nodeRef.path), 'utf8')) as AcceptedRecord
  const blockRecord = JSON.parse(await readFile(path.join(root, block.acceptedRef!.path), 'utf8')) as AcceptedRecord
  expect(record.dependencies.some(dependency => dependency.taskId === block.acceptedRef!.taskId)).toBe(true)
  expect(blockRecord.dependencies).toHaveLength(2)
  const summaryProduction = Object.values(blockRecord.productions).find(production => production.taskId === block.acceptedRef!.taskId)!
  expect(summaryProduction.parentProductionIds).toHaveLength(2)
  vi.mocked(fixtureData.client.call).mockClear()
  vi.mocked(fixtureData.recovery.bindings.stageInputBudgets).mockClear().mockRejectedValue(new Error('不能查询窗口'))
  vi.mocked(fixtureData.client.info).mockRejectedValue(new Error('模型目录离线'))
  const resumed = structuredClone(original)
  resumed.segments[0]!.points.forEach(point => { point.models = [{ provider: 'another', model: 'changed' }] })
  Object.values(resumed.group_summaries!).forEach(group => { group.models = [{ provider: 'another', model: 'changed' }] })
  await fixtureData.run(resumed, true, 1)
  expect(resumed.summary).toEqual(first.summary)
  expect(fixtureData.client.call).not.toHaveBeenCalled()
  expect(fixtureData.client.info).not.toHaveBeenCalled()
  expect(fixtureData.recovery.bindings.stageInputBudgets).not.toHaveBeenCalled()
})

it('摘要窗口缩小时冻结成功块，只细分未完成块并保留父子计划', async () => {
  const fixtureData = await fixture(12, 500), result = structuredClone(fixtureData.original)
  fixtureData.recovery.setWindow(3200)
  const call = vi.mocked(fixtureData.client.call), implementation = call.getMockImplementation()!
  let attempts = 0
  call.mockImplementation(async (...args) => {
    if (++attempts === 2) throw new Error('第二块临时失败')
    return implementation(...args)
  })
  await fixtureData.run(result)
  const originalPlans = structuredClone(result.summary_plans!)
  const successful = Object.entries(result.summary_blocks!)[0]!
  expect(successful[1].acceptedRef).toBeDefined()
  const frozen = structuredClone(successful[1])
  const firstRequest = call.mock.calls[0]!, firstIds = JSON.parse(firstRequest[2]).children.flatMap((child: { points: { point_id: string }[] }) => child.points.map(point => point.point_id))
  expect(firstIds.length).toBeGreaterThan(1)
  const smaller = Buffer.byteLength(firstRequest[1] + firstRequest[2]) - 200
  fixtureData.recovery.setWindow(smaller)
  call.mockClear().mockImplementation(implementation)
  await fixtureData.run(result)
  for (const [key, members] of Object.entries(originalPlans)) expect(result.summary_plans![key]).toEqual(members)
  expect(result.summary_blocks![successful[0]]).toEqual(frozen)
  expect(Object.keys(result.summary_plans!).some(key => key.includes('/split/'))).toBe(true)
  expect(call.mock.calls.every(([, , input]) => input !== firstRequest[2])).toBe(true)
  expect(result.summary?.missing).toEqual([])
}, 20000)

it('完整摘要原子装不下时持久化阶段暂停，不调用模型或记录普通缺口', async () => {
  const fixtureData = await fixture(), result = structuredClone(fixtureData.original)
  fixtureData.recovery.setWindow(1)
  await expect(fixtureData.run(result)).rejects.toMatchObject({ stagePause: true, code: 'NO_COMPATIBLE_CANDIDATE' })
  expect(fixtureData.pending.stagePause?.stage).toBe('extract')
  expect(fixtureData.client.call).not.toHaveBeenCalled()
  expect(result.gaps).toEqual([])
})

it('摘要块损坏先报错并保留现场，不靠已接受节点掩盖损坏', async () => {
  const fixtureData = await fixture(), result = structuredClone(fixtureData.original)
  await fixtureData.run(result)
  const block = Object.values(result.summary_blocks!)[0]!
  const record = JSON.parse(await readFile(path.join(fixtureData.root, block.acceptedRef!.path), 'utf8')) as AcceptedRecord
  const outputFile = path.join(fixtureData.root, record.output.path)
  await writeFile(outputFile, '损坏输出')
  vi.mocked(fixtureData.client.call).mockClear()
  vi.mocked(fixtureData.recovery.bindings.stageInputBudgets).mockClear()
  await expect(fixtureData.run(result)).rejects.toMatchObject({ code: 'ACCEPTED_CORRUPT' })
  expect(await readFile(outputFile, 'utf8')).toBe('损坏输出')
  expect(fixtureData.client.call).not.toHaveBeenCalled()
  expect(fixtureData.recovery.bindings.stageInputBudgets).not.toHaveBeenCalled()
})

it('旧摘要路径保持原请求和检查点复用，不新增任务回执或重复模型目录查询', async () => {
  const fixtureData = await fixture(), result = structuredClone(fixtureData.original)
  const run = () => synthesizeSourceSummary(result, Object.keys(result.group_summaries!), fixtureData.options, fixtureData.settings, 32000, fixtureData.checkpoint, () => false)
  await run()
  expect(fixtureData.client.call).toHaveBeenCalledTimes(1)
  expect(fixtureData.client.info).toHaveBeenCalledTimes(1)
  const input = JSON.parse(vi.mocked(fixtureData.client.call).mock.calls[0]![2])
  expect(input.summary_id).toBe(result.summary?.id)
  expect(result.summary_plans).toBeUndefined()
  expect(result.summary_blocks).toBeUndefined()
  await run()
  expect(fixtureData.client.call).toHaveBeenCalledTimes(1)
  expect(fixtureData.client.info).toHaveBeenCalledTimes(1)
})
