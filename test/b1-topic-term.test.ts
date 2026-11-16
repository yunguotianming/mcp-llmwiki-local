import { readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { prepareTopics } from '../src/layered/topics.js'
import { prepareTerms } from '../src/layered/terms.js'
import { withRecovery } from '../src/layered/accepted.js'
import type { AcceptedRef, RecoveryPending } from '../src/layered/accepted.js'
import type { BuildLayeredOptions, SnapshotManifest, TermSection } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, hydratedState, layeredIncrementalFixture, mockSupportReview, snapshotManifest } from './layered-fixture.js'
import { recoveryFixture } from './b1-recovery-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

async function fixture(count = 3, settings: Exclude<BuildLayeredOptions['topics'], false> = {}, repeat = 1) {
  const base = await layeredIncrementalFixture(), original = base.call.getMockImplementation()!
  base.options.topics = { topicMergeMinSources: 1, termThreshold50: 2, ...settings }
  const respond: BuildLayeredOptions['client']['call'] = async (...args) => {
    const input = JSON.parse(args[2]), support = mockSupportReview(input)
    if (support) return support
    if (input.term_id) return JSON.stringify({ definition: [{ text: '共同术语定义。', keys: input.contributions.map((item: { key: string }) => item.key) }], usage: [], findings: [], differences: [] })
    if (input.synthesis_stage?.startsWith('member-')) return JSON.stringify({ title: '甲组主题', summary: '共同范围', aliases: [], removed_members: [], consensus: [], differences: [],
      conditions: [{ text: '完整成员共同适用。', point_ids: input.points.map((item: { point_id: string }) => item.point_id) }] })
    const output = JSON.parse(await original(...args))
    if (input.paragraphs) output.terms = input.paragraphs.filter((item: { text?: string }) => item.text && !item.text.startsWith('#')).map((item: { paragraph_id: number; locator: string; text: string }) => ({
      paragraph_id: item.paragraph_id, name: '共同术语', referent: '同一稳定方法', category: '方法', aliases: [], locator: item.locator, note: item.text,
    }))
    return JSON.stringify(output)
  }
  base.call.mockImplementation(async (...args) => {
    if (JSON.parse(args[2]).topic_id) throw Object.assign(new Error('保留提取检查点'), { name: 'AbortError' })
    return respond(...args)
  })
  for (let index = 0; index < count; index++) await writeFile(path.join(base.knowledgeRoot, `${index}.md`), `# 资料${index}\n\n` + `甲组第${index}项完整证据。`.repeat(repeat))
  await expect(buildLayeredLibrary(base.options)).rejects.toThrow('保留提取检查点')
  base.call.mockImplementation(respond); base.call.mockClear()
  const pending = await hydratedState<RecoveryPending>(base.root, 'work/pending.json')
  base.options.vectorIdentity = pending.manifest.vector_state?.identity
  const committed: SnapshotManifest = { format_version: pending.manifest.format_version, version: null, next_source_number: 1, revocation_generation: 0, sources: [] }
  const recovery = recoveryFixture(base.root, base.client)
  const topics = (replayOnly = false) => withRecovery(base.root, pending, { ...base.options, recovery: recovery.bindings, replayOnly },
    options => prepareTopics(base.root, pending, committed, options, undefined))
  const terms = (replayOnly = false) => withRecovery(base.root, pending, { ...base.options, recovery: recovery.bindings, replayOnly },
    options => prepareTerms(base.root, pending, committed, options))
  return { ...base, pending, committed, recovery, topics, terms }
}

it('叶页父页及核对跨模型离线恢复，prepared 核对在预算解析前提交', async () => {
  const f = await fixture(3, { topicMaxSources: 2, topicMaxDepth: 1, topicMaxChildren: 2 })
  const prepare = f.recovery.bindings.hooks.prepareAccepted
  let interrupted = false
  f.recovery.bindings.hooks.prepareAccepted = async request => {
    const result = await prepare(request)
    if (!interrupted && request.record.identity.stage === 'topicReview' && request.record.identity.scope.unitId === 'topic:T-0001:review') {
      interrupted = true; throw new Error('父页核对 prepared 中断')
    }
    return result
  }
  await expect(f.topics()).rejects.toThrow('父页核对 prepared 中断')
  expect(f.recovery.identities.some(identity => identity.stage === 'topic')).toBe(true)
  expect(f.recovery.identities.some(identity => identity.stage === 'parent')).toBe(true)
  f.recovery.bindings.hooks.prepareAccepted = prepare
  f.library.models.unified.model = '其他模型'; f.call.mockClear()
  vi.mocked(f.recovery.bindings.stageInputBudgets).mockClear()
  vi.spyOn(f.client, 'info').mockRejectedValue(new Error('目录离线'))
  await f.topics(true)
  expect(f.call).not.toHaveBeenCalled(); expect(f.client.info).not.toHaveBeenCalled()
  expect(f.recovery.bindings.stageInputBudgets).not.toHaveBeenCalled()
  expect(Object.keys(f.pending.topics!.pages)).toHaveLength(3)
  for (const page of Object.values(f.pending.topics!.pages)) {
    expect(page.dependencies).toHaveProperty('acceptedRef')
    expect(page.dependencies.review).toHaveProperty('acceptedRef')
  }
})

it('术语 prepared 中断后换模型离线补分节及依赖引用', async () => {
  const f = await fixture(2)
  f.recovery.failPrepare(true)
  await expect(f.terms()).rejects.toThrow('准备后中断')
  f.recovery.failPrepare(false); f.call.mockClear()
  f.library.models.unified.model = '其他模型'
  vi.mocked(f.recovery.bindings.stageInputBudgets).mockClear()
  vi.spyOn(f.client, 'info').mockRejectedValue(new Error('目录离线'))
  await f.terms(true)
  expect(f.call).not.toHaveBeenCalled(); expect(f.client.info).not.toHaveBeenCalled()
  expect(f.recovery.bindings.stageInputBudgets).not.toHaveBeenCalled()
  const section = f.pending.terms!.records[0]!.sections[0]! as TermSection & { acceptedRef: AcceptedRef }
  expect(section.acceptedRef.taskId).toMatch(/^t:/)
  expect(Object.values(f.pending.terms!.section_dependencies)[0]).toHaveProperty('acceptedRef', section.acceptedRef)
})

it('主题小窗口保留已接受块，只细分未完成成员并保留完整事实', async () => {
  const f = await fixture(12, { topicReview: false, topicMaxChars: 10000 }, 15)
  f.recovery.setWindow(6500)
  const prepare = f.recovery.bindings.hooks.prepareAccepted
  let acceptedInput: string | undefined
  f.recovery.bindings.hooks.prepareAccepted = async request => {
    const result = await prepare(request)
    if (!acceptedInput && request.record.identity.operation === 'synthesizeTopicBlock') {
      acceptedInput = f.call.mock.calls.at(-1)![2]
      throw new Error('第一成员块 prepared 中断')
    }
    return result
  }
  await expect(f.topics()).rejects.toThrow('第一成员块 prepared 中断')
  const before = JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8')).topics.synthesis_plans
  expect(Object.values(before).flat().length).toBeGreaterThan(1)
  f.recovery.bindings.hooks.prepareAccepted = prepare; f.recovery.setWindow(3300); f.call.mockClear()
  await f.topics()
  expect(f.call.mock.calls.every(args => args[2] !== acceptedInput)).toBe(true)
  expect(Object.keys(f.pending.topics!.pages)).toHaveLength(1)
  const after = (f.pending.topics as unknown as { synthesis_plans: Record<string, string[][]> }).synthesis_plans
  expect(Object.values(after).flat().flat().sort()).toEqual(Object.values(before).flat(2).sort())
  expect(Object.values(after).flat().length).toBeGreaterThan(Object.values(before).flat().length)
})

it('仅核对规则变化复用叶父综合，内容规则变化建立新接受任务', async () => {
  const f = await fixture(3, { topicMaxSources: 2, topicMaxDepth: 1, topicMaxChildren: 2 })
  await f.topics(); f.call.mockClear()
  const accepted = Object.values(f.pending.topics!.pages).map(page => (page.dependencies as { acceptedRef?: AcceptedRef }).acceptedRef!.taskId)
  f.options.topics = { ...f.options.topics || {}, contradictionReview: true }
  await f.topics()
  expect(f.call).toHaveBeenCalled()
  expect(f.call.mock.calls.every(args => Boolean(JSON.parse(args[2]).review_stage))).toBe(true)
  expect(Object.values(f.pending.topics!.pages).map(page => (page.dependencies as { acceptedRef?: AcceptedRef }).acceptedRef!.taskId)).toEqual(accepted)
  f.options.topics = { ...f.options.topics, topicMaxChars: 11000 }; f.call.mockClear()
  await f.topics()
  expect(f.call.mock.calls.some(args => JSON.parse(args[2]).topic_id && !JSON.parse(args[2]).review_stage)).toBe(true)
  expect(Object.values(f.pending.topics!.pages).map(page => (page.dependencies as { acceptedRef?: AcceptedRef }).acceptedRef!.taskId)).not.toEqual(accepted)
})

it('未完成术语完整贡献装不下时暂停，成功分节仍保留', async () => {
  const f = await fixture(3, { termMaxSources: 1 })
  const prepare = f.recovery.bindings.hooks.prepareAccepted
  let count = 0
  f.recovery.bindings.hooks.prepareAccepted = async request => {
    const result = await prepare(request)
    if (++count === 2) throw new Error('第二术语分节 prepared 中断')
    return result
  }
  await expect(f.terms()).rejects.toThrow('第二术语分节 prepared 中断')
  const first = structuredClone(f.pending.terms!.records[0]!.sections[0]!)
  f.recovery.bindings.hooks.prepareAccepted = prepare; f.recovery.setWindow(1); f.call.mockClear()
  await expect(f.terms()).rejects.toMatchObject({ stagePause: true, stage: 'term' })
  expect(f.pending.terms!.records[0]!.sections[0]).toEqual(first)
  expect(f.call).not.toHaveBeenCalled()
  expect(f.pending.stagePause).toMatchObject({ stage: 'term', code: 'INPUT_TOO_LARGE' })
})

it('GC 后历史来源及页面可继续核对和综合，活动接受缺失仍报错', async () => {
  const f = await fixture(3, { topicMaxSources: 2, topicMaxDepth: 1, topicMaxChildren: 2 })
  await buildLayeredLibrary({ ...f.options, recovery: f.recovery.bindings, reextract: f.pending.manifest.sources.map(source => source.source_id) })
  const committed = await snapshotManifest(f.root)
  expect(committed.sources.every(source => 'acceptedRef' in source)).toBe(true)
  for (const directory of ['work/accepted/tasks', 'work/accepted/objects', 'logs/model-accepts']) {
    for (const file of await readdir(path.join(f.root, directory))) await unlink(path.join(f.root, directory, file))
  }
  const pending: RecoveryPending = { format_version: 2, base_version: committed.version, version: null, manifest: structuredClone(committed),
    card: committed.card!, added: [], model_calls: 0, started_at: '2026-11-14T00:00:00Z' }
  f.options.topics = { ...f.options.topics || {}, contradictionReview: true }
  const run = () => withRecovery(f.root, pending, { ...f.options, recovery: f.recovery.bindings }, async options => {
    await prepareTopics(f.root, pending, committed, options, undefined)
    await prepareTerms(f.root, pending, committed, options)
  })
  f.call.mockClear(); await run()
  expect(f.call).toHaveBeenCalled()
  expect(f.call.mock.calls.every(args => Boolean(JSON.parse(args[2]).review_stage))).toBe(true)
  f.options.topics = { ...f.options.topics, topicMaxChars: 11000, termMaxChars: 11000 }
  await run()
  expect(f.call.mock.calls.some(args => Boolean(JSON.parse(args[2]).term_id))).toBe(true)
  const active = pending.terms!.records.flatMap(record => record.sections)
    .map(section => (section as TermSection & { acceptedRef?: AcceptedRef }).acceptedRef)
    .find((ref): ref is AcceptedRef => Boolean(ref && Object.values(pending.acceptedRefs!).some(item => item.taskId === ref.taskId)))!
  expect(active).toBeDefined()
  await unlink(path.join(f.root, active.path))
  await expect(run()).rejects.toMatchObject({ code: 'ACCEPTED_MISSING' })
})
