import { afterEach, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { prepareTopics } from '../src/layered/topics.js'
import { publishLibrary, readCurrent, readManifest } from '../src/layered/publication.js'
import { recoverTopicIdentities, topicGapDiagnostics } from '../src/layered/topic-recovery.js'
import { topicPath } from '../src/layered/schema.js'
import { safePath } from '../src/storage/paths.js'
import { pendingFixture } from './pipeline-audit-fixture.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'
import { emptyRegistry } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { libraryProductionStatus } from '../src/host/library-status.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => cleanupLayeredFixtures())

it.each([
  ['发布前普通续跑', false, false], ['发布前重试缺口', false, true],
  ['发布后普通续跑', true, false], ['发布后重试缺口', true, true],
] as const)('%s保留原身份并恢复父链，成功分支不重复生成', async (_name, published, retry) => {
  const f = await pendingFixture(), build = f.pending.topics!
  const parent = build.state.topics.find(topic => topic.id === 'T-0001')!
  const child = { ...structuredClone(parent), id: 'T-0001-01', path: topicPath('T-0001-01'), parent_id: parent.id }
  parent.direct_point_ids = []; build.state.topics.push(child)
  delete build.pages[parent.path]
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (input.topic_id === child.id && !input.review_stage) throw new Error('Connection error.')
    return f.original(...args)
  })
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(f.pending.manifest.topic_recovery!.topics.map(topic => topic.id)).toEqual(expect.arrayContaining([parent.id, child.id]))
  if (published) {
    await publishLibrary(f.root, f.pending, undefined, true, f.options)
    await expect(readFile(await safePath(f.root, 'work/pending.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const manifest = await readManifest(f.root, await readCurrent(f.root))
    expect(recoverTopicIdentities(manifest).find(topic => topic.id === child.id)?.parent_id).toBe(parent.id)
    f.library.wikiPath = f.root
    const store = new LibraryStore(() => ({ ...emptyRegistry(), libraries: [f.library] }))
    const status = await libraryProductionStatus(store, f.library.id)
    expect(status.topicGaps.find(gap => gap.topic_id === child.id)).toMatchObject({ category: '补跑可补', effect: '整页阻塞', stage: 'generate' })
  }
  f.call.mockImplementation(f.original); f.call.mockClear(); f.topicRequests.splice(0)
  if (published) await buildLayeredLibrary({ ...f.options, retryGaps: retry })
  else await prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryGaps: retry }, undefined)
  expect(f.topicRequests.map(request => request.input.topic_id)).toEqual([child.id, parent.id])
  if (published) {
    const manifest = await readManifest(f.root, await readCurrent(f.root))
    expect(manifest.pages).toHaveProperty(child.path)
    expect(manifest.pages).toHaveProperty(parent.path)
    f.call.mockClear()
    await buildLayeredLibrary(f.options)
  } else {
    expect(f.pending.topics!.pages).toHaveProperty(child.path)
    expect(f.pending.topics!.pages).toHaveProperty(parent.path)
    f.call.mockClear()
    await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  }
  expect(f.call).not.toHaveBeenCalled()
}, 30000)

it('删句通知、来源门槛、整页失败分别诊断，原原因不丢失', async () => {
  const f = await pendingFixture(), topic = f.pending.topics!.state.topics[0]!
  f.pending.topics!.gaps = [
    { topic_id: topic.id, point_ids: topic.point_ids, message: '删除未支撑句：无据句', reasons: [{ sentence_id: 'S2', text: '无据句', reason: '证据不完整' }] },
    { topic_id: 'T-0080', point_ids: [], message: '来源数不足新主题门槛', kind: 'below-threshold' },
    { topic_id: 'T-0081', point_ids: topic.point_ids, message: 'Connection error.' },
  ]
  const diagnostics = topicGapDiagnostics(f.pending.manifest, f.pending.topics)
  expect(diagnostics.map(item => [item.category, item.effect])).toEqual([
    ['需改代码', '质量审计通知'], ['正常门槛', '来源层保留'], ['补跑可补', '整页阻塞'],
  ])
  expect(diagnostics[0]!.reasons).toEqual(f.pending.topics!.gaps[0]!.reasons)
  f.pending.topics!.repairs = { 'T-0081': { protocol: '测试协议', input: '', evidence: '', content: '当前稿', member_ids: topic.point_ids,
    stage: 'metadata', run_id: '离线运行', rounds: 2, total_rounds: 2, max_rounds: 6, deadline: Date.now() + 1000 } }
  expect(topicGapDiagnostics(f.pending.manifest, f.pending.topics)[2]!.stage).toBe('metadata')
})
