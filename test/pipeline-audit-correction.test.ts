import { mockSupportReview } from './layered-fixture.js'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { prepareTopics } from '../src/layered/topics.js'
import { publishLibrary, readLayeredPage } from '../src/layered/publication.js'
import { meteredOptions } from '../src/layered/costs.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'
import { pendingFixture } from './pipeline-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

for (const [id, fault] of [['C01', '编号错绑'], ['C02', '不存在'], ['C03', '别的主题']] as const) {
  it(`${id} ${fault}引用可纠正且主张不变，纠正计入成本`, async () => {
    const f = await pendingFixture(), requests: any[] = []
    delete f.pending.topics!.pages['topics/T-0001.md']
    const other = f.pending.topics!.state.topics[1]!.point_ids[0]!
    f.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
      const input = JSON.parse(args[2]); requests.push(input)
      const value = input.validationFeedback ? structuredClone(input.validationFeedback.original) : JSON.parse(await f.original(...args))
      value.conditions[0].point_ids = [input.validationFeedback ? input.points[0].point_id : fault === '别的主题' ? other : fault === '编号错绑' ? 'S-0015:' + input.points[0].point_id : 'missing']
      return JSON.stringify(value)
    })
    const before = f.pending.costs!.stages['主题']!.actual_calls
    const result = await prepareTopics(f.root, f.pending, f.committed, meteredOptions(f.root, f.pending, f.options), undefined)
    expect(requests).toHaveLength(2); expect(result.modelCalls).toBe(2 + 1) // 新增一次主题核对。
    expect(f.pending.costs!.stages['主题']!.actual_calls - before).toBe(2)
    const page = f.pending.topics!.pages['topics/T-0001.md']!
    expect(page.dependencies.calls).toHaveLength(2)
    expect(page.content).toContain(requests[1].validationFeedback.original.conditions[0].text)
    expect(f.pending.manifest.topic_gaps).toEqual([])
  })
}

it('C04 改主张被拒，两次纠正后留缺口，成员留来源页而不进主题页', async () => {
  const f = await pendingFixture(), requests: any[] = []
  delete f.pending.topics!.pages['topics/T-0001.md']
  const ids = [...f.pending.topics!.state.topics[0]!.point_ids]
  f.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
    const input = JSON.parse(args[2]); requests.push(input)
    const value = input.validationFeedback ? structuredClone(input.validationFeedback.original) : JSON.parse(await f.original(...args))
    value.conditions[0].point_ids = [input.validationFeedback ? input.points[0].point_id : 'missing']
    if (input.validationFeedback) value.conditions[0].text = '未经允许的新主张'
    return JSON.stringify(value)
  })
  const before = f.pending.costs!.stages['主题']!.actual_calls
  await prepareTopics(f.root, f.pending, f.committed, meteredOptions(f.root, f.pending, f.options), undefined)
  expect(requests).toHaveLength(3)
  expect(f.pending.costs!.stages['主题']!.actual_calls - before).toBe(3)
  expect(f.pending.manifest.topic_gaps![0]).toMatchObject({ message: expect.stringContaining('不得改变'), point_ids: ids })
  expect(f.pending.topics!.pages).not.toHaveProperty('topics/T-0001.md')
  expect(f.pending.topics!.pages).toHaveProperty('topics/T-0002.md')
  await publishLibrary(f.root, f.pending)
  const source = await readLayeredPage(f.knowledgeRoot, 'sources/S-0001.md')
  const extracted = JSON.parse(await readFile(path.join(f.root, f.pending.manifest.sources[0]!.extract.path), 'utf8'))
  for (const point of extracted.segments.flatMap((item: any) => item.points)) expect(source).toContain(point.text)
})

it('C05 缺口主题在同一pending续做时重新尝试，其他页面不变', async () => {
  const f = await pendingFixture(), stable = structuredClone(f.pending.topics!.pages['topics/T-0002.md'])
  delete f.pending.topics!.pages['topics/T-0001.md']
  f.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
    const output = JSON.parse(await f.original(...args)); output.conditions[0].point_ids = ['missing']; return JSON.stringify(output)
  })
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect(f.pending.manifest.topic_gaps).toHaveLength(1)
  f.call.mockImplementation(f.original); f.topicRequests.splice(0)
  await prepareTopics(f.root, f.pending, f.committed, f.options, undefined)
  expect.soft(f.topicRequests.length).toBeGreaterThan(0)
  expect.soft(f.pending.manifest.topic_gaps).toEqual([])
  expect(f.pending.topics!.pages['topics/T-0002.md']).toEqual(stable)
})
