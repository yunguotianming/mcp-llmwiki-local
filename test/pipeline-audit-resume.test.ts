import { afterEach, expect, it, vi } from 'vitest'
import { prepareTopics } from '../src/layered/topics.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'
import { changeExtraction, pendingFixture } from './pipeline-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

for (const [id, mutation] of [['R01', '删除'], ['R02', '同ID改内容'], ['R03', '新增']] as const) {
  it(`${id} ${mutation}要点后重算受影响主题，其他主题与两次续做逐字节稳定`, async () => {
    const f = await pendingFixture(), stable = structuredClone(f.pending.topics!.pages['topics/T-0002.md'])
    const fingerprint = f.pending.topics!.fingerprint
    let changedId = ''
    await changeExtraction(f, value => {
      const segment = value.segments.find(item => item.points.length)!
      if (mutation === '删除') changedId = segment.points.shift()!.point_id
      if (mutation === '同ID改内容') { changedId = segment.points[0]!.point_id; segment.points[0]!.text += '新增适用条件。' }
      if (mutation === '新增') { const point = structuredClone(segment.points[0]!); point.point_id += '-new'; point.text = '甲组新增证据。'; changedId = point.point_id; segment.points.push(point) }
    })
    await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
    expect(f.pending.topics!.fingerprint).not.toBe(fingerprint)
    expect(f.topicRequests.map(item => item.input.topic_id)).toEqual(['T-0001'])
    expect(f.pending.topics!.pages['topics/T-0002.md']).toEqual(stable)
    const ids = f.pending.topics!.state.topics.flatMap(item => item.point_ids)
    if (mutation === '删除') expect(ids).not.toContain(changedId)
    else expect(ids).toContain(changedId)
    const snapshot = JSON.stringify(f.pending.topics)
    for (let i = 0; i < 2; i++) await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
    expect(JSON.stringify(f.pending.topics)).toBe(snapshot)
    expect(f.topicRequests).toHaveLength(1)
  })
}

it('R04 旧格式主题缓存与提取版本不一致时保留未受影响主题ID及页面', async () => {
  const f = await pendingFixture(), saved = f.pending.topics!
  const stable = structuredClone(saved.pages['topics/T-0002.md'])
  // 旧20f格式没有配置指纹、逐要点哈希或页输入指纹，且主题号已有历史。
  delete stable!.input_fingerprint
  for (const topic of saved.state.topics) {
    const old = topic.path
    delete saved.pages[old]!.input_fingerprint
    topic.id = topic.id === 'T-0001' ? 'T-0017' : 'T-0039'; topic.path = `topics/${topic.id}.md`
    saved.pages[topic.path] = saved.pages[old]!; delete saved.pages[old]
  }
  saved.state.next_topic_number = 80
  delete saved.configuration_fingerprint; delete saved.point_hashes
  saved.fingerprint = '旧版仅来源配置指纹'
  await changeExtraction(f, value => { value.segments.find(item => item.points.length)!.points.shift() })
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect.soft(f.pending.topics!.state.topics.map(item => item.id)).toContain('T-0039')
  expect(f.pending.topics!.pages['topics/T-0039.md']).toEqual(stable)
})

it('R05 指纹相同但缓存残留已删除成员时仍清理并重算', async () => {
  const f = await pendingFixture()
  f.pending.topics!.state.topics[0]!.point_ids.push('S-0001:已删除成员')
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(f.pending.topics!.state.topics.flatMap(item => item.point_ids)).not.toContain('S-0001:已删除成员')
  expect(f.topicRequests.map(item => item.input.topic_id)).toEqual(['T-0001'])
})
