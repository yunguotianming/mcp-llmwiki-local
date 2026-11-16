import { readFile, unlink, writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { createExecutionLedger, normalizeUsage, pruneModelLogs, readRunCosts, readVersionCosts, recoverExecutionRun, writeVersionCosts } from '../src/layered/costs.js'
import * as models from '../src/layered/models.js'
import { safePath } from '../src/storage/paths.js'
import { finish, identity, prepare, request, runId, taskIdOf, temporary } from './b3-fixture.js'

afterEach(() => vi.restoreAllMocks())
it('完整准备快照可离线重读，先绑定后补尝试引用，中断重放不重复计费', async () => {
  const { root } = await temporary(), f = await prepare(root)
  const recovered = createExecutionLedger(root)
  expect(await recovered.readAcceptance(f.accepted.taskId)).toMatchObject({ status: 'prepared', acceptedDigest: null, record: f.accepted })
  await expect(recovered.onAccepted({ taskId: f.accepted.taskId, prepareId: f.prepared.prepareId, acceptedDigest: models.protocolDigest(f.accepted) })).rejects.toMatchObject({ code: 'ACCEPT_CONFLICT' })
  const write = models.writeProtocol
  let fail = true
  vi.spyOn(models, 'writeProtocol').mockImplementation(async (root, file, value) => {
    if (file.includes('/attempts/') && fail) { fail = false; throw new Error('模拟绑定后的引用写入中断') }
    return write(root, file, value)
  })
  await expect(f.commit()).rejects.toThrow('中断')
  expect((await recovered.readAcceptance(f.accepted.taskId)).status).toBe('bound')
  await f.commit(); await f.commit()
  expect((await readRunCosts(root, runId)).total.calls).toBe(1)
  const entry = JSON.parse(await readFile(await safePath(root, `logs/model-runs/${runId}/attempts/1.json`), 'utf8'))
  expect(entry.accepts).toHaveLength(1)
  expect(Object.values((await recovered.readAcceptance(f.accepted.taskId) as any).record.productions)[0]).toMatchObject({ lineId: '备用', requestedModel: '备用模型' })
})

it('并发预留不超额，派发前释放不计费，未知用量保留预算且只校正一次', async () => {
  const { root } = await temporary(), hooks = createExecutionLedger(root, { maxCalls: 1, maxTokens: 120 })
  const a = request(taskIdOf(identity('一')), 1), b = request(taskIdOf(identity('二')), 2)
  const result = await Promise.all([hooks.beforeAttempt(a), hooks.beforeAttempt(b)])
  expect(result.map(r => r.status)).toEqual(['reserved', 'paused'])
  await hooks.releaseAttempt(a.attemptId, '派发前取消')
  await finish(hooks, b, false, null)
  expect((await readRunCosts(root, runId)).total).toMatchObject({ calls: 1, unknownUsage: 1, reservedTokens: 120 })
  await expect(hooks.releaseAttempt(b.attemptId, '不能退回')).rejects.toMatchObject({ code: 'ATTEMPT_CONFLICT' })
  const outcome = { attemptId: b.attemptId, reservationId: b.attemptId, status: 'finished' as const, finish: 'transport-error' as const, provider: b.candidate.provider, model: b.candidate.requestedModel, reportedModel: null, usage: normalizeUsage({ inputTokens: 12, cacheReadTokens: 2, outputTokens: 5 }, true), requestId: null, errorCategory: 'transport', localExitStatus: null }
  await hooks.afterAttempt(outcome); await hooks.afterAttempt(outcome)
  await expect(hooks.afterAttempt({ ...outcome, usage: { ...outcome.usage, outputTokens: 6 } })).rejects.toMatchObject({ code: 'ATTEMPT_CONFLICT' })
  expect((await readRunCosts(root, runId)).total).toMatchObject({ calls: 1, unknownUsage: 0, reservedTokens: 0, usage: { inputTokens: 10, cacheReadTokens: 2, outputTokens: 5 } })
})

it('准备冲突、重复 JSON 键和写盘失败都停止接受，不创建 IF-50 索引', async () => {
  const { root } = await temporary(), f = await prepare(root)
  await expect(f.hooks.prepareAccepted({ ...f.input, record: { ...f.accepted, dependencies: [{ taskId: f.accepted.taskId, acceptedDigest: models.protocolDigest(f.accepted), sourceRefs: [] }] } })).rejects.toMatchObject({ code: 'ACCEPT_CONFLICT' })
  const file = await safePath(root, `logs/model-accepts/${f.accepted.taskId.slice(2)}.json`)
  await writeFile(file, '{"status":"prepared","status":"bound"}\n')
  await expect(f.hooks.readAcceptance(f.accepted.taskId)).rejects.toMatchObject({ code: 'ACCEPT_PREPARE_CORRUPT' })
  await expect(readFile(await safePath(root, `work/accepted/tasks/${f.accepted.taskId.slice(2)}.json`))).rejects.toMatchObject({ code: 'ENOENT' })
  const write = models.writeProtocol
  vi.spyOn(models, 'writeProtocol').mockImplementation(async (root, file, value) => {
    if (file.startsWith('logs/model-accepts/')) throw Object.assign(new Error('磁盘满'), { storageFailure: true })
    return write(root, file, value)
  })
  await expect(prepare(root, { identity: identity('另一个'), sequence: 2 })).rejects.toMatchObject({ storageFailure: true })
})

it('失败备用计数守恒、未知价格单列，保留引用阻止日志清理，清理后累计成本不归零', async () => {
  const { root } = await temporary(), hooks = createExecutionLedger(root)
  const a = request(taskIdOf(identity()), 1, '主线'); a.priceSnapshot = null
  await finish(hooks, a, false)
  const f = await prepare(root, { sequence: 2 }); await f.commit()
  const before = await readRunCosts(root, runId)
  expect(before.total).toMatchObject({ calls: 2, unknownPrice: 1 })
  expect(before.groups.reduce((n, g) => n + g.totals.calls, 0)).toBe(2)
  await writeVersionCosts(root, 'v000001', models.protocolDigest('清单'), [runId])
  await pruneModelLogs(root, Date.now() + 1000)
  await expect(readFile(await safePath(root, `logs/model-runs/${runId}/attempts/2.json`))).resolves.toBeDefined()
  await unlink(await safePath(root, `work/accepted/tasks/${f.accepted.taskId.slice(2)}.json`))
  await pruneModelLogs(root, Date.now() + 1000)
  expect((await readRunCosts(root, runId)).total).toEqual(before.total)
  expect((await readVersionCosts(root, 'v000001', models.protocolDigest('清单'))).total).toEqual(before.total)
  expect((await createExecutionLedger(root, { maxCalls: 2 }).beforeAttempt(request(taskIdOf(identity('后续')), 3))).status).toBe('paused')
})

it('进程中断恢复释放未派发预留，已派发未知保留额度、序号和空费用', async () => {
  const { root } = await temporary(), hooks = createExecutionLedger(root)
  const a = request(taskIdOf(identity('未派发')), 1), b = request(taskIdOf(identity('已派发')), 2)
  await hooks.beforeAttempt(a); await hooks.beforeAttempt(b); await hooks.onDispatch(b.attemptId)
  const recovered = await recoverExecutionRun(root, runId)
  expect(recovered.nextSequence).toBe(3)
  expect(recovered.attempts.map(a => a.state)).toEqual(['released', 'unknown'])
  expect(recovered.attempts[1]?.charge?.amount).toBeNull()
  expect((await readRunCosts(root, runId)).total).toMatchObject({ calls: 1, unknownUsage: 1, reservedTokens: 120 })
  expect((await createExecutionLedger(root, { maxTokens: 120 }).beforeAttempt(request(taskIdOf(identity('新任务')), 3))).status).toBe('paused')
})
