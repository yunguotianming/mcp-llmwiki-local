import { readFile, writeFile } from 'node:fs/promises'
import { writeJson } from '../src/layered/files.js'
import { readVersion, versionPage } from '../src/layered/objects.js'
import { safePath } from '../src/storage/paths.js'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareTopics } from '../src/layered/topics.js'
import * as publication from '../src/layered/publication.js'
import { registerTopicReviewWindowRequest } from '../src/layered/topic-recovery.js'
import { withRecovery } from '../src/layered/accepted.js'
import type { PendingBuild } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, hydratedState } from './layered-fixture.js'
import { pendingFixture, changeExtraction } from './pipeline-audit-fixture.js'
import { recoveryFixture } from './b1-recovery-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it.each(['保留', '旧首锚点', '缺页', '接受对象损坏', '接受引用丢失'])('续时核对后发布中断，%s续跑只复用原成果', async mode => {
  const f = await pendingFixture(), target = f.pending.topics!.state.topics[0]!
  const text = await readFile(await safePath(f.root, f.pending.manifest.sources[0]!.files.source), 'utf8')
  await changeExtraction(f, extraction => {
    for (const point of extraction.segments.flatMap(segment => segment.points))
      point.evidence.push({ ...point.evidence[0]!, locator: 'L1-L1', quote: text.split('\n')[0]! })
  })
  delete f.pending.topics!.pages[target.path]
  f.pending.topics!.gaps = [{ topic_id: target.id, point_ids: target.point_ids, message: 'Connection error.' }]
  const recovery = recoveryFixture(f.root, f.client)
  const options = { ...f.options, recovery: recovery.bindings, automaticRecovery: true }
  const prepare = (pending: PendingBuild, retryTopics?: typeof f.options.retryTopics) => withRecovery(f.root, pending, { ...options, ...(retryTopics ? { retryTopics } : {}) }, active => prepareTopics(f.root, pending, f.committed, active, undefined))
  f.call.mockImplementation(async (...args) => {
    if (JSON.parse(args[2]).topic_id === target.id && JSON.parse(args[2]).review_stage) throw Object.assign(new Error('核对暂停'), { budgetPause: true })
    return f.original(...args)
  })
  await expect(prepare(f.pending, { topicIds: [target.id] })).rejects.toThrow('核对暂停')
  let pending = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
  pending.topics!.repairs![target.id]!.deadline = 0
  const retryTopics = { topicIds: [target.id], renewReviewWindow: true, requestId: '续时' }
  registerTopicReviewWindowRequest(pending, retryTopics)
  f.call.mockImplementation(f.original)
  await prepare(pending)
  const publish = vi.spyOn(publication, 'publishLibrary').mockRejectedValueOnce(new Error('发布中断'))
  await expect(publication.publishLibrary(f.root, pending)).rejects.toThrow('发布中断')
  publish.mockRestore()
  pending = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
  const page = structuredClone(pending.topics!.pages[target.path])
  const grant = structuredClone(pending.topic_scope!.review_windows)
  expect(pending.topics!.state.topics.find(topic => topic.id === target.id)?.page_status).toBe('ready')
  expect(pending.topic_scope!.completed).toContain(target.id)
  if (mode === '旧首锚点') pending.topics!.pages[target.path]!.content = page!.content.replace(/(\.md#\^p[a-f0-9]+)-2/g, '$1')
  if (['缺页', '接受对象损坏', '接受引用丢失'].includes(mode)) delete pending.topics!.pages[target.path]
  const reviewRef = (pending as any).acceptedRefs[`topic:${target.id}:review`]
  if (mode === '接受对象损坏') {
    const record = JSON.parse(await readFile(await safePath(f.root, reviewRef.path), 'utf8'))
    await writeFile(await safePath(f.root, record.output.path), '损坏')
  }
  if (mode === '接受引用丢失') delete (pending as any).acceptedRefs[`topic:${target.id}:review`]
  await writeJson(f.root, 'work/pending.json', pending)
  pending = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
  f.call.mockImplementation(async () => { throw new Error('不得调用模型') }); f.call.mockClear()
  if (mode === '接受对象损坏' || mode === '接受引用丢失') {
    await expect(prepare(pending, retryTopics)).rejects.toMatchObject({ code: mode === '接受对象损坏' ? 'ACCEPTED_CORRUPT' : 'TOPIC_COMPLETED_PAGE_MISSING' })
    expect(f.call).not.toHaveBeenCalled()
    expect(pending.topic_scope!.review_windows).toEqual(grant)
    return
  }
  await prepare(pending, retryTopics)
  expect(pending.topics!.pages[target.path]!.content).toBe(page!.content)
  expect(pending.topics!.pages[target.path]!.dependencies.review).toEqual(page!.dependencies.review)
  expect(pending.topics!.pages[target.path]!.dependencies.acceptedRef).toEqual(page!.dependencies.acceptedRef)
  // 页面续跑时可能只记本段调用；缺页恢复则沿用原接受输出中的输入预算记录。
  const generationRef = page!.dependencies.acceptedRef!
  const generationRecord = JSON.parse(await readFile(await safePath(f.root, generationRef.path), 'utf8'))
  const generation = JSON.parse(await readFile(await safePath(f.root, generationRecord.output.path), 'utf8'))
  expect(pending.topics!.pages[target.path]!.dependencies.calls).toEqual(mode === '缺页' ? generation.calls : page!.dependencies.calls)
  expect(pending.topics!.pages[target.path]!.dependencies.claims).toEqual(page!.dependencies.claims)
  expect(pending.topic_scope!.review_windows).toEqual(grant)
  await publication.publishLibrary(f.root, pending)
  expect(await versionPage(f.root, await readVersion(f.root, pending.version!), target.path)).toContain('# 甲组主题')
  expect(f.call).not.toHaveBeenCalled()
})
