import * as fs from 'node:fs/promises'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { versionPage } from '../src/layered/objects.js'
import * as devices from '../src/layered/devices.js'
import * as retention from '../src/layered/retention.js'
import { cleanupLayeredFixtures, layeredFixture, snapshotManifest } from './layered-fixture.js'
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
// 保留提取、核对、共享状态和发布的真实落盘；独立成本计量不参与本文件的产物断言。
vi.mock('../src/layered/costs.js', async original => ({ ...await original<typeof import('../src/layered/costs.js')>(),
  meteredOptions: (_root: string, _pending: unknown, options: unknown) => options }))
afterEach(() => { vi.useRealTimers(); cleanupLayeredFixtures() })

// 同一用例内比较全部档位，不依赖其他测试是否先运行。
it('A35 两个乱序种子下30、3、1路知识页面、提取、主题术语标签及索引逐字节一致', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-09T00:00:00Z'))
  const products: string[] = [], protocols = new Set<string>(), allPeaks: number[] = []
  const validators = new Map<string, z.ZodType>()
  for (const [cap, seed] of [[30, 7], [3, 23], [1, 7], [30, 23]] as const) {
    const f = await layeredFixture(); f.policy.pageGenerationConcurrency = cap; f.policy.contextWindowTokens = 256000
    // 产物比较保留真实写锁和发布；设备登记与回收由存储专项验证。
    vi.spyOn(devices, 'checkWriter').mockResolvedValue(undefined)
    vi.spyOn(devices, 'claimWriter').mockResolvedValue(undefined)
    vi.spyOn(retention, 'collectGarbage').mockResolvedValue(undefined)
    // 本项覆盖补标协议与发布确定性，显式开启该独立阶段。
    f.options.granularity = 'custom'; f.options.topics = { topicMergeMinSources: 3, extractionReview: 'all', topicReview: true, sourceChapterMinPoints: 0, sourcePackRatio: 0, termThreshold50: 3, pointLabelsOnBuild: true }
    f.options.embeddingClient = { identity: async () => '审查固定向量', embed: async texts => texts.map(t => t.includes('甲组') ? [1, 0] : [0, 1]) }
    await Promise.all(Array.from({ length: 3 }, (_, i) => fs.writeFile(path.join(f.knowledgeRoot, i + '.md'), `2026-11-09 甲组和乙组研究结果增加${i}。`)))
    let active = 0, peak = 0
    f.runtime.supportsStructuredOutput = () => true
    f.runtime.stream = async function* (options) {
      const schema = (options as any).responseFormat?.json_schema
      expect(schema).toBeDefined(); protocols.add(schema.name)
      const key = JSON.stringify(schema.schema)
      if (!validators.has(key)) validators.set(key, z.fromJSONSchema(schema.schema))
      expect(validators.get(key)!.safeParse(JSON.parse(options.system!.split('合法JSON示例：\n').at(-1)!)).success).toBe(true)
      const data = JSON.parse((options.messages[0]!.content[0] as { text: string }).text)
      peak = Math.max(peak, ++active)
      const id = String(data.source_id ?? data.topic_id ?? data.term_id ?? '')
      for (let n = 0; n < (id.split('').reduce((v, c) => v + c.charCodeAt(0), seed) * seed) % 5; n++) await setImmediate()
      let output: any
      if (data.label_stage) output = { items: data.points.map((p: any) => ({ point_id: p.point_id, labels: ['研究结果'], keywords: ['研究'] })) }
      else if (data.review_stage) output = { items: (data.points ?? data.sentences).map((p: any) => ({ id: p.id, support: '完整支撑', missing: '' })) }
      else if (data.correction_stage) output = { items: data.items.map((p: any) => ({ id: p.id, paragraph_id: 0, section: '主要发现', evidence: p.validationFeedback.item.evidence })) }
      else if (data.new_tags) output = { groups: [] }
      else if (data.term_id) output = { definition: [{ text: '研究定义', keys: data.contributions.map((c: any) => c.key) }], usage: [], findings: [], differences: [] }
      else if (data.topic_id) output = data.children
        ? { title: '研究范围', summary: '研究概览', aliases: [], consensus: [], differences: [], conditions: [{ text: '研究范围', child_ids: [data.children[0].id] }] }
        : { title: data.points[0].text.includes('甲组') ? '甲组主题' : '乙组主题', summary: '研究范围', aliases: [], removed_members: [], consensus: [], differences: [], conditions: [{ text: data.points[0].text, point_ids: [data.points[0].point_id] }] }
      else {
        const p = data.paragraphs[0]
        output = { tags: ['研究方法', '研究对象', '甲组研究', '乙组研究'], credibility: 'high', credibility_reason: '固定审查资料',
          points: ['甲组', '乙组'].map(group => ({ text: group + '研究主张', evidence: [{ locator: p.locator, quote: p.text }] })),
          terms: ['甲组', '乙组'].map(group => ({ paragraph_id: 0, name: group + '概念', referent: group + '指称', category: '概念', aliases: [], locator: p.locator, note: group + '定义' })) }
      }
      active--; yield { type: 'text-delta', index: 0, text: JSON.stringify(output) }; yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const built = await buildLayeredLibrary(f.options), manifest = await snapshotManifest(f.root)
    expect(manifest.version).toBe(built.version)
    expect(manifest.sources).toHaveLength(3)
    expect(Object.keys(manifest.pages!).filter(p => p.startsWith('terms/') && !p.startsWith('terms/index-'))).toHaveLength(2)
    expect(Object.keys(manifest.pages!).filter(p => p.startsWith('topics/') && !p.startsWith('topics/index-')).length).toBeGreaterThanOrEqual(2)
    expect(manifest.tag_merges?.checked).toEqual(expect.arrayContaining(['甲组研究', '乙组研究']))
    const pages = await Promise.all(Object.keys(manifest.pages!).sort().map(async page => [page, await versionPage(f.root, manifest, page)]))
    const extractions = await Promise.all(manifest.sources.map(async s => [s.source_id, await fs.readFile(path.join(f.root, s.extract.path), 'utf8')]))
    products.push(JSON.stringify({ pages, extractions, tags: manifest.tag_merges, deps: manifest.deps, aliases: manifest.aliases, objects: manifest.pages }))
    expect(peak).toBeLessThanOrEqual(cap); allPeaks.push(peak)
    cleanupLayeredFixtures()
  }
  expect(new Set(products).size).toBe(1)
  expect(protocols).toEqual(new Set(['layered_extraction', 'layered_support_review', 'layered_topic', 'layered_topic_review', 'layered_term', 'layered_tag_merges', 'layered_point_labels']))
  expect(allPeaks[2]).toBe(1)
})

it('A39 单来源和单主题失败只留缺口，其余来源和主题仍发布', async () => {
  const f = await layeredFixture(); f.policy.pageGenerationConcurrency = 30
  f.options.granularity = 'custom'; f.options.topics = { topicMergeMinSources: 3, extractionReview: 'off', topicReview: false, sourceChapterMinPoints: 0, sourcePackRatio: 0 }
  f.options.embeddingClient = { identity: async () => '隔离向量', embed: async texts => texts.map(t => t.includes('甲组') ? [1, 0] : [0, 1]) }
  await Promise.all(['甲乙研究0。', '甲乙研究1。', '甲乙研究2。', '故障来源。'].map((text, i) => fs.writeFile(path.join(f.knowledgeRoot, i + '.md'), text)))
  f.call.mockImplementation(async (_t, _s, raw) => {
    const data = JSON.parse(raw)
    if (data.new_tags) return JSON.stringify({ groups: [] })
    if (data.topic_id) {
      if (data.points[0].text.includes('甲组')) throw new Error('合成主题失败')
      return JSON.stringify({ title: '乙组主题', summary: '研究范围', aliases: [], removed_members: [], consensus: [], differences: [], conditions: [{ text: data.points[0].text, point_ids: [data.points[0].point_id] }] })
    }
    const p = data.paragraphs[0]
    if (p.text.includes('故障')) throw new Error('合成来源失败')
    return JSON.stringify({ tags: ['研究方法', '研究对象', '研究结果'], credibility: 'high', credibility_reason: '审查夹具', terms: [],
      points: ['甲组', '乙组'].map(group => ({ paragraph_id: p.paragraph_id, text: group + '研究事实', section: '主要发现', evidence: [{ locator: p.locator, quote: p.text }] })) })
  })
  await buildLayeredLibrary(f.options)
  const manifest = await snapshotManifest(f.root)
  expect(manifest.sources).toHaveLength(4); expect(manifest.topic_gaps?.length).toBeGreaterThan(0)
  const extractions = await Promise.all(manifest.sources.map(async s => JSON.parse(await fs.readFile(path.join(f.root, s.extract.path), 'utf8'))))
  expect(extractions.filter(e => e.gaps.some((g: any) => g.kind === 'group'))).toHaveLength(1)
  expect(extractions.flatMap(e => e.segments.flatMap((s: any) => s.points))).toHaveLength(6)
  const topicPages = Object.keys(manifest.pages!).filter(p => p.startsWith('topics/') && !p.startsWith('topics/index-'))
  expect(topicPages).toHaveLength(1)
})

it('A40 要点跨段证据逐段核验可发布，跨段拼接的单条引文仍拒绝', async () => {
  for (const joined of [false, true]) {
    const f = await layeredFixture(); f.policy.pageGenerationConcurrency = 1
    await fs.writeFile(path.join(f.knowledgeRoot, '跨段资料.md'), '第一事实。\n\n第二事实。')
    f.call.mockImplementation(async (_task, _system, raw) => {
      const request = JSON.parse(raw)
      if (request.summary_id) return JSON.stringify({ point_ids: request.children.flatMap((child: any) => child.points.map((point: any) => point.point_id)).slice(0, request.point_limit) })
      if (request.new_tags) return JSON.stringify({ groups: [] })
      const first = request.paragraphs[0], second = request.paragraphs[1]
      return JSON.stringify({ tags: ['研究方法', '研究对象', '研究结果'], credibility: 'high', credibility_reason: '审查夹具', terms: [],
        points: [{ paragraph_id: first.paragraph_id, text: '第一事实与第二事实', section: '主要发现', evidence: joined
          ? [{ paragraph_id: first.paragraph_id, locator: first.locator, quote: `${first.text}${second.text}` }]
          : [
            { paragraph_id: first.paragraph_id, locator: first.locator, quote: first.text },
            { paragraph_id: second.paragraph_id, locator: second.locator, quote: second.text },
          ] }] })
    })
    const result = await buildLayeredLibrary(f.options)
    expect(result.modelCalls).toEqual(expect.any(Number))
    const manifest = await snapshotManifest(f.root)
    const extraction = JSON.parse(await fs.readFile(path.join(f.root, manifest.sources[0]!.extract.path), 'utf8'))
    if (joined) expect(extraction.segments.flatMap((segment: any) => segment.points)).toHaveLength(0)
    else expect(extraction.segments.flatMap((segment: any) => segment.points)).toHaveLength(1)
  }
})
