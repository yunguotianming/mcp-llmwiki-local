import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { canonicalJson, identityDigest, makeTaskIdentity, recoverAccepted, rejectAcceptedResponse, taskIdFor, withAcceptedCall, withRecovery } from '../src/layered/accepted.js'
import type { AcceptedRecord, AcceptedTaskSpec, RecoveryPending } from '../src/layered/accepted.js'
import { validatedTask } from '../src/layered/extraction-cache.js'
import { hash, writeJson } from '../src/layered/files.js'
import type { BuildLayeredOptions } from '../src/layered/schema.js'
import { recoveryFixture } from './b1-recovery-fixture.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'llmwiki-b1-accept-')); roots.push(root)
  await writeJson(root, 'state/revocations.json', { generation: 0, sources: [] })
  const client = { info: vi.fn(async () => { throw new Error('不能解析模型目录') }), call: vi.fn(async () => '{"value":"已验收结果"}') }
  const f = recoveryFixture(root, client)
  const pending = { format_version: 2, base_version: null, version: null, manifest: { sources: [] }, added: [], started_at: '固定时间', model_calls: 0 } as unknown as RecoveryPending
  const options = { knowledgeRoot: root, client, recovery: f.bindings }
  const spec: AcceptedTaskSpec = { unitId: 'unit-1', sourceRefs: [{ sourceId: 'S-0001', sourceVersion: 'v1' }], operation: 'generate',
    input: { text: '完整原文' }, prompt: '提示', schema: { type: 'object' }, validatorVersion: 'v1', semanticVersion: 'v1' }
  let identity: Awaited<ReturnType<typeof makeTaskIdentity>>
  const run = (replayOnly = false, automaticRecovery = false, activeSpec = spec) => withRecovery(root, pending, { ...options, replayOnly, automaticRecovery }, async active => {
    identity = await makeTaskIdentity('topic', activeSpec)
    return validatedTask(active, 'topic', {}, async signal => JSON.parse(await active.client.call('ingest', '提示', '{"text":"完整原文"}', signal)),
      value => value.value === '已验收结果', activeSpec)
  })
  return { ...f, root, client, pending, options, spec, run, identity: () => identity!, file: () => path.join(root, 'work/accepted/tasks/' + taskIdFor(identity!).slice(2) + '.json') }
}

it('身份使用规范 JSON，接受跨模型复用且离线不解析目录或派发', async () => {
  const f = await fixture(), first = await f.run(), before = await readFile(f.file())
  expect(first.acceptedRef?.taskId).toMatch(/^t:[a-f0-9]{64}$/)
  expect(canonicalJson({ b: [2, 1], a: '原文\r\n' })).toBe('{"a":"原文\\r\\n","b":[2,1]}')
  expect(() => canonicalJson({ a: undefined })).toThrow()
  expect(() => canonicalJson([Infinity])).toThrow()
  f.client.call.mockImplementation(async () => { throw new Error('换模型后不应调用') })
  const second = await f.run(true)
  expect(second.value).toEqual(first.value); expect(second.reused).toBe(true)
  expect(await readFile(f.file())).toEqual(before)
  expect(f.bindings.callDetailed).toHaveBeenCalledTimes(1); expect(f.client.info).not.toHaveBeenCalled()
})

it('prepared 和已提交未绑定两种中断都从快照恢复，runId 自动恢复不变', async () => {
  const f = await fixture()
  f.failPrepare(true)
  await expect(f.run()).rejects.toThrow('准备后中断')
  const runId = f.pending.runId
  f.failPrepare(false); f.failBind(true)
  await expect(f.run(true, true)).rejects.toThrow('提交后绑定中断')
  const committed = await readFile(f.file())
  f.failBind(false)
  expect((await f.run(true, true)).reused).toBe(true)
  expect(f.pending.runId).toBe(runId); expect(await readFile(f.file())).toEqual(committed)
  expect(f.bindings.callDetailed).toHaveBeenCalledTimes(1)
  await f.run(true)
  expect(f.pending.runId).not.toBe(runId)
})

it('坏输出、坏提交及不一致准备快照保留现场报错，不在线覆盖', async () => {
  const f = await fixture(); await f.run()
  const original = await readFile(f.file(), 'utf8'), record = JSON.parse(original) as AcceptedRecord
  const outputPath = path.join(f.root, record.output.path), output = await readFile(outputPath)
  await writeFile(outputPath, '损坏')
  await expect(f.run()).rejects.toMatchObject({ code: 'ACCEPTED_CORRUPT' })
  expect(await readFile(outputPath, 'utf8')).toBe('损坏')
  await writeFile(outputPath, output); await writeFile(f.file(), original.replace('"schema":', '"schema":0,"schema":'))
  await expect(f.run()).rejects.toMatchObject({ code: 'ACCEPTED_CORRUPT' })
  await writeFile(f.file(), original)
  const file = path.join(f.root, 'logs/model-accepts/' + record.taskId.slice(2) + '.json')
  const snapshot = JSON.parse(await readFile(file, 'utf8')); snapshot.record.identity.scope.unitId = '不同单元'
  await writeFile(file, canonicalJson(snapshot) + '\n')
  await expect(f.run()).rejects.toMatchObject({ code: 'ACCEPT_CONFLICT' })
  expect(f.bindings.callDetailed).toHaveBeenCalledTimes(1)
})

it('撤权使旧接受失效，显式重提代次隔离并保留历史记录', async () => {
  const f = await fixture(), original = await f.run(), identity = f.identity(), before = await readFile(f.file())
  f.pending.reextractGenerations = { 'S-0001': 1 }
  const next = await f.run()
  expect(next.acceptedRef?.taskId).not.toBe(original.acceptedRef?.taskId)
  expect(await readFile(path.join(f.root, original.acceptedRef!.path))).toEqual(before)
  await writeJson(f.root, 'state/revocations.json', { generation: 1, sources: [{ source_id: 'S-0001', generation: 1 }] })
  await expect(withRecovery(f.root, f.pending, f.options, () => recoverAccepted(identity, () => true))).rejects.toMatchObject({ code: 'ACCEPTED_REVOKED' })
  expect(f.bindings.callDetailed).toHaveBeenCalledTimes(2)
})

it('缺接受结果离线失败，依赖损坏拒收，同键并发只派发一次', async () => {
  const f = await fixture()
  await expect(f.run(true)).rejects.toMatchObject({ code: 'ACCEPTED_MISSING' })
  const [left, right] = await Promise.all([f.run(), f.run()])
  expect(left.value).toEqual(right.value); expect(f.bindings.callDetailed).toHaveBeenCalledTimes(1)
  const dependent = { ...f.spec, unitId: 'dependent', dependencies: [left.acceptedRef!] }
  await f.run(false, false, dependent)
  const record = JSON.parse(await readFile(path.join(f.root, left.acceptedRef!.path), 'utf8')) as AcceptedRecord
  expect(identityDigest(record.identity)).toBe('sha256:' + left.acceptedRef!.taskId.slice(2))
  await writeFile(path.join(f.root, record.output.path), '损坏依赖')
  await expect(f.run(true, false, dependent)).rejects.toMatchObject({ code: 'ACCEPTED_CORRUPT' })
})

it('生产链：部分原稿与纠正均保留，完全废稿只记拒收', async () => {
  const f = await fixture()
  f.client.call.mockImplementation(async (...args: unknown[]) => String(args[2]))
  const result = await withRecovery(f.root, f.pending, f.options, active => validatedTask(active, 'topic', {}, async signal => {
    for (const unitId of ['甲', '乙']) await withAcceptedCall({ unitId }, () => validatedTask(active, 'topic', {},
      async () => active.client.call('ingest', '提示', unitId, signal), () => false, { ...f.spec, unitId }))
    await rejectAcceptedResponse('乙')
    await withAcceptedCall({ unitId: '甲' }, () => active.client.call('ingest', '提示', '甲的纠正', signal, [], { structuredSchemaKind: 'correction' }))
    return '接受甲及其纠正'
  }, () => true, { ...f.spec, unitId: '成稿' }))
  const record = JSON.parse(await readFile(path.join(f.root, result.acceptedRef!.path), 'utf8')) as AcceptedRecord
  const entries = Object.entries(record.productions), original = entries.find(([, value]) => value.outputDigest === hash('甲'))!
  expect(entries).toHaveLength(2)
  expect(entries.find(([, value]) => value.role === 'correct')![1].parentProductionIds).toEqual([original[0]])
  const executions = vi.mocked(f.bindings.resolveExecution).mock.calls
  expect(executions.at(-1)![2]).toEqual(executions[0]![2])
  expect(f.validations).toHaveLength(1)
  expect(f.validations[0]).toMatchObject({ status: 'rejected', reasonCode: 'BUSINESS_VALIDATION' })
})

it('生产链：并行兄弟组的纠正不误挂其他组原稿', async () => {
  const f = await fixture()
  f.client.call.mockImplementation(async (...args: unknown[]) => String(args[2]))
  const result = await withRecovery(f.root, f.pending, f.options, active => validatedTask(active, 'topic', {}, async signal => {
    for (const unitId of ['甲', '乙']) await withAcceptedCall({ unitId }, () => validatedTask(active, 'topic', {},
      () => active.client.call('ingest', '提示', unitId, signal), () => false, { ...f.spec, unitId }))
    await Promise.all(['甲', '乙'].map(unitId => withAcceptedCall({ unitId }, () =>
      active.client.call('ingest', '提示', unitId + '修订', signal, [], { structuredSchemaKind: 'correction' }))))
    return '两组均接受'
  }, () => true, { ...f.spec, unitId: '并行成稿' }))
  const record = JSON.parse(await readFile(path.join(f.root, result.acceptedRef!.path), 'utf8')) as AcceptedRecord
  const entries = Object.entries(record.productions)
  for (const unitId of ['甲', '乙']) {
    const original = entries.find(([, value]) => value.outputDigest === hash(unitId))!
    const correction = entries.find(([, value]) => value.outputDigest === hash(unitId + '修订'))![1]
    expect(correction.parentProductionIds).toEqual([original[0]])
  }
})

it('生产链：拒收落盘失败即使被业务捕获也停止外层提交', async () => {
  const f = await fixture()
  f.bindings.hooks.onValidation = async () => { throw new Error('拒收存储失败') }
  await expect(withRecovery(f.root, f.pending, f.options, active => validatedTask(active, 'topic', {}, async signal => {
    const raw = await active.client.call('ingest', '提示', '输入', signal)
    try { await rejectAcceptedResponse(raw) } catch { /* 模拟旧业务的局部失败分支。 */ }
    return '本地替代结果'
  }, () => true, f.spec))).rejects.toThrow('拒收存储失败')
  expect(Object.keys(f.pending.acceptedRefs ?? {})).toHaveLength(0)
})

it('生产链：上游换模型但业务输出相同时下游任务身份保持', async () => {
  const left = await fixture(), right = await fixture()
  const originalCall = right.bindings.callDetailed
  right.bindings.callDetailed = async (...args) => {
    const response = await originalCall(...args)
    return { ...response, actual: { ...response.actual, requestedModel: '另一模型', bindingRevision: hash('另一绑定') } }
  }
  const a = await left.run(), b = await right.run()
  expect(a.acceptedRef!.digest).not.toEqual(b.acceptedRef!.digest)
  const identity = (f: typeof left, ref: NonNullable<typeof a.acceptedRef>) => withRecovery(f.root, f.pending, f.options,
    () => makeTaskIdentity('topic', { ...f.spec, unitId: '下游', dependencies: [ref] }))
  expect(taskIdFor(await identity(left, a.acceptedRef!))).toEqual(taskIdFor(await identity(right, b.acceptedRef!)))
})
