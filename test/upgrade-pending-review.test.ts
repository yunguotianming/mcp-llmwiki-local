import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { emptyRegistry } from '../src/domain/config.js'
import { defaultPolicy } from '../src/domain/policy.js'
import { createBuildModelClient } from '../src/host/models.js'
import { writeJson } from '../src/layered/files.js'
import { readProvenance } from '../src/layered/models.js'
import { putPage } from '../src/layered/objects.js'
import { readUpgradeStatus, upgradeLibrary, verifyUpgradeBackup } from '../src/layered/upgrade.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { child, evidenceFixture, parent } from './upgrade-evidence-fixture.js'

beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('旧页待核实回归禁止网络') })))
afterEach(() => vi.unstubAllGlobals())

interface ReviewInput { topic_id: string; sentences: { id: string; text: string }[] }
function offlineClient(f: Awaited<ReturnType<typeof evidenceFixture>>, result: (input: ReviewInput) => unknown) {
  const calls: ReviewInput[] = [], policy = defaultPolicy()
  policy.batchDelayMs = 0; policy.maxTokensPerCall = 512
  const runtime: ModelRuntime = {
    resolveModelInfo: vi.fn(async (provider, id) => ({ provider, id, name: id, context: { contextWindow: 131072 } })),
    stream: vi.fn(async function* (request) {
      const message = request.messages[0]!.content[0]!
      if (message.type !== 'text') throw new Error('只接受离线文本')
      const input = JSON.parse(message.text) as ReviewInput; calls.push(input)
      yield { type: 'usage' as const, usage: { inputTokens: 11, outputTokens: 5 } }
      yield { type: 'text-delta' as const, index: 0, text: JSON.stringify(result(input)) }
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
    }),
  }
  const client = createBuildModelClient(runtime, f.library, policy, { ...emptyRegistry(), upgrade: { maxCalls: 8 } })
  return { client, calls }
}
const verdicts = (input: ReviewInput, rejected = false) => ({ items: input.sentences.map(sentence => ({ id: sentence.id,
  support: rejected ? '不支撑' : '完整支撑', missing: rejected ? '旧句没有成员依据。' : null })) })

it('旧主题完整语义拒绝保留原字节并继续，混合组不伪造整组接受', async () => {
  const f = await evidenceFixture()
  delete f.manifest.deps!.pages[child]!.review; await f.save()
  const { client, calls } = offlineClient(f, input => ({ items: input.sentences.map(sentence => ({ id: sentence.id,
    support: input.topic_id === 'T-父' && sentence.id === 'S0' ? '不支撑' : '完整支撑',
    missing: input.topic_id === 'T-父' && sentence.id === 'S0' ? '旧标题没有成员依据。' : null })) }))
  const pageFile = path.join(f.root, 'objects/pages', f.manifest.pages![parent]!.slice(7) + '.md')
  const before = await readFile(pageFile), done = (await upgradeLibrary(f.root, client.upgradeOptions))!
  expect(done.status).toBe('complete')
  expect(await readFile(pageFile)).toEqual(before)
  expect(calls.filter(input => input.topic_id === 'T-父')).toHaveLength(1)
  expect(calls.filter(input => input.topic_id === 'T-子')).toHaveLength(1)
  expect(done.accepted).toEqual({})
  const provenance = await readProvenance(f.root, 'v000001', (JSON.parse(await readFile(path.join(f.root, 'versions/v000001.json'), 'utf8'))).checksum)
  expect(provenance).toHaveProperty(['pendingTopicReviews', parent])
  const pending = (provenance as unknown as { pendingTopicReviews: Record<string, { status: string; sentences: unknown[] }> }).pendingTopicReviews[parent]!
  expect(pending.status).toBe('unverified')
  expect(pending.sentences).toContainEqual(expect.objectContaining({ id: 'S0', support: '不支撑', missing: '旧标题没有成员依据。' }))
  await verifyUpgradeBackup(done.backupPath)
  const objects = Object.values(Object.values(done.reviewSettled!)[0]!.objects)
  expect(objects.map(object => object.outcome.kind).sort()).toEqual(['accepted', 'pending'])
  await upgradeLibrary(f.root, client.upgradeOptions)
  expect(calls).toHaveLength(2)
})

it('标题范围导航与正文均被完整拒绝时只核对首轮，原范围不预改写', async () => {
  const f = await evidenceFixture(), content = '# 旧标题\n\n范围：按成员证据阅读。\n\n原始正文主张。\n\n## 子主题导航\n\n- [旧子页](T-父/T-子.md) — 旧划分描述。\n'
  f.manifest.pages![parent] = await putPage(f.root, content); await f.save()
  const { client, calls } = offlineClient(f, input => verdicts(input, true))
  const done = (await upgradeLibrary(f.root, client.upgradeOptions))!
  expect(done.status).toBe('complete'); expect(done.accepted).toEqual({}); expect(calls).toHaveLength(1)
  expect(calls[0]!.sentences.map(sentence => sentence.text)).toContain('范围：按成员证据阅读。')
  const file = path.join(f.root, 'objects/pages', f.manifest.pages![parent]!.slice(7) + '.md')
  expect(await readFile(file, 'utf8')).toBe(content)
  const record = Object.values(Object.values(done.reviewSettled!)[0]!.objects)[0]!.outcome
  expect(record.kind).toBe('pending')
  if (record.kind === 'pending') expect(record.records[0]!.sentences).toHaveLength(calls[0]!.sentences.length)
})

it('协议缺项属于未完成，保持旧格式且不写待核实', async () => {
  const f = await evidenceFixture(), { client, calls } = offlineClient(f, input => ({ items: verdicts(input).items.slice(1) }))
  await expect(upgradeLibrary(f.root, client.upgradeOptions)).rejects.toMatchObject({ code: 'UPGRADE_REVIEW_PAUSED' })
  const state = (await readUpgradeStatus(f.root))!
  expect(state.status).toBe('paused'); expect(state.accepted).toEqual({})
  expect(state.reviewSettled).toBeUndefined(); expect(calls).toHaveLength(1)
  expect(JSON.parse(await readFile(path.join(f.root, '.llmwiki/policy.json'), 'utf8')).libraryFormat).toBeUndefined()
})

async function pausedAfterPending() {
  const f = await evidenceFixture()
  delete f.manifest.deps!.pages[child]!.review; await f.save()
  let incomplete = true
  const result = offlineClient(f, input => input.topic_id === 'T-父' ? verdicts(input, true)
    : incomplete ? { items: [] } : verdicts(input))
  await expect(upgradeLibrary(f.root, result.client.upgradeOptions)).rejects.toMatchObject({ code: 'UPGRADE_REVIEW_PAUSED' })
  return { ...f, ...result, resume: () => { incomplete = false } }
}
it('拒绝对象即时落盘，后续对象中断后续跑零重调已闭合对象并累计用量', async () => {
  const f = await pausedAfterPending(), before = (await readUpgradeStatus(f.root))!
  expect(before.actual.calls).toBe(2); expect(before.accepted).toEqual({})
  expect(Object.keys(Object.values(before.reviewSettled!)[0]!.objects)).toHaveLength(1)
  f.resume()
  const done = (await upgradeLibrary(f.root, f.client.upgradeOptions))!
  expect(done.status).toBe('complete'); expect(done.actual.calls).toBe(3)
  expect(f.calls.filter(input => input.topic_id === 'T-父')).toHaveLength(1)
  expect(f.calls.filter(input => input.topic_id === 'T-子')).toHaveLength(2)
  expect(done.id).toBe(before.id); expect(done.backupPath).toBe(before.backupPath)
})

it('续跑前篡改待核实对象绑定明确拒绝，不能静默重调或接受', async () => {
  const f = await pausedAfterPending(), state = (await readUpgradeStatus(f.root))!
  const saved = Object.values(Object.values(state.reviewSettled!)[0]!.objects)[0]!.outcome
  if (saved.kind !== 'pending') throw new Error('夹具缺少待核实对象')
  saved.records[0]!.objectDigest = 'sha256:' + '0'.repeat(64)
  await writeJson(f.root, 'work/upgrade-0.3.0.json', state)
  f.resume()
  await expect(upgradeLibrary(f.root, f.client.upgradeOptions)).rejects.toMatchObject({ code: 'UPGRADE_CHECKPOINT_CORRUPT' })
  expect(f.calls).toHaveLength(2)
})
