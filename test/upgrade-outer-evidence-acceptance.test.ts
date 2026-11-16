import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { layeredSettings } from '../src/domain/config.js'
import { createExecutionLedger, readRunCosts } from '../src/layered/costs.js'
import { protocolDigest, writeProtocol } from '../src/layered/models.js'
import { pageObjectPath } from '../src/layered/objects.js'
import { topicReviewFingerprint, topicReviewVersion } from '../src/layered/topic-review.js'
import { upgradeLibrary } from '../src/layered/upgrade.js'
import type { TaskIdentity } from '../src/layered/schema.js'
import { prepare } from './b3-fixture.js'
import { evidenceFixture, parent } from './upgrade-evidence-fixture.js'

beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('外层接受等价回归禁止网络') })))
afterEach(() => vi.unstubAllGlobals())

async function history(equivalent: boolean) {
  const f = await evidenceFixture(), client = f.client()
  // 用真实升级计划和接受协议形成旧结果；历史模型用量由离线账本接点累计。
  const state = (await upgradeLibrary(f.root, { upgrade: { maxCalls: 0 }, estimateReview: async () => ({ calls: 1, inputTokens: 10,
    outputTokens: 20, maxInputTokens: 10, maxOutputTokens: 20 }) }))!, step = state.steps[0]!
  const identity: TaskIdentity = { version: 1, scope: { libraryId: f.library.id, unitId: step.id,
    sourceRefs: [{ sourceId: f.source.source_id, sourceVersion: f.source.source_version }] }, stage: 'topicReview', operation: 'review',
    inputDigest: step.inputDigest, promptDigest: topicReviewVersion, schemaDigest: protocolDigest(['upgrade-review-v1', 'topicReview']),
    validatorVersion: 'upgrade-review-v1', semanticVersion: 'upgrade-review-v1', groupPlanDigest: protocolDigest(step.unitIds),
    revocationGeneration: 0, reextractGeneration: 0 }
  const object = pageObjectPath(f.manifest.pages![parent]!), content = await readFile(path.join(f.root, object), 'utf8')
  const contexts = new Map([[f.source.source_id, { title: f.source.metadata.title, source_version: f.source.source_version, text: f.raw, segments: f.source.segments }]])
  const fingerprint = topicReviewFingerprint(content, equivalent ? [f.points[0]!] : [], layeredSettings(f.library.layered).contradictionReview, contexts)
  const accepted = await prepare(f.root, { identity, run: state.id, content: JSON.stringify({ units: [{ id: object, result: { fingerprint, removed: [], aliases: [], models: [] } }] }) })
  const ref = await accepted.commit(); state.accepted[step.id] = ref
  await writeProtocol(f.root, 'work/upgrade-0.3.0.json', state)
  const preserved = Object.fromEntries(await Promise.all([ref.path, accepted.input.record.output.path,
    `logs/model-accepts/${ref.taskId.slice(2)}.json`, 'work/upgrade-0.3.0.json'].map(async file => [file, await readFile(path.join(f.root, file), 'utf8')])) )
  const assertPreserved = async () => { for (const [file, bytes] of Object.entries(preserved)) expect(await readFile(path.join(f.root, file), 'utf8')).toBe(bytes) }
  return { ...f, state, step, ref, client, assertPreserved }
}

it('估算器不能把旧空members外层接受当当前父页完整证据，明确暂停并保留历史', async () => {
  const f = await history(false), before = await readRunCosts(f.root, f.state.id)
  await expect(f.client.upgradeOptions!.estimateReview!(f.step, f.root)).rejects.toMatchObject({ code: 'UPGRADE_REVIEW_EVIDENCE_CHANGED' })
  expect(f.calls).toEqual([]); expect(await readRunCosts(f.root, f.state.id)).toEqual(before); await f.assertPreserved()
})

it('runner离线回放不能绕过父页新证据，旧合法接受不得改写或当损坏', async () => {
  const f = await history(false), before = await readRunCosts(f.root, f.state.id)
  await expect(f.client.upgradeOptions!.runStep!(f.step, { root: f.root, runId: f.state.id,
    hooks: createExecutionLedger(f.root), replayOnly: true })).rejects.toMatchObject({ code: 'UPGRADE_REVIEW_EVIDENCE_CHANGED' })
  expect(f.calls).toEqual([]); expect(await readRunCosts(f.root, f.state.id)).toEqual(before); await f.assertPreserved()
})

it('已有外层接受与当前父页证据等价时原引用零重调恢复，费用及接受原字节不变', async () => {
  const f = await history(true), before = await readRunCosts(f.root, f.state.id)
  expect((await f.client.upgradeOptions!.estimateReview!(f.step, f.root)).calls).toBe(0)
  const ref = await f.client.upgradeOptions!.runStep!(f.step, { root: f.root, runId: f.state.id,
    hooks: createExecutionLedger(f.root), replayOnly: true })
  expect(ref).toEqual(f.ref); expect(f.calls).toEqual([]); expect(await readRunCosts(f.root, f.state.id)).toEqual(before); await f.assertPreserved()
})
