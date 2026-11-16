import * as fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import { prepareTopics, topicHeader, topicInputFingerprint } from '../src/layered/topics.js'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { hash, writeJson } from '../src/layered/files.js'
import { pageObjectPath, putPage } from '../src/layered/objects.js'
import { topicPath } from '../src/layered/schema.js'
import { readUpgradeStatus } from '../src/layered/upgrade.js'
import { safePath } from '../src/storage/paths.js'
import { cleanupLayeredFixtures, hydratedState } from './layered-fixture.js'
import { pendingFixture } from './pipeline-audit-fixture.js'
import { legacyFixture } from './b3-fixture.js'
import type { BuildLayeredOptions, PendingBuild, Topic } from '../src/layered/schema.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

async function oldPage(f: Awaited<ReturnType<typeof pendingFixture>>, topic: Topic, corrupt = false) {
  const build = f.pending.topics!, page = build.pages[topic.path]!, generation = hash('已封存的旧生产协议')
  const header = { ...topicHeader(page.content), generation_hash: generation,
    input_fingerprint: topicInputFingerprint(topic, build.state, build.point_hashes!, generation), ...(corrupt ? { id: '错误主题身份' } : {}) }
  delete header.generation_input_fingerprint
  page.content = page.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, `---\n${stringify(header).trimEnd()}\n---\n`)
  page.input_fingerprint = header.input_fingerprint
  delete page.generation_input_fingerprint; delete page.dependencies.review
  const content_id = await putPage(f.root, page.content)
  Object.assign(page, { content_id })
  return { page: structuredClone(page), content_id }
}

it('显式零目标在旧库首次写入升级前返回，目录和原清单逐字不变', async () => {
  const f = await legacyFixture('0.2.1'), call = vi.fn(async () => { throw new Error('禁止模型调用') })
  const before = await fs.readdir(f.root, { recursive: true })
  const options: BuildLayeredOptions = { knowledgeRoot: f.parent, wikiPath: f.root, topics: { embeddingMode: 'none' }, client: {
    call, info: async () => ({ provider: '离线', id: '桩', name: '桩' }) } }
  for (const retryTopics of [{ topicIds: [] }, { topicIds: ['T-不存在'] }, {}])
    expect(await buildLayeredLibrary({ ...options, retryTopics })).toMatchObject({ unchanged: true, modelCalls: 0, version: 'v000001' })
  expect(call).not.toHaveBeenCalled()
  expect(await readUpgradeStatus(f.root)).toBeUndefined()
  expect(await fs.readdir(f.root, { recursive: true })).toEqual(before)
  expect(await fs.readFile(await safePath(f.root, 'versions/v000001.json'))).toEqual(f.original)
})

it('已知输入tuple也不能掩盖坏页身份，本地拒绝后只据成员重生成', async () => {
  const f = await pendingFixture(), target = f.pending.topics!.state.topics[0]!
  await oldPage(f, target, true)
  f.pending.topics!.gaps = [{ topic_id: target.id, point_ids: target.point_ids, message: '删除未支撑句：复核' }]
  f.call.mockClear(); f.topicRequests.splice(0)
  await prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryTopics: { topicIds: [target.id] } }, undefined)
  expect(f.topicRequests.map(request => request.input.topic_id)).toEqual([target.id])
  expect(f.topicRequests[0]!.input).not.toHaveProperty('current_page')
  expect(f.call.mock.calls.every(call => !call[2].includes('错误主题身份'))).toBe(true)
})

it('读取旧对象权限失败原样上抛，不删页也不转成重新生成', async () => {
  const f = await pendingFixture(), target = f.pending.topics!.state.topics[0]!, old = await oldPage(f, target)
  const objectPath = await safePath(f.root, pageObjectPath(old.content_id)), originalStat = fs.stat
  f.pending.topics!.gaps = [{ topic_id: target.id, point_ids: target.point_ids, message: '删除未支撑句：复核' }]
  vi.spyOn(fs, 'stat').mockImplementation((async (...args: Parameters<typeof fs.stat>) => {
    if (path.resolve(String(args[0])) === path.resolve(objectPath)) throw Object.assign(new Error('对象读取被拒绝'), { code: 'EACCES' })
    return originalStat(...args)
  }) as typeof fs.stat)
  f.call.mockClear()
  await expect(prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryTopics: { topicIds: [target.id] } }, undefined)).rejects.toMatchObject({ code: 'EACCES' })
  expect(f.call).not.toHaveBeenCalled()
  expect(f.pending.topics!.pages[target.path]).toEqual(old.page)
})

it('已完成父链收到第二个子目标后按新摘要更新，首个子页不重发', async () => {
  const f = await pendingFixture(), build = f.pending.topics!, parent = build.state.topics[0]!
  const first = { ...structuredClone(parent), id: parent.id + '-01', parent_id: parent.id, path: topicPath(parent.id + '-01') }
  const second = { ...structuredClone(parent), id: parent.id + '-02', parent_id: parent.id, path: topicPath(parent.id + '-02') }
  parent.direct_point_ids = []; build.state.topics.push(first, second); build.pages = {}; build.gaps = []; build.rewritten = []
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  for (const topic of [first, second, parent]) await oldPage(f, f.pending.topics!.state.topics.find(item => item.id === topic.id)!)
  f.pending.topics!.gaps = [first, second].map(topic => ({ topic_id: topic.id, point_ids: topic.point_ids, message: '删除未支撑句：复核' }))
  await prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryTopics: { topicIds: [first.id] } }, undefined)
  // 首轮将父页纳入已完成状态，再使第二子页失效并返回新摘要。
  f.pending.topic_scope!.completed.push(parent.id)
  const stable = structuredClone(f.pending.topics!.pages[first.path])
  f.pending.topics!.pages[second.path]!.input_fingerprint = hash('第二目标需重新生成')
  const secondPage = f.pending.topics!.pages[second.path]!
  secondPage.content = secondPage.content.replace(/input_fingerprint: sha256:[a-f0-9]+/, 'input_fingerprint: ' + hash('第二目标需重新生成'))
  Object.assign(secondPage, { content_id: await putPage(f.root, secondPage.content) })
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2]), raw = await f.original(...args)
    return input.topic_id === second.id && !input.review_stage ? JSON.stringify({ ...JSON.parse(raw), summary: '第二子目标的新摘要' }) : raw
  })
  // 只改变第二子目标的生成指纹；首次生成的回执需按真实输入重新标识。
  const generationFiles = await fs.readdir(await safePath(f.root, 'cache/tasks'))
  for (const file of generationFiles) await fs.unlink(await safePath(f.root, 'cache/tasks/' + file))
  f.call.mockClear(); f.topicRequests.splice(0)
  await prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryTopics: { topicIds: [second.id] } }, undefined)
  expect(f.topicRequests.map(request => request.input.topic_id)).toEqual([second.id, parent.id])
  expect(f.pending.topics!.pages[first.path]).toEqual(stable)
})

it('完整入口发现范围外原文真实变化，在提取核对和删主题前暂停', async () => {
  const f = await pendingFixture(), target = f.pending.topics!.state.topics[0]!
  f.pending.topics!.gaps = [{ topic_id: target.id, point_ids: target.point_ids, message: '删除未支撑句：复核' }]
  await writeJson(f.root, 'work/pending.json', f.pending)
  await fs.writeFile(path.join(f.knowledgeRoot, 'b.md'), '# 乙资料\n\n乙组证据变化。')
  const before = structuredClone(f.pending.topics!.pages)
  f.call.mockClear()
  await expect(buildLayeredLibrary({ ...f.options, retryTopics: { topicIds: [target.id] } })).rejects.toThrow('资料或来源版本已变化')
  expect(f.call).not.toHaveBeenCalled()
  const after = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
  for (const [page, content] of Object.entries(before)) {
    expect(after.topics!.pages[page]?.content).toBe(content.content)
    expect(after.topics!.pages[page]?.dependencies).toEqual(content.dependencies)
  }
})
