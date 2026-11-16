import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { emptyRegistry } from '../src/domain/config.js'
import { defaultPolicy } from '../src/domain/policy.js'
import { createBuildModelClient } from '../src/host/models.js'
import { writeJson } from '../src/layered/files.js'
import { putPage } from '../src/layered/objects.js'
import { readerLeaseMs } from '../src/layered/retention.js'
import { readUpgradeStatus, upgradeLibrary } from '../src/layered/upgrade.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { child, evidenceFixture, parent } from './upgrade-evidence-fixture.js'

beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('根收缩回归禁止网络') })))
afterEach(() => vi.unstubAllGlobals())

async function pausedRootShrink() {
  const f = await evidenceFixture(), current = structuredClone(f.manifest), leasePage = 'topics/T-租约.md'
  current.version = 'v000002'; delete current.deps!.pages[child]!.review
  for (const dependency of Object.values(current.deps!.pages)) for (const link of dependency.children ?? []) link.version = current.version
  const old = structuredClone(f.manifest)
  old.pages = { [leasePage]: await putPage(f.root, '# T-租约\n\n项目乙资料。\n') }
  old.deps = { pages: { [leasePage]: { sources: [f.source.source_id], points: [] } }, reverse: {} }
  await f.save(old); await f.save(current)
  await writeJson(f.root, 'state/current.json', { version: current.version, revocation_generation: 0, history: [] })
  const lease = { pid: process.pid, device: '离线设备', version: old.version, expires_at: Date.now() + readerLeaseMs }
  await writeJson(f.root, 'state/readers/shrink.json', lease)
  let incomplete = true
  const calls: string[] = [], policy = defaultPolicy(); policy.batchDelayMs = 0; policy.maxTokensPerCall = 512
  const runtime: ModelRuntime = {
    resolveModelInfo: vi.fn(async (provider, id) => ({ provider, id, name: id, context: { contextWindow: 131072 } })),
    stream: vi.fn(async function* (request) {
      const part = request.messages[0]!.content[0]!
      if (part.type !== 'text') throw new Error('只接受离线文本')
      const input = JSON.parse(part.text); calls.push(input.topic_id)
      yield { type: 'usage' as const, usage: { inputTokens: 11, outputTokens: 5 } }
      yield { type: 'text-delta' as const, index: 0, text: JSON.stringify({ items: incomplete && input.topic_id === 'T-子' ? []
        : input.sentences.map((sentence: { id: string }) => ({ id: sentence.id, support: input.topic_id === 'T-父' ? '不支撑' : '完整支撑',
          missing: input.topic_id === 'T-父' ? '旧主张缺少支撑。' : null })) }) }
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
    }),
  }
  const client = createBuildModelClient(runtime, f.library, policy, { ...emptyRegistry(), upgrade: { maxCalls: 8 } })
  await expect(upgradeLibrary(f.root, client.upgradeOptions)).rejects.toMatchObject({ code: 'UPGRADE_REVIEW_PAUSED' })
  const paused = (await readUpgradeStatus(f.root))!, originalStep = paused.steps[0]!, original = Object.values(paused.reviewSettled![originalStep.id]!.objects)[0]!
  expect(original.outcome.kind).toBe('pending'); expect(calls).toEqual(['T-父', 'T-子'])
  return { ...f, current, client, calls, paused, originalStep, original, resume: async () => {
    lease.expires_at = Date.now() - 1; await writeJson(f.root, 'state/readers/shrink.json', lease); incomplete = false
  } }
}

it('租约到期收缩混合步骤后，沿原任务与旧stepId复用待核实对象而不重复消费', async () => {
  const f = await pausedRootShrink(), { current, client, calls, originalStep, original } = f
  await f.resume()
  const done = (await upgradeLibrary(f.root, client.upgradeOptions))!
  expect(done.status).toBe('complete'); expect(done.actual.calls).toBe(3)
  expect(calls).toEqual(['T-父', 'T-子', 'T-子'])
  expect(done.steps[0]!.reviewOrigin!.id).toBe(originalStep.id)
  const inherited = Object.values(done.reviewSettled![done.steps[0]!.id]!.objects).find(value => value.outcome.kind === 'pending')!
  expect(inherited.identity).toEqual(original.identity)
  if (original.outcome.kind === 'pending' && inherited.outcome.kind === 'pending') expect(inherited.outcome.records).toEqual(original.outcome.records)
  const version = JSON.parse(await readFile(path.join(f.root, 'versions/v000002.json'), 'utf8'))
  expect(version.manifest.pages[parent]).toBe(current.pages![parent])
})

it('范围收缩时来源证据输入真实变化仍在派发前拒绝，不能沿旧终态放行', async () => {
  const f = await pausedRootShrink()
  f.current.sources[0]!.metadata.title = '变化后的来源题名'
  await f.save(f.current); await f.resume()
  await expect(upgradeLibrary(f.root, f.client.upgradeOptions)).rejects.toMatchObject({ code: 'UPGRADE_CHECKPOINT_CORRUPT' })
  expect(f.calls).toEqual(['T-父', 'T-子'])
  expect((await readUpgradeStatus(f.root))!.status).toBe('paused')
})
