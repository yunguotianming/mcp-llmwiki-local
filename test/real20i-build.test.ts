import { writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { topicHeader } from '../src/layered/topics.js'
import { cleanupLayeredFixtures, layeredFixture, snapshotManifest, versionFile } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
// 本组只验20来源的知识产物与纠正隔离；成本计量由 real20i-costs 专项验证。
vi.mock('../src/layered/costs.js', async original => ({ ...await original<typeof import('../src/layered/costs.js')>(),
  meteredOptions: (_root: string, _pending: unknown, options: unknown) => options }))
afterEach(cleanupLayeredFixtures)

it('20 来源含核对错 ID、标签单元素组及父子主题一次发布，不污染其他项', async () => {
  const f = await layeredFixture(); f.policy.pageGenerationConcurrency = 30
  f.options.topics = { topicMergeMinSources: 3, topicMaxPoints: 40, extractionReview: 'all', topicReview: true, sourceChapterMinPoints: 0 }
  f.options.embeddingClient = { identity: async () => '20i合成向量', embed: async texts => texts.map(() => [1, 0]) }
  await Promise.all(Array.from({ length: 20 }, (_, i) => writeFile(path.join(f.knowledgeRoot, `${i}.md`), `研究对象${i}。\n\n方法${i}。\n\n结果${i}。`)))
  let corrections = 0, extractionCalls = 0
  f.call.mockImplementation(async (_task, _system, raw) => {
    const d = JSON.parse(raw)
    if (d.label_stage) return JSON.stringify({ items: d.points.map((p: any) => ({ point_id: p.point_id, labels: ['研究结果'], keywords: ['研究'] })) })
    if (d.new_tags) return JSON.stringify({ groups: [{ canonical: d.new_tags[0], tags: [d.new_tags[0]] }] })
    if (d.review_stage === 'extraction-correction') {
      corrections++
      return JSON.stringify({ items: d.items.map((p: any) => ({ id: p.id, evidence: p.validationFeedback.item.evidence, support: '完整支撑', missing: null })) })
    }
    if (d.review_stage) return JSON.stringify({ items: (d.points ?? d.sentences).map((p: any, i: number) => ({ id: d.source_id === 'S-0003' && i === 1 ? '错ID' : p.id, support: '完整支撑', missing: null })) })
    if (d.topic_id) return JSON.stringify({ title: '研究主题', summary: '对象方法结果', aliases: [], removed_members: [], consensus: [], differences: [], conditions: [d.children
      ? { text: '子主题研究结果', child_ids: [d.children[0].id] }
      : { text: d.points[0].text, point_ids: [d.points[0].ref ?? d.points[0].point_id] }] })
    if (d.summary_id) return JSON.stringify({ point_ids: d.children.flatMap((c: any) => c.points.map((p: any) => p.point_id)).slice(0, d.point_limit) })
    extractionCalls++
    return JSON.stringify({ tags: ['研究方法', '研究对象', '研究结果'], credibility: 'high', credibility_reason: '合成资料', terms: [], points: d.paragraphs.map((p: any) => ({ paragraph_id: p.paragraph_id, section: '主要发现', text: p.text, evidence: [{ locator: p.locator, quote: p.text }] })) })
  })
  const built = await buildLayeredLibrary(f.options), manifest = await snapshotManifest(f.root)
  expect(built.version).toBe('v000001'); expect(manifest.sources).toHaveLength(20)
  expect(extractionCalls).toBe(20); expect(corrections).toBe(1)
  const extractions = await Promise.all(manifest.sources.map(s => readFile(path.join(f.root, s.extract.path), 'utf8').then(JSON.parse)))
  const points = extractions.flatMap(e => e.segments.flatMap((s: any) => s.points))
  expect(points).toHaveLength(60); expect(points.every(p => p.verification.status === 'verified')).toBe(true)
  const topics = Object.entries(manifest.deps!.pages).filter(([p]) => p.startsWith('topics/'))
  expect(topics.some(([, deps]) => deps.children?.length)).toBe(true)
  for (const [page, deps] of topics) expect(topicHeader(await versionFile(f.root, built.version, page)).sources).toEqual(deps.sources)
  expect(manifest.tag_merge_gap).toBeUndefined(); expect(manifest.topic_gaps).toEqual([])
})
