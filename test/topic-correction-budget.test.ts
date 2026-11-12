// 不同标题区分独立来源，证据正文与完整输入预算、共识及逐字断言保持。
import { afterEach, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { cleanupLayeredFixtures, layeredIncrementalFixture, snapshotManifest } from './layered-fixture.js'
import { readExtraction } from '../src/layered/publication.js'
import { readVersion, versionPage } from '../src/layered/objects.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

async function fixture(mode: 'fix' | 'unchanged' | 'mutate' = 'fix') {
  const f = await layeredIncrementalFixture(), original = f.call.getMockImplementation()!, requests: any[] = []
  for (const name of ['a', 'b', 'c']) await writeFile(path.join(f.knowledgeRoot, name + '.md'), '# 来源' + name + '\n\n' + '甲组完整依据。'.repeat(350))
  f.options.topics = { topicMergeMinSources: 3, leafInputBudget: 24000, topicMaxChars: 12000, topicMaxPoints: 100, topicReview: false }
  const text = '甲组完整依据。'.repeat(300)
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (!input.topic_id) return original(...args)
    expect(Buffer.byteLength(args[1] + args[2])).toBeLessThanOrEqual(24000)
    requests.push(input)
    if (input.synthesis_stage === 'reference-correction-block') {
      const draft = structuredClone(input.validationFeedback.original)
      for (const key of ['consensus', 'differences', 'conditions']) for (const item of draft[key]) {
        item.point_ids = input.points.filter((point: any) => mode !== 'unchanged' || point.source_id === 'S-0001').map((point: any) => point.point_id)
        if (mode === 'mutate') item.text += '编造事实'
      }
      return JSON.stringify(draft)
    }
    const ids = input.points.map((point: any) => point.point_id)
    // 成员块返回合法条件；合并请求可装入预算，拼上失败输出后超过 24K。
    if (input.synthesis_stage === 'member-block') return JSON.stringify({ title: '主题', summary: '范围', aliases: [], removed_members: [], consensus: [], differences: [], conditions: [{ text, point_ids: ids }] })
    return JSON.stringify({ title: '主题', summary: '范围', aliases: [], removed_members: [], consensus: [{ text, point_ids: [ids[0]] }], differences: [], conditions: [] })
  })
  return { ...f, requests, text }
}

it('24K 结构纠正按完整成员分块并合并引用，原主张和全部引文保持', async () => {
  const f = await fixture()
  const result = await buildLayeredLibrary(f.options), manifest = await snapshotManifest(f.root)
  expect(manifest.topic_gaps ?? []).toEqual([])
  const corrections = f.requests.filter(input => input.synthesis_stage === 'reference-correction-block')
  expect(corrections.length).toBeGreaterThan(1)
  const members = (await Promise.all(manifest.sources.map(source => readExtraction(f.root, source.extract.path)))).flatMap(extraction => extraction.segments.flatMap(segment => segment.points))
  const ids = manifest.topics!.topics.flatMap(topic => topic.point_ids)
  const expected = members.map(point => ({ point_id: 'P' + (ids.indexOf(point.point_id) + 1), ref: 'P' + (ids.indexOf(point.point_id) + 1), source_id: point.evidence[0]!.source_id,
    // 纠正新增来源标题；此夹具引文本身就是完整上下文，不重复传同文。
    source_title: manifest.sources.find(source => source.source_id === point.evidence[0]!.source_id)!.metadata.title,
    text: point.text, evidence: point.evidence.map(({ source_id, locator, quote }) => ({ source_id, locator, quote })) }))
  expect(corrections.flatMap(input => input.points).sort((a, b) => a.point_id.localeCompare(b.point_id))).toEqual(expected.sort((a, b) => a.point_id.localeCompare(b.point_id)))
  const version = await readVersion(f.root, result.version!)
  const page = Object.keys(version.deps.pages).find(page => page.startsWith('topics/'))!
  const content = await versionPage(f.root, version, page)
  expect(content).toContain(f.text)
  for (const member of members) expect(content).toContain(member.point_id.split(':')[0] + '@')
})

it('两轮纠正仍只有单来源时记质量缺口，保留来源且不放宽共识断言', async () => {
  const f = await fixture('unchanged')
  await buildLayeredLibrary(f.options)
  const manifest = await snapshotManifest(f.root)
  expect(manifest.sources).toHaveLength(3)
  expect(manifest.topic_gaps).toEqual([expect.objectContaining({ message: '主题共识必须由至少两个来源支持。' })])
  const corrections = f.requests.filter(input => input.synthesis_stage === 'reference-correction-block')
  expect(corrections.length).toBeGreaterThan(2)
  for (const [index] of manifest.topic_gaps![0]!.point_ids.entries()) expect(corrections.flatMap(input => input.points).filter(point => point.point_id === 'P' + (index + 1))).toHaveLength(2)
})

it('分块纠正不能改写事实，违规时来源仍发布且主题记缺口', async () => {
  const f = await fixture('mutate')
  await buildLayeredLibrary(f.options)
  const manifest = await snapshotManifest(f.root)
  expect(manifest.sources).toHaveLength(3)
  expect(manifest.topic_gaps).toEqual([expect.objectContaining({ message: '分块纠正不得改变原主张、分组或顺序。' })])
})
