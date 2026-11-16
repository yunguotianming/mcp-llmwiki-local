import { afterEach, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import { prepareTopics, topicHeader, topicInputFingerprint } from '../src/layered/topics.js'
import { hash } from '../src/layered/files.js'
import { putPage } from '../src/layered/objects.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'
import { pendingFixture, changeExtraction } from './pipeline-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it.each(['缺失', '非法', '合法但未知'])('原输入指纹%s时辅助依赖指纹不能替代生成归属证明', async kind => {
  const f = await pendingFixture(), build = f.pending.topics!, target = build.state.topics[0]!, page = build.pages[target.path]!
  const oldGeneration = hash('旧生成归属'), header = { ...topicHeader(page.content), generation_hash: oldGeneration,
    generation_input_fingerprint: topicInputFingerprint(target, build.state, build.point_hashes!) }
  if (kind === '缺失') delete header.input_fingerprint
  else header.input_fingerprint = kind === '非法' ? '非法原输入' : hash('合法但无法证明的未知原算法')
  page.content = page.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, `---\n${stringify(header).trimEnd()}\n---\n`)
  page.input_fingerprint = String(header.input_fingerprint)
  page.generation_input_fingerprint = header.generation_input_fingerprint
  Object.assign(page, { content_id: await putPage(f.root, page.content) })
  build.gaps = [{ topic_id: target.id, point_ids: target.point_ids, message: '删除未支撑句：复核' }]
  f.call.mockClear(); f.topicRequests.splice(0)
  await prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryTopics: { topicIds: [target.id] } }, undefined)
  expect(f.topicRequests.map(request => request.input.topic_id)).toEqual([target.id])
  const accepted = topicHeader(f.pending.topics!.pages[target.path]!.content)
  expect(accepted.generation_hash).not.toBe(oldGeneration)
  expect(accepted.input_fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/)
})

it('原成员明确未通过来源核对时模型前暂停，不复活要点或删除原页', async () => {
  const f = await pendingFixture(), build = f.pending.topics!, target = build.state.topics[0]!
  build.gaps = [{ topic_id: target.id, point_ids: target.point_ids, message: '删除未支撑句：复核' }]
  const before = structuredClone(build.pages)
  await changeExtraction(f, value => {
    value.segments.flatMap(segment => segment.points)[0]!.verification = { status: 'unverified', fingerprint: hash('明确无证据'), reasons: [], models: [] }
  })
  f.call.mockClear()
  await expect(prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryTopics: { topicIds: [target.id] } }, undefined)).rejects.toMatchObject({ code: 'TOPIC_SCOPE_MEMBERS_CHANGED' })
  expect(f.call).not.toHaveBeenCalled()
  expect(f.pending.topics!.pages).toEqual(before)
})

it('原页补核发生传输失败时保原页且未完成，不把错误解释为语义不支撑', async () => {
  const f = await pendingFixture(), build = f.pending.topics!, target = build.state.topics[0]!, page = build.pages[target.path]!
  delete page.dependencies.review
  Object.assign(page, { content_id: await putPage(f.root, page.content) })
  const before = structuredClone(page)
  build.gaps = [{ topic_id: target.id, point_ids: target.point_ids, message: '删除未支撑句：复核' }]
  f.call.mockImplementation(async () => { throw new Error('Connection error.') })
  f.topicRequests.splice(0)
  await expect(prepareTopics(f.root, f.pending, f.committed, { ...f.options, retryTopics: { topicIds: [target.id] } }, undefined)).rejects.toMatchObject({ code: 'TOPIC_REVIEW_INCOMPLETE' })
  expect(f.pending.topics!.pages[target.path]).toEqual(before)
  expect(f.pending.topic_scope!.completed).not.toContain(target.id)
  expect(f.topicRequests).toEqual([])
})
