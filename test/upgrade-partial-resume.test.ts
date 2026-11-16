import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createBuildModelClient } from '../src/host/models.js'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { defaultPolicy } from '../src/domain/policy.js'
import { hash, writeJson } from '../src/layered/files.js'
import { putPage } from '../src/layered/objects.js'
import { storageJson } from '../src/layered/vectors.js'
import { createExecutionLedger, readRunCosts, usageTokens } from '../src/layered/costs.js'
import { readProtocol, writeProtocol } from '../src/layered/models.js'
import { readUpgradeStatus, upgradeLibrary, verifyUpgradeBackup } from '../src/layered/upgrade.js'
import type { AcceptanceSnapshot, AcceptedRecord, Extraction } from '../src/layered/schema.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { legacyFixture } from './b3-fixture.js'

const evidence = path.join(tmpdir(), 'llmwiki-upgrade-estimate-20261116')
beforeEach(() => vi.stubGlobal('fetch', vi.fn(() => { throw new Error('部分恢复回归禁止网络') })))
afterEach(() => vi.unstubAllGlobals())

async function snapshot(root: string, files?: string[]) {
  const names = files ?? (await readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
    .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)))
  return Object.fromEntries(await Promise.all(names.sort().map(async name => [name, hash(await readFile(path.join(root, name)))])))
}

async function fixture(stage: 'extractionReview' | 'topicReview') {
  const f = await legacyFixture('0.2.1')
  for (const [index, source] of f.manifest.sources.entries()) {
    const text = await readFile(path.join(f.root, source.files.source), 'utf8')
    const segment = { locator: 'L1-L1', start: 0, end: text.length, text_hash: source.content_hash }
    source.segments = [segment]
    const point = { point_id: `${source.source_id}:P1`, text, text_hash: hash(text), section: '主要发现' as const,
      locator: 'L1-L1', source_version: source.source_version,
      evidence: [{ source_id: source.source_id, source_version: source.source_version, locator: 'L1-L1', quote: text }],
      ...(stage === 'topicReview' ? { verification: { status: 'verified' as const, missing: '', fingerprint: '历史通过' } } : {}) }
    const extraction: Extraction = { format_version: 1, source_id: source.source_id, source_hash: source.content_hash,
      processing: source.extract.processing, metadata: source.metadata, calls: [],
      segments: [{ ...segment, resource_hashes: [], processing_fingerprint: hash(text), terms: [], points: [point] }] }
    await writeJson(f.root, source.extract.path, extraction)
    if (stage === 'topicReview') {
      const page = `topics/T-${index + 1}.md`
      f.manifest.pages![page] = await putPage(f.root, `# 主题${index + 1}\n\n${text}\n`)
      f.manifest.deps!.pages[page] = { sources: [source.source_id], points: [{ point_id: point.point_id, text_hash: point.text_hash }] }
    }
  }
  await writeJson(f.root, 'versions/v000001.json', { manifest: f.manifest, checksum: hash(storageJson(f.manifest)) })
  const library = newLibrary('夹具库'), policy = defaultPolicy(), registry = emptyRegistry()
  library.wikiPath = f.root; library.sourceRoots = [f.parent]; library.models.unified = { provider: 'offline', model: 'review' }
  library.models.layeredRoutes = {}; library.models.fallbacks = []
  library.models.providerProfiles.offline = { concurrency: 1, retryLimit: 0, backoffMs: 0, cacheMode: 'none' }
  policy.batchDelayMs = 0; policy.pageGenerationConcurrency = 1; policy.maxTokensPerCall = 512
  const keys = stage === 'extractionReview' ? ['S-0001', 'S-0002'] : ['T-1', 'T-2']
  const calls: { key: string; failed: boolean }[] = []
  const stream = vi.fn(async function* (request: Parameters<ModelRuntime['stream']>[0]) {
    const message = request.messages[0]!.content[0]!
    if (message.type !== 'text') throw new Error('只允许离线文本')
    const data = JSON.parse(message.text), key = data.source_id ?? data.topic_id
    const failed = key === keys[1] && !calls.some(call => call.key === key)
    calls.push({ key, failed })
    // 第二对象的首次派发在读流时中断；保留真实失败 usage，且不启动语义纠正。
    yield { type: 'usage' as const, usage: { inputTokens: 11, outputTokens: 5 } }
    if (failed) {
      yield { type: 'finish' as const, reason: { kind: 'error' as const, failure: { code: 'EIO', message: '离线模拟第二对象读流失败' } } }
      return
    }
    yield { type: 'text-delta' as const, index: 0, text: JSON.stringify({ items: (data.points ?? data.sentences).map((item: { id: string }) => ({ id: item.id, support: '完整支撑', missing: null })) }) }
    yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
  })
  const runtime: ModelRuntime = { resolveModelInfo: vi.fn(async (provider, id) => ({ provider, id, name: id, context: { contextWindow: 131072 } })), stream }
  const client = () => createBuildModelClient(runtime, library, policy, { ...registry, upgrade: { maxCalls: 3 } })
  const oldFiles = [...new Set(['versions/v000001.json', ...f.manifest.sources.flatMap(source => [source.files.source, source.extract.path]),
    ...Object.values(f.manifest.pages!).map(digest => `objects/pages/${digest.slice(7)}.md`)])]
  return { ...f, stage, keys, calls, stream, client, oldFiles }
}

async function check(stage: 'extractionReview' | 'topicReview') {
  const f = await fixture(stage), before = await snapshot(f.root, f.oldFiles)
  await expect(upgradeLibrary(f.root, f.client().upgradeOptions)).rejects.toThrow('离线模拟第二对象读流失败')
  const paused = (await readUpgradeStatus(f.root))!, costsBefore = await readRunCosts(f.root, paused.id)
  expect(paused.status).toBe('paused'); expect(paused.steps).toHaveLength(1); expect(paused.steps[0]!.unitIds).toHaveLength(2)
  expect(paused.accepted).toEqual({}); expect(f.calls).toEqual([{ key: f.keys[0], failed: false }, { key: f.keys[1], failed: true }])
  expect(costsBefore.total.calls).toBe(2); expect(usageTokens(costsBefore.total.usage)).toBe(32)
  const tasks = await readdir(path.join(f.root, 'work/accepted/tasks'))
  expect(tasks).toHaveLength(1)
  const firstRecord = JSON.parse(await readFile(path.join(f.root, 'work/accepted/tasks', tasks[0]!), 'utf8')) as AcceptedRecord
  const acceptanceFile = `logs/model-accepts/${firstRecord.taskId.slice(2)}.json`
  if (stage === 'extractionReview') {
    // 模拟对象接受已准备、提交前中断；预检只能读取，正式续跑才允许恢复绑定。
    const accepted = (await readProtocol<AcceptanceSnapshot>(f.root, acceptanceFile, 'ACCEPT_PREPARE_CORRUPT'))!
    await writeProtocol(f.root, acceptanceFile, { ...accepted, status: 'prepared', acceptedDigest: null })
    await unlink(path.join(f.root, 'work/accepted/tasks', tasks[0]!))
  }
  const beforePreflight = await snapshot(f.root), preview = await f.client().upgradeOptions!.estimateReview!(paused.steps[0]!, f.root)
  expect(preview.calls).toBe(1); expect(f.calls).toHaveLength(2)
  expect(await snapshot(f.root)).toEqual(beforePreflight)
  const acceptanceBeforeResume = await createExecutionLedger(f.root).readAcceptance(firstRecord.taskId)
  expect(acceptanceBeforeResume.status).toBe(stage === 'extractionReview' ? 'prepared' : 'bound')
  await verifyUpgradeBackup(paused.backupPath)
  const backupBefore = await snapshot(paused.backupPath), done = (await upgradeLibrary(f.root, f.client().upgradeOptions))!
  const after = await snapshot(f.root, f.oldFiles), backupAfter = await snapshot(done.backupPath), costsAfter = await readRunCosts(f.root, done.id)
  const firstCalls = f.calls.filter(call => call.key === f.keys[0]).length, secondCalls = f.calls.filter(call => call.key === f.keys[1]).length
  const result = { stage, upgradeIdBefore: paused.id, upgradeIdAfter: done.id, backupBefore: paused.backupPath, backupAfter: done.backupPath,
    statusBefore: paused.status, statusAfter: done.status, limits: done.limits, acceptedBefore: paused.accepted, acceptedAfter: done.accepted,
    calls: f.calls, firstCalls, secondCalls, preview, acceptanceBeforeResume: acceptanceBeforeResume.status, preflightReadOnly: true,
    costsBefore, costsAfter, oldObjectsUnchanged: JSON.stringify(before) === JSON.stringify(after),
    backupUnchanged: JSON.stringify(backupBefore) === JSON.stringify(backupAfter), oldObjectHashesBefore: before, oldObjectHashesAfter: after,
    backupHashesBefore: backupBefore, backupHashesAfter: backupAfter }
  await mkdir(evidence, { recursive: true }); await writeFile(path.join(evidence, `partial-resume-fixed-${stage}.json`), JSON.stringify(result, null, 2) + '\n')
  expect(done).toMatchObject({ status: 'complete', id: paused.id, backupPath: paused.backupPath, limits: { maxCalls: 3 } })
  expect(after).toEqual(before); expect(backupAfter).toEqual(backupBefore); await verifyUpgradeBackup(done.backupPath)
  expect(costsAfter.total.calls).toBe(f.calls.length); expect(usageTokens(costsAfter.total.usage)).toBe(16 * f.calls.length)
  expect(secondCalls).toBe(2)
  const outer = JSON.parse(await readFile(path.join(f.root, Object.values(done.accepted)[0]!.path), 'utf8')) as AcceptedRecord
  expect(outer.dependencies).toHaveLength(2)
  expect(outer.identity.scope.unitId).toBe(paused.steps[0]!.id); expect(outer.identity.inputDigest).toBe(paused.steps[0]!.inputDigest)
  expect((await createExecutionLedger(f.root).readAcceptance(firstRecord.taskId)).status).toBe('bound')
  expect(firstCalls).toBe(1); expect(done.actual.calls).toBe(3)
}

it('提取2对象同一步骤第二对象失败后，续跑复用第一对象且失败成本累计', () => check('extractionReview'), 60000)
it('主题2对象同一步骤第二对象失败后，续跑复用第一对象且失败成本累计', () => check('topicReview'), 60000)
