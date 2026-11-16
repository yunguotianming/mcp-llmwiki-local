import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { extractSource, extractionProcessing } from '../src/layered/extraction.js'
import { readLocalSource } from '../src/layered/snapshot.js'
import { layeredSettings } from '../src/domain/config.js'
import { cleanupLayeredFixtures, layeredFixture, layeredIncrementalFixture, snapshotManifest } from './layered-fixture.js'
import { recoveryFixture } from './b1-recovery-fixture.js'
import type { Extraction } from '../src/layered/schema.js'
import { ModelClient } from '../src/llm/client.js'
import { withRecovery } from '../src/layered/accepted.js'
import type { AcceptedRef, RecoveryPending } from '../src/layered/accepted.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('主入口格式升级后无变化和换模型均零调用，目录不可用仍可续建', async () => {
  const f = await layeredFixture(), recovery = recoveryFixture(f.root, f.client)
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '原文包含可核实的完整结论。')
  const options = { ...f.options, recovery: recovery.bindings }
  await buildLayeredLibrary(options)
  const before = (await snapshotManifest(f.root)).sources[0]!
  const bytes = await readFile(path.join(f.root, before.extract.path))
  f.call.mockClear(); vi.mocked(recovery.bindings.callDetailed).mockClear()
  vi.spyOn(f.client, 'info').mockRejectedValue(new Error('模型目录离线'))
  f.library.models.unified.model = '另一模型'
  expect(await buildLayeredLibrary({ ...options, replayOnly: true })).toMatchObject({ unchanged: true, modelCalls: 0 })
  expect(await readFile(path.join(f.root, before.extract.path))).toEqual(bytes)
  expect(f.call).not.toHaveBeenCalled(); expect(f.client.info).not.toHaveBeenCalled()
})

it('只改主题规则仍复用旧提取，原始提取对象字节保持', async () => {
  const f = await layeredIncrementalFixture()
  const recovery = recoveryFixture(f.root, f.client)
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组完整结论一。')
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '甲组完整结论二。')
  await buildLayeredLibrary({ ...f.options, recovery: recovery.bindings })
  const old = (await snapshotManifest(f.root)).sources
  const bytes = await Promise.all(old.map(source => readFile(path.join(f.root, source.extract.path))))
  f.requests.length = 0; f.call.mockClear()
  f.options.topics = { ...f.options.topics || {}, topicMaxChars: layeredSettings().topicMaxChars + 100 }
  await buildLayeredLibrary({ ...f.options, recovery: recovery.bindings })
  expect(f.requests).toHaveLength(0)
  const next = (await snapshotManifest(f.root)).sources
  expect(next.map(source => source.extract.path)).toEqual(old.map(source => source.extract.path))
  expect(await Promise.all(next.map(source => readFile(path.join(f.root, source.extract.path))))).toEqual(bytes)
})

it('小窗口只拆未完成组，成功组原始结果配额和最终要点身份保持', async () => {
  const f = await layeredFixture(), file = path.join(f.knowledgeRoot, 'book.md')
  await writeFile(file, Array.from({ length: 8 }, (_, index) => `## 第${index + 1}章\n\n${('第' + index + '项事实和条件。').repeat(45)}\n\n${('第' + index + '项方法和证据。').repeat(45)}`).join('\n\n'))
  const source = await readLocalSource(file, 'Markdown 资料'), processing = extractionProcessing({ tier: 50, prompt_version: 'layered-extract-v5' })
  const options = { ...f.options, topics: { sourceChapterMinPoints: 0, embeddingMode: 'none' as const } }
  const recovery = recoveryFixture(f.root, f.client)
  const pending = { format_version: 2, base_version: null, version: null, manifest: { sources: [] }, added: [], started_at: '固定时间', model_calls: 0 } as unknown as RecoveryPending
  const run = (limit: number, saved?: Extraction, signal?: AbortSignal) => withRecovery(f.root, pending,
    { ...options, recovery: recovery.bindings, ...(signal ? { signal } : {}) }, active =>
      extractSource(f.root, 'S-0001', source, processing, active, limit, saved))
  const original = f.call.getMockImplementation() ?? ModelClient.prototype.call.bind(f.client), controller = new AbortController()
  let calls = 0
  f.call.mockImplementation(async (...args) => {
    if (++calls === 2) { controller.abort(new Error('中断以保留第一组')); throw controller.signal.reason }
    return original(...args)
  })
  await expect(run(11000, undefined, controller.signal)).rejects.toThrow()
  const directory = path.join(f.root, 'work/extractions/S-0001', source.contentHash.slice(7), 'extract')
  const name = (await readdir(directory)).find(name => name.endsWith('-progress.json'))!
  const saved = JSON.parse(await readFile(path.join(directory, name), 'utf8')) as Extraction
  const [key, success] = Object.entries(saved.group_cache!)[0]!
  expect(success).toBeDefined()
  const accepted = (success as typeof success & { acceptedRef: AcceptedRef }).acceptedRef
  expect(accepted).toBeDefined()
  const acceptedBytes = await readFile(path.join(f.root, accepted.path))
  const firstParts = success.parts.map(part => part.text)
  f.call.mockImplementation(original); f.requests.length = 0
  const result = await run(7000, saved)
  expect(await readFile(path.join(f.root, accepted.path))).toEqual(acceptedBytes)
  expect(result.group_cache![key]!.raw).toBe(success.raw)
  expect(result.group_cache![key]!.quota).toBe(success.quota)
  expect(result.chunk_plan).toEqual(saved.chunk_plan)
  expect(Object.keys(result.chunk_splits ?? {}).length).toBeGreaterThan(0)
  expect(f.requests.every(request => request.input.paragraphs.every(part => !firstParts.includes(part.text ?? '')))).toBe(true)
})

it('显式重提跨发布递增代次，重复续跑不会混用旧接受', async () => {
  const f = await layeredFixture(), recovery = recoveryFixture(f.root, f.client)
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '需要显式重提的固定原文。')
  const options = { ...f.options, recovery: recovery.bindings }
  await buildLayeredLibrary(options)
  const first = (await snapshotManifest(f.root)).sources[0]! as { source_id: string; acceptedRef: { taskId: string } }
  await buildLayeredLibrary({ ...options, reextract: [first.source_id] })
  const second = (await snapshotManifest(f.root)).sources[0]! as typeof first
  await buildLayeredLibrary({ ...options, reextract: [first.source_id] })
  const third = (await snapshotManifest(f.root)).sources[0]! as typeof first
  expect(new Set([first, second, third].map(source => source.acceptedRef.taskId)).size).toBe(3)
  expect(new Set(recovery.identities.filter(identity => identity.operation === 'extract').map(identity => identity.reextractGeneration))).toEqual(new Set([0, 1, 2]))
})

it('阶段能力暂停传播到检查点，完整证据不转成普通缺口', async () => {
  const f = await layeredFixture(), recovery = recoveryFixture(f.root, f.client)
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '完整原文不应被丢掉。')
  vi.mocked(recovery.bindings.stageInputBudgets).mockRejectedValue(Object.assign(new Error('没有兼容候选'), { stagePause: true, stage: 'extract', code: 'NO_COMPATIBLE_CANDIDATE' }))
  await expect(buildLayeredLibrary({ ...f.options, recovery: recovery.bindings })).rejects.toMatchObject({ stagePause: true })
  const pending = JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8'))
  expect(pending.acceptedProtocol).toBe(1)
  expect(pending.runId).toMatch(/^[a-f0-9-]{36}$/)
  expect(pending.stagePause.code).toBe('NO_COMPATIBLE_CANDIDATE')
  expect(recovery.bindings.callDetailed).not.toHaveBeenCalled()
})
