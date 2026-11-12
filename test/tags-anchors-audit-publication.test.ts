import { readFile, writeFile, readdir, mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { stringify } from 'yaml'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { buildLayeredLibrary, readLayeredPage } from '../src/layered/index.js'
import { extractSource } from '../src/layered/extraction.js'
import { readLocalSource } from '../src/layered/snapshot.js'
import { putPage } from '../src/layered/objects.js'
import { validatePublication } from '../src/layered/publication.js'
import { LayeredQuery } from '../src/wiki/layered-query.js'
import { evidenceBlockIds } from '../src/layered/anchors.js'
import { expectExcerptInPage } from './excerpt-assertions.js'
import { cleanupLayeredFixtures, snapshotManifest, snapshotFixture } from './layered-fixture.js'
import type { Extraction, Processing } from '../src/layered/schema.js'
import type { LocalSource } from '../src/layered/snapshot.js'
import type { FixtureSnapshot } from './layered-fixture.js'
import { built, fixture, saveManifest, header } from './tags-anchors-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

const longText = '# 书\n\n' + [1, 2, 3].map(n => `## 章节${n}\n\n${String(n).repeat(450)}。`).join('\n\n')
const processing: Processing = { tier: 50, prompt_version: 'audit', model: 'mock/extractor' }
let longSource: LocalSource, longExtraction: Extraction, longTemplate: FixtureSnapshot, longRoot: string
beforeAll(async () => {
  const source = await built(); await built('topics')
  const f = await fixture(false, longText)
  await mkdir(f.root, { recursive: true })
  longSource = await readLocalSource(path.join(f.knowledgeRoot, '审查资料.md'), '笔记')
  longExtraction = await extractSource(f.root, 'S-0001', longSource, processing, f.options, 4000)
  longTemplate = await snapshotFixture(f.knowledgeRoot); longRoot = f.knowledgeRoot
  // 预建真实 SQLite 查询索引，后续校验仍读取每项测试自己的页面字节。
  await new LayeredQuery({ embed: async texts => texts.map(() => [1, 0]) }).search(source.library, { root: source.root, card: source.manifest.card! }, '可核验', ['source'])
})

it('P01 仅旧锚点头部的发布升级零模型调用并保留手改冲突', async () => {
  const f = await built(), original = await readFile(path.join(f.root, f.entry.extract.path), 'utf8')
  delete f.manifest.anchor_format; delete f.manifest.page_created
  const anchors = evidenceBlockIds(f.extraction.segments.flatMap(segment => segment.points))
  const oldIds = new Map([...anchors].flatMap(([id, blocks]) => blocks.map(block => [block, id])))
  for (const page of Object.keys(f.manifest.pages!)) {
    const current = await readLayeredPage(f.knowledgeRoot, page), metadata = header(current)
    for (const field of ['type', 'created', 'aliases', 'tags']) delete metadata[field]
    const body = current.replace(/^---\n[\s\S]*?\n---\n/, '').replace(/#\^(p[a-f0-9-]+)/g, (_match, id) => '#' + oldIds.get(id))
      .replace(/^(.*) \^(p[a-f0-9-]+)$/gm, (_match, line, id) => `<a id="${oldIds.get(id)}"></a>\n${line}`)
    f.manifest.pages![page] = await putPage(f.root, '---\n' + stringify(metadata) + '---\n' + body)
  }
  await saveManifest(f.root, f.manifest)
  const manual = '# 手改页面\n不能覆盖'
  await writeFile(path.join(f.root, 'wiki/sources/S-0001.md'), manual)
  f.call.mockClear()
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ modelCalls: 0, unchanged: false })
  expect(f.call).not.toHaveBeenCalled()
  expect(await readFile(path.join(f.root, f.entry.extract.path), 'utf8')).toBe(original)
  expect(await readFile(path.join(f.root, 'wiki/sources/S-0001.md'), 'utf8')).toBe(manual)
  expect((await readdir(path.join(f.root, 'conflicts'))).length).toBeGreaterThan(0)
  const page = await readLayeredPage(f.knowledgeRoot, 'sources/S-0001.md')
  expect(page).toMatch(/ \^p[a-f0-9]{12}/); expect(header(page).type).toBe('source')
})

it('P02 旧主题无 aliases 状态时头部锚点升级仍要求零模型调用', async () => {
  const f = await built('topics')
  delete f.manifest.anchor_format; delete f.manifest.page_created
  for (const topic of f.manifest.topics!.topics) {
    delete topic.aliases
    const page = await readLayeredPage(f.knowledgeRoot, topic.path)
    f.manifest.pages![topic.path] = await putPage(f.root, page.replace(/^aliases:\n(?:[ \t]+.*\n)*/m, ''))
  }
  await saveManifest(f.root, f.manifest)
  await unlink(path.join(f.root, 'state/topics.json'))
  f.call.mockClear()
  await buildLayeredLibrary(f.options)
  expect(f.call).not.toHaveBeenCalled()
})

it('P03 生成块 ID 不进入引文和 FTS 摘录，伪造页面锚点仍被校验拒绝', async () => {
  const f = await built(), page = await readLayeredPage(f.knowledgeRoot, 'sources/S-0001.md')
  for (const point of f.extraction.segments.flatMap(segment => segment.points)) for (const evidence of point.evidence) {
    expect(page).toContain(evidence.quote); expect(evidence.quote).not.toMatch(/ \^p[\da-f]+/)
  }
  const query = new LayeredQuery({ embed: async texts => texts.map(() => [1, 0]) }), layered = { root: f.root, card: f.manifest.card! }
  const results = (await query.search(f.library, layered, '可核验', ['source'])).value
  expect(results.length).toBeGreaterThan(0)
  for (const hit of results) {
    expectExcerptInPage(page, hit.snippet); expect(hit.snippet).not.toMatch(/ \^[\w-]+/)
    for (const excerpt of hit.excerpts) { expectExcerptInPage(page, excerpt.content); expect(excerpt.content).not.toMatch(/ \^[\w-]+/) }
  }
  f.manifest.pages!['sources/S-0001.md'] = await putPage(f.root, page.replace(/ \^p[\da-f]+/, ' ^伪造'))
  await saveManifest(f.root, f.manifest)
  await expect(validatePublication(f.root, f.manifest.version!)).rejects.toThrow('来源页与提取快照不一致')
})

it('P04 超长文无标签旧协议章节缓存必须全部重提', async () => {
  const f = await fixture(false, longText, undefined, longTemplate, longRoot), source = longSource
  const previous: any = structuredClone(longExtraction)
  delete previous.tags; delete previous.tag_version
  for (const value of Object.values(previous.group_cache) as any[]) { const raw = JSON.parse(value.raw); delete raw.tags; value.raw = JSON.stringify(raw) }
  f.call.mockClear()
  const next = await extractSource(f.root, 'S-0001', source, processing, f.options, 4000, previous)
  expect(f.call.mock.calls.filter(call => !JSON.parse(call[2]).summary_id).length).toBe(3)
  expect(next.tags.length).toBeGreaterThanOrEqual(3); expect(next.tags.length).toBeLessThanOrEqual(8)
})

it('P05 超长文组缓存缺 tags 且 points 类型错误时必须重提而非中断', async () => {
  const f = await fixture(false, longText, undefined, longTemplate, longRoot), source = longSource
  const previous = structuredClone(longExtraction)
  expect(Object.keys(previous.group_cache!).length).toBe(3)
  for (const value of Object.values(previous.group_cache!)) { const raw = JSON.parse(value.raw); delete raw.tags; raw.points = null; value.raw = JSON.stringify(raw) }
  f.call.mockClear()
  const next = await extractSource(f.root, 'S-0001', source, processing, f.options, 4000, previous)
  expect(f.call.mock.calls.filter(call => !JSON.parse(call[2]).summary_id).length).toBeGreaterThanOrEqual(3)
  expect(next.gaps).toEqual([])
  expect(next.segments.flatMap(segment => segment.points).map(point => point.text)).toEqual(previous.segments.flatMap(segment => segment.points).map(point => point.text))
})
