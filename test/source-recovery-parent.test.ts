import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { resultFingerprint } from '../src/layered/extraction.js'
import { hash } from '../src/layered/files.js'
import { storageJson } from '../src/layered/vectors.js'
import { cleanupLayeredFixtures, layeredIncrementalFixture, mockSupportReview, snapshotManifest } from './layered-fixture.js'
import { sourceRecoveryExtraction } from './source-recovery-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('核对补证真实改变子页输入时更新该叶及必要父页，不处理范围外旧缺口', async () => {
  const f = await layeredIncrementalFixture()
  f.options.topics = { topicMaxSources: 2, topicMaxDepth: 1, topicMaxChildren: 2, topicMergeMinSources: 1 }
  for (let index = 0; index < 4; index++) await writeFile(path.join(f.knowledgeRoot, `${index}.md`), `${index < 3 ? '甲' : '乙'}组证据${index}。成立条件${index}。其他背景${index}。`)
  await buildLayeredLibrary(f.options)
  const manifest = await snapshotManifest(f.root), entry = manifest.sources[0]!, before = await sourceRecoveryExtraction(f.root, manifest, entry.source_id)
  const point = before.segments.flatMap(segment => segment.points)[0]!
  point.text = '甲组证据0。'
  point.evidence[0]!.quote = '成立条件0。'
  point.verification = { status: 'unverified', missing: '引文尚未支撑该结论。', fingerprint: point.verification!.fingerprint }
  before.correction_batches = { ...before.correction_batches, semantic: 0 }
  entry.extract.processing_fingerprint = resultFingerprint(before)
  const leaf = manifest.topics!.topics.find(topic => topic.parent_id && topic.point_ids.includes(point.point_id))!
  expect(leaf).toBeTruthy()
  const outside = manifest.topics!.topics.find(topic => topic.id === 'T-0002')!
  manifest.topic_gaps = [{ topic_id: 'T-0099', point_ids: manifest.topics!.topics.find(topic => topic.id === 'T-0002')!.point_ids, message: 'Connection error.' }]
  await writeFile(path.join(f.root, entry.extract.path), JSON.stringify(before, null, 2) + '\n')
  await writeFile(path.join(f.root, 'versions', manifest.version! + '.json'), JSON.stringify({ checksum: hash(storageJson(manifest)), manifest }, null, 2) + '\n')
  const original = f.call.getMockImplementation()!, requests: any[] = [], vectors = await readFile(path.join(f.root, 'state/embeddings.json'))
  f.call.mockClear(); f.embed.mockClear()
  f.call.mockImplementation(async (...args) => {
    const request = JSON.parse(args[2]); requests.push(request)
    if (request.review_stage === 'extraction') return JSON.stringify({ items: request.points.map((item: any) => ({ id: item.id, support: '不支撑', missing: '需要补足实际结论引文。' })) })
    if (request.review_stage === 'extraction-correction') return JSON.stringify({ items: request.items.map((item: any) => ({ id: item.id, support: '完整支撑', missing: null,
      evidence: [{ locator: point.evidence[0]!.locator, quote: '甲组证据0。成立条件0。' }] })) })
    const support = mockSupportReview(request)
    if (support) return support
    const output = JSON.parse(await original(...args))
    if (request.topic_id === leaf.id) output.summary = '来源核对更新后的子主题摘要'
    return JSON.stringify(output)
  })
  await buildLayeredLibrary({ ...f.options, retrySources: { sourceIds: [entry.source_id], kinds: ['review'] } })
  const next = await snapshotManifest(f.root), topicIds = requests.filter(request => request.topic_id).map(request => request.topic_id)
  expect(topicIds).toContain(leaf.id)
  expect(topicIds).toContain(leaf.parent_id)
  expect(topicIds.every(id => id === leaf.id || id === leaf.parent_id)).toBe(true)
  expect(next.pages![outside.path]).toBe(manifest.pages![outside.path])
  expect(next.topic_gaps).toContainEqual(manifest.topic_gaps[0])
  expect(next.sources.slice(1)).toEqual(manifest.sources.slice(1))
  expect(await readFile(path.join(f.root, 'state/embeddings.json'))).toEqual(vectors)
  expect(f.embed).not.toHaveBeenCalled()
})
