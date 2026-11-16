import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { identityDigest, withRecovery } from '../src/layered/accepted.js'
import type { AcceptedTaskSpec, RecoveryPending } from '../src/layered/accepted.js'
import { recoveryTask } from '../src/layered/extraction-cache.js'
import { hash } from '../src/layered/files.js'
import { overviewLimits, reviewExtraction, reviewNeedsRetry, reviewPolicy } from '../src/layered/review.js'
import { recoveryFixture } from './b1-recovery-fixture.js'
import { cleanupLayeredFixtures, layeredFixture } from './layered-fixture.js'
import { reviewFixture } from './quality-fix2-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('新证据协议使旧接受任务失效，仅补核一次后新身份可离线复用', async () => {
  const storage = await layeredFixture(), f = reviewFixture()
  const recovery = recoveryFixture(storage.root, f.options.client)
  const baseline = JSON.parse(await readFile(new URL('./fixtures/v011-published.json', import.meta.url), 'utf8'))
  const legacy = Object.values(baseline.files).map(value => {
    try { return JSON.parse(value as string) } catch { return undefined }
  }).find(value => value?.review_policy)
  const oldPolicy = legacy.review_policy as string, newPolicy = reviewPolicy(f.options)
  expect(newPolicy).not.toBe(oldPolicy)
  const original = structuredClone(f.extraction), originalBytes = JSON.stringify(original)
  const spec = (policy: string): AcceptedTaskSpec => ({ unitId: 'S-0001/review', sourceRefs: [{ sourceId: 'S-0001', sourceVersion: 'v1' }], operation: 'review',
    input: { reviewInputHash: hash(originalBytes), source: { text: f.source.text, metadata: f.source.metadata }, policy, overview: overviewLimits(f.options) },
    prompt: policy, schema: 'extraction-review-v1', validatorVersion: policy, semanticVersion: 'extraction-review-v1' })
  const pending = { format_version: 2, base_version: null, version: null, manifest: { sources: [] }, added: [], started_at: '固定时间', model_calls: 0 } as unknown as RecoveryPending
  const valid = (value: typeof original) => value.segments.every(segment => segment.points.every(point => point.verification?.status === 'verified'))
  await withRecovery(storage.root, pending, { ...f.options, recovery: recovery.bindings }, async options => {
    const old = await recoveryTask(options, 'extractionReview', { policy: oldPolicy }, async () => {
      // 冻结旧协议的接受成果；模型响应仍走真实接受接点，生产表可追溯。
      await options.client.call('ingest', '旧核对协议', JSON.stringify({ review_stage: 'extraction', points: [{ id: 'P1' }] }))
      const value = structuredClone(original)
      value.segments[0]!.points[0]!.verification = { status: 'verified', missing: '', fingerprint: '旧缺维度指纹' }
      return value
    }, valid, spec(oldPolicy))
    expect(old.acceptedRef).toBeDefined()
    const oldBytes = await readFile(path.join(storage.root, old.acceptedRef!.path))
    f.call.mockClear()
    const work = vi.fn(async () => {
      const value = structuredClone(old.value)
      expect(await reviewExtraction(value, f.source, options, 100000)).toBe(1)
      return value
    })
    const next = await recoveryTask(options, 'extractionReview', { policy: newPolicy }, work, valid, spec(newPolicy))
    expect(next.acceptedRef!.taskId).not.toBe(old.acceptedRef!.taskId)
    expect(f.call).toHaveBeenCalledTimes(1)
    expect(JSON.parse(f.call.mock.calls[0]![2]).review_stage).toBe('extraction')
    const record = JSON.parse(await readFile(path.join(storage.root, next.acceptedRef!.path), 'utf8'))
    expect(record.identity).toMatchObject({ promptDigest: identityDigest(newPolicy), validatorVersion: newPolicy })
    f.call.mockClear()
    const resumed = await recoveryTask(options, 'extractionReview', { policy: newPolicy }, work, valid, spec(newPolicy))
    expect(resumed.reused).toBe(true)
    expect(work).toHaveBeenCalledTimes(1)
    expect(f.call).not.toHaveBeenCalled()
    expect(await readFile(path.join(storage.root, old.acceptedRef!.path))).toEqual(oldBytes)
    expect(JSON.stringify(original)).toBe(originalBytes)
    const invalid = structuredClone(next.value)
    invalid.segments[0]!.points[0]!.evidence[0]!.source_id = 'S-0002'
    invalid.correction_batches = { semantic: 2 }
    const invalidSpec = { ...spec(newPolicy), unitId: 'S-0001/invalid-review', input: { extraction: invalid }, dependencies: [next.acceptedRef!] }
    const rejected = await recoveryTask(options, 'extractionReview', invalidSpec.input, async () => {
      expect(await reviewExtraction(invalid, f.source, options, 100000)).toBe(0)
      return invalid
    }, value => !reviewNeedsRetry(value), invalidSpec)
    expect(rejected.acceptedRef, '有上游生产记录也不能接受无效证据').toBeUndefined()
    expect(pending.acceptedRefs?.[invalidSpec.unitId]).toBeUndefined()
    expect(f.call).not.toHaveBeenCalled()
  })
})
