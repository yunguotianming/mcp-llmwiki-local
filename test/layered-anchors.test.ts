import { mockSupportReview } from './layered-fixture.js'
import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as files from '../src/layered/files.js'
import { chapterBlockId, evidenceBlockIds, migrateAnchors, sectionBlockId } from '../src/layered/anchors.js'
import { buildLayeredLibrary, readLayeredPage } from '../src/layered/index.js'
import { publishLibrary, readExtraction } from '../src/layered/publication.js'
import { putPage, versionPage } from '../src/layered/objects.js'
import { refreshReadingCopy } from '../src/layered/reading-copy.js'
import { indexDependencies } from '../src/layered/revocations.js'
import { hydrateVectors, storageJson } from '../src/layered/vectors.js'
import type { PendingBuild, Point } from '../src/layered/schema.js'
import { excerpts, pageParagraphs } from '../src/wiki/page-search.js'
import { LayeredQuery } from '../src/wiki/layered-query.js'
import { cleanupLayeredFixtures, layeredFixture, layeredIncrementalFixture, modelOutput, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
vi.mock('../src/layered/files.js', async original => ({ ...await original<typeof import('../src/layered/files.js')>() }))
afterEach(cleanupLayeredFixtures)

it('块 ID 对完整要点 ID 求 SHA256，排序稳定、同页撞号递增、不同来源独立', () => {
  const point = (id: string, count = 1) => ({ point_id: id, evidence: Array(count).fill({}) }) as Point
  const id = 'S-0001:sha256:abcdef:01'
  expect(evidenceBlockIds([point(id)]).get(id)).toEqual(['p' + createHash('sha256').update(id).digest('hex').slice(0, 12)])
  const hash = vi.spyOn(files, 'hash').mockReturnValue('sha256:abcdef123456' + '0'.repeat(52))
  const points = [point('S-0001:c'), point('S-0001:a', 2), point('S-0002:a'), point('S-0001:b')]
  const anchors = evidenceBlockIds(points)
  expect([...anchors]).toEqual([...evidenceBlockIds([...points].reverse())])
  expect(anchors.get('S-0001:a')).toEqual(['pabcdef123456', 'pabcdef123456-2'])
  expect(anchors.get('S-0001:b')).toEqual(['pabcdef123456-3'])
  expect(anchors.get('S-0001:c')).toEqual(['pabcdef123456-4'])
  expect(anchors.get('S-0002:a')).toEqual(['pabcdef123456'])
  hash.mockRestore()
  expect(chapterBlockId('chapter-A:中_1')).toBe('chapter-A1')
  expect(sectionBlockId('T-01:中_2')).toBe('T-01---2')
  expect(migrateAnchors('[证据](../sources/S-0001.md#S-0001:a)\n<a id="T:1"></a>\n\n## 章节\n正文', anchors))
    .toBe('[证据](../sources/S-0001.md#^pabcdef123456)\n## 章节 ^T-1\n正文')
})

it('多行段落、列表项和标题块的摘录不含标记，仍逐字存在于未去标记的页面', () => {
  const raw = '## 证据标题 ^chapter-A\n\n证据空格  保留\n第二行🦊 ^p111\n\n- 证据列表一 ^p222\n- 证据列表二 ^p333\n\n证据后文。'
  const blocks = pageParagraphs(raw, ['证据'])
  expect(blocks.find(block => block.content.includes('第二行'))).toMatchObject({ anchor: '^p111', content: '证据空格  保留\n第二行🦊' })
  expect(blocks.find(block => block.content.includes('列表一'))?.anchor).toBe('^p222')
  expect(blocks.find(block => block.content === '证据后文。')?.anchor).toBe('^chapter-A')
  for (const item of [...blocks, ...excerpts({ library: '库', path: 'sources/S-0001.md', title: '证据', content: raw }, ['证据'], 4000)]) {
    expect(raw).toContain(item.content)
    expect(item.content).not.toMatch(/\^[a-zA-Z0-9-]+/)
  }
})

it('撞号来源增加要点后，主题旧引用按旧块映射重绑到当前证据', async () => {
  const f = await layeredIncrementalFixture(), originalHash = files.hash
  vi.spyOn(files, 'hash').mockImplementation(value => typeof value === 'string' && /^S-\d+:sha256:[a-f0-9]{64}:\d+$/.test(value)
    ? 'sha256:' + 'a'.repeat(64) : originalHash(value))
  const paragraphs = Array.from({ length: 8 }, (_, index) => `甲组第${index}条研究证据。`).sort((a, b) => originalHash(a).localeCompare(originalHash(b)))
  await writeFile(path.join(f.knowledgeRoot, '碰撞.md'), paragraphs.slice(1, 3).join('\n\n'))
  await buildLayeredLibrary(f.options)
  const first = await snapshotManifest(f.root), old = await readExtraction(f.root, first.sources[0]!.extract.path)
  const oldPoints = old.segments.flatMap(segment => segment.points), oldAnchors = evidenceBlockIds(oldPoints)
  const before = await readLayeredPage(f.knowledgeRoot, 'topics/T-0001.md')
  const cited = [...before.matchAll(/\.md#\^(p[a-f0-9-]+)/g)].map(match => oldPoints.find(point => oldAnchors.get(point.point_id)![0] === match[1])!.point_id)
  await writeFile(path.join(f.knowledgeRoot, '碰撞.md'), paragraphs.slice(0, 3).join('\n\n'))
  f.topicRequests.length = 0
  await buildLayeredLibrary(f.options)
  const current = f.topicRequests[0]!.input.current_page!, next = await snapshotManifest(f.root)
  const points = (await readExtraction(f.root, next.sources[0]!.extract.path)).segments.flatMap(segment => segment.points)
  const anchors = evidenceBlockIds(points)
  expect(cited.length).toBeGreaterThan(0)
  expect(cited.some(id => anchors.get(id)![0] !== oldAnchors.get(id)![0])).toBe(true)
  expect([...current.matchAll(/\.md#\^(p[a-f0-9-]+)/g)].map(match => match[1])).toEqual(cited.map(id => anchors.get(id)![0]))
  for (const reference of f.topicRequests[0]!.input.current_points!) {
    expect(reference.point_id).toMatch(/^P\d+$/)
    const original = points.find(point => point.point_id.startsWith(reference.source_id + ':') && point.text === reference.text)!
    expect(reference.anchor).toBe('^' + anchors.get(original.point_id)![0])
  }
})

it('全部页面链接命中真实块，旧待发布及已发布状态零提取升级，查询和浏览沿用块定位', async () => {
  const f = await layeredFixture()
  f.options.topics = { topicMergeMinSources: 1, termThreshold50: 1 }
  f.options.embeddingClient = { embed: async texts => texts.map(() => [1, 0]), identity: async () => 'anchor-test' }
  f.call.mockImplementation(async (_task, _system, input) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(input))
    if (support) return support
    const request = JSON.parse(input)
    if (request.topic_id) return JSON.stringify({ title: '研究主题', aliases: [], summary: '研究范围', consensus: [], differences: [], conditions: [{ text: '研究结论', point_ids: [request.points[0].point_id] }] })
    if (request.term_id) return JSON.stringify({ definition: [{ text: '研究定义', keys: [request.contributions[0].key] }], usage: [], findings: [], differences: [] })
    const output = JSON.parse(modelOutput(request))
    if (output.points) output.points[0].evidence.push({ ...output.points[0].evidence[0] })
    return JSON.stringify(output)
  })
  await writeFile(path.join(f.knowledgeRoot, '研究.md'), '# 研究书\n\n## 方法\n\n研究证据保留  空格与换行。\n证据第二行🦊。\n\n## 结果\n\n研究发现可以逐字核对。')
  await buildLayeredLibrary({ ...f.options, publish: false })
  const pending = await hydrateVectors(f.root, JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8'))) as PendingBuild
  const extractionBytes = await readFile(path.join(f.root, pending.manifest.sources[0]!.extract.path), 'utf8')
  const extraction = await readExtraction(f.root, pending.manifest.sources[0]!.extract.path)
  const anchors = evidenceBlockIds(extraction.segments.flatMap(segment => segment.points))
  const oldIds = new Map([...anchors].flatMap(([id, blocks]) => blocks.map(block => [block, id])))
  const legacy = (content: string) => content.replace(/#\^(p[a-f0-9-]+)/g, (_link, block) => '#' + oldIds.get(block))
    .replace(/^(## [^\n]+) \^([a-zA-Z0-9-]+)$/gm, '<a id="$2"></a>\n\n$1')
  for (const page of [...Object.values(pending.topics!.pages), ...Object.values(pending.terms!.pages)]) {
    page.content = legacy(page.content)
    for (const child of page.dependencies.children ?? []) child.page = child.page.replace('#^', '#')
  }
  pending.terms!.section_dependencies = Object.fromEntries(Object.entries(pending.terms!.section_dependencies).map(([key, value]) => [key.replace('#^', '#'), value]))
  delete pending.manifest.anchor_format
  f.call.mockClear()
  await publishLibrary(f.root, pending)
  expect(f.call).not.toHaveBeenCalled()
  const first = await snapshotManifest(f.root), pages = new Map<string, string>()
  for (const file of Object.keys(first.pages!)) pages.set(file, await versionPage(f.root, first, file))
  const checkLinks = (documents: Map<string, string>) => {
    let links = 0
    for (const [file, content] of documents) {
      expect(content).not.toContain('<a id=')
      const ids = [...content.matchAll(/ \^([a-zA-Z0-9-]+)$/gm)].map(match => match[1])
      expect(new Set(ids).size).toBe(ids.length)
      for (const match of content.matchAll(/\]\(([^)\s]*)#([^\s)]+)\)/g)) {
        links++
        expect(match[2]).toMatch(/^\^[a-zA-Z0-9-]+$/)
        const target = match[1] ? path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1])) : file
        expect(documents.has(target)).toBe(true)
        expect(documents.get(target)!.split('\n').some(line => line.endsWith(' ' + match[2]))).toBe(true)
      }
    }
    expect(links).toBeGreaterThan(3)
  }
  checkLinks(pages)
  for (const point of extraction.segments.flatMap(segment => segment.points)) for (const evidence of point.evidence) {
    expect(evidence.quote).not.toMatch(/\^[a-zA-Z0-9-]+/)
    expect(pages.get('sources/S-0001.md')).toContain(evidence.quote)
  }
  const query = new LayeredQuery(f.options.embeddingClient), layered = { root: f.root, card: first.card! }
  const chapter = extraction.chapters![0]!
  const browse = (await query.browse(f.library, layered, 'S-0001', {})).value
  expect(browse.children[0]!.read_ref).toBe('sources/S-0001.md#^' + chapterBlockId(chapter.id))
  expect((await query.read(f.library, layered, browse.children[0]!.read_ref, 5000))!.value!.content).toContain(' ^' + chapterBlockId(chapter.id))
  const termRef = Object.keys(first.deps!.pages).find(page => page.startsWith('terms/') && page.includes('#'))!
  expect(termRef).toContain('#^')
  expect(await readLayeredPage(f.knowledgeRoot, termRef)).toContain('## 综合 ^all')
  // 使用证据列表中的完整要点 ID，确保检索首段命中带块 ID 的证据。
  const results = (await query.search(f.library, layered, [...anchors.keys()][0]!, ['source'])).value
  expect(results).toHaveLength(1)
  expect(results[0]!.anchor).toMatch(/^\^p[a-f0-9]{12}(?:-\d+)?$/)
  for (const hit of results) {
    expect(pages.get(hit.path)).toContain(hit.snippet)
    expect(hit.snippet).not.toMatch(/ \^[a-zA-Z0-9-]+/)
    for (const quote of hit.excerpts) { expect(pages.get(hit.path)).toContain(quote.content); expect(quote.content).not.toMatch(/ \^[a-zA-Z0-9-]+/) }
  }
  // 模拟已发布旧版：旧引用及分节依赖落盘，提取快照保持逐字不变。
  delete first.anchor_format
  for (const [file, content] of pages) first.pages![file] = await putPage(f.root, legacy(content).replace(/ \^p[a-f0-9-]+$/gm, ''))
  first.deps!.pages = Object.fromEntries(Object.entries(first.deps!.pages).map(([key, value]) => {
    for (const child of value.children ?? []) child.page = child.page.replace('#^', '#')
    return [key.replace('#^', '#'), value]
  }))
  indexDependencies(first.deps!)
  await writeFile(path.join(f.root, 'versions', first.version + '.json'), storageJson({ checksum: files.hash(storageJson(first)), manifest: first }))
  await refreshReadingCopy(f.root, first)
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ modelCalls: 0, unchanged: false })
  expect(f.call).not.toHaveBeenCalled()
  const next = await snapshotManifest(f.root)
  expect(next.anchor_format).toBe('obsidian-block-v1')
  expect(next.sources[0]!.extract.path).toBe(first.sources[0]!.extract.path)
  expect(await readFile(path.join(f.root, next.sources[0]!.extract.path), 'utf8')).toBe(extractionBytes)
  const updated = new Map<string, string>()
  for (const file of Object.keys(next.pages!)) updated.set(file, await versionPage(f.root, next, file))
  checkLinks(updated)
})
