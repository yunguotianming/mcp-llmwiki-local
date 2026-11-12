import { expectModelCalls } from './layered-fixture.js'
import { stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import { publicationMetadata } from '../src/layered/frontmatter.js'
import { renderSource } from '../src/layered/extraction.js'
import { runtimeSchemaRegistry, strictSchema } from '../src/llm/protocol.js'
import { buildLayeredLibrary, readLayeredPage } from '../src/layered/index.js'
import { cleanupLayeredFixtures, snapshotManifest } from './layered-fixture.js'
import { built, extracted, fixture, header } from './tags-anchors-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
beforeAll(async () => { await built(); await built(true) })

it('Y01 四类头部对中文冒号引号井号分隔符换行及首尾空白往返无损', async () => {
  const f = await extracted('证据正文'), special = '  中文: "引号" #标签\n---\n下一行  '
  const pending: any = { manifest: { sources: [f.entry] }, card: { updated_at: f.entry.updated_at }, added: [],
    topics: { state: { topics: [{ path: 'topics/T-0001.md', aliases: [special], sources: ['S-0001'] }] } },
    terms: { records: [{ id: 'TM-0001', name: '术语', category: '概念', aliases: [special], contributions: [{ source_id: 'S-0001' }] }] } }
  const pages = ['sources/S-0001.md', 'topics/T-0001.md', 'terms/TM-0001.md', 'index.md']
  for (const page of pages) {
    const type = page.split('/')[0] === 'sources' ? 'source' : page.startsWith('topics') ? 'topic' : page.startsWith('terms') ? 'term' : 'index'
    const raw = '---\n' + stringify({ id: type === 'source' ? 'S-0001' : 'TM-0001', title: special, aliases: [special], tags: ['研究'] }) + '---\n\n正文'
    const parsed = header(publicationMetadata(pending, page, raw))
    expect(parsed.title).toBe(special); expect(parsed.type).toBe(type); expect(parsed.page_type).toBe(type)
    expect(new Date(parsed.created).toISOString()).toBe(parsed.created)
    if (type === 'index') { expect(parsed).not.toHaveProperty('aliases'); expect(parsed).not.toHaveProperty('tags') }
    else expect(parsed.aliases).toEqual([special])
  }
  f.entry.metadata.title = special
  expect(header(renderSource(f.entry, f.extraction)).title).toBe(special)
})

it('Y02 来源标题等于文件名时别名去重，术语索引不得有标签别名', async () => {
  const f = await built(true)
  expect(header(await readLayeredPage(f.knowledgeRoot, 'sources/S-0001.md')).aliases).toEqual(['审查资料'])
  const index = Object.keys(f.manifest.pages!).find(page => page.startsWith('terms/index-'))!
  expect(index).toBeTruthy()
  const meta = header(await readLayeredPage(f.knowledgeRoot, index))
  expect(meta.type).toBe('index'); expect(meta.page_type).toBe('index')
  expect(meta).not.toHaveProperty('aliases'); expect(meta).not.toHaveProperty('tags')
  await buildLayeredLibrary({ ...f.options, topics: { ...f.options.topics || {}, tagLimit: 1, tagVocabularyOnly: true }, tagVocabulary: ['研究方法'] })
  expect(header(await readLayeredPage(f.knowledgeRoot, 'sources/S-0001.md')).tags).toEqual(['研究方法'])
})

it('Y03 六个主题别名记缺口，其他主题发布且整批完成', async () => {
  const f = await fixture(true, '甲组可核验的研究证据。', (output, request) => { if (request.topic_id === 'T-0001') output.aliases = ['一', '二', '三', '四', '五', '六'] })
  f.options.embeddingClient = { embed: async texts => texts.map(text => text.includes('甲组') ? [1, 0] : [0, 1]), identity: async () => 'tags-anchors-audit' }
  await writeFile(path.join(f.knowledgeRoot, '其他资料.md'), '乙组可核验的研究证据。')
  const result = await buildLayeredLibrary(f.options), manifest = await snapshotManifest(f.root)
  const original: any = f.call.mock.calls.find(call => JSON.parse(call[2]).topic_id)?.[5]?.structuredSchema?.schema, schema = strictSchema(original)
  expect(original.properties.aliases.maxItems).toBe(5)
  expect(schema.properties.aliases.type).toBe('array'); expect(schema.properties.aliases).not.toHaveProperty('maxItems')
  expect(runtimeSchemaRegistry().find(item => item.names.includes('layered_topic'))!.internalSchema.properties.aliases.maxItems).toBe(5)
  const attempts = f.call.mock.calls.map(call => JSON.parse(call[2])).filter(request => request.topic_id === 'T-0001')
  expect(attempts).toHaveLength(3)
  const aliasError = expect.arrayContaining([expect.objectContaining({ code: 'too_big', maximum: 5, path: ['aliases'] })])
  for (const attempt of attempts.slice(1)) expect(JSON.parse(attempt.validationFeedback.error)).toEqual(aliasError)
  expect(manifest.topic_gaps).toHaveLength(1)
  expect(manifest.topic_gaps![0]!.topic_id).toBe('T-0001')
  expect(JSON.parse(manifest.topic_gaps![0]!.message)).toEqual(aliasError)
  expect(manifest.topic_gaps![0]!.point_ids.length).toBeGreaterThan(0)
  expect(manifest.pages).not.toHaveProperty('topics/T-0001.md')
  expect(manifest.pages).toHaveProperty('topics/T-0002.md')
  expect(await readLayeredPage(f.knowledgeRoot, 'topics/T-0002.md')).toContain('可核验的结论')
  expect(await readLayeredPage(f.knowledgeRoot)).toContain('主题缺口 T-0001')
  expect(manifest.log).toContain('aliases')
  expect(manifest.version).toBe(result.version)
  expect(result.unchanged).toBe(false)
  await expect(stat(path.join(f.root, 'work/pending.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('Y04 首次创建时间固化，设置重发和内容增量更新都不改变', async () => {
  const f = await built()
  const created = f.manifest.page_created!['sources/S-0001.md']!
  expect(new Date(created).toISOString()).toBe(created)
  expect(f.entry.created_at).toBe(created)
  f.call.mockClear()
  await buildLayeredLibrary({ ...f.options, tagVocabulary: ['研究方法'] })
  expectModelCalls(f.call, {}) // 向量模式默认关闭补标；设置变更的全部文本阶段精确为零。
  expect((await snapshotManifest(f.root)).page_created!['sources/S-0001.md']).toBe(created)
  await writeFile(path.join(f.knowledgeRoot, '审查资料.md'), '# 审查资料\n\n更新后的研究证据。')
  await buildLayeredLibrary(f.options)
  expect((await snapshotManifest(f.root)).page_created!['sources/S-0001.md']).toBe(created)
})

it('Y05 旧来源无 created 的升级时间必须被固化，已有非法时间不得静默发布', async () => {
  const f = await extracted('证据正文')
  const pending: any = { manifest: { sources: [f.entry] }, card: { updated_at: f.entry.updated_at }, added: [] }
  delete pending.manifest.page_created; delete pending.manifest.sources[0].created_at
  pending.manifest.sources[0].updated_at = '不是日期'
  const raw = renderSource(pending.manifest.sources[0], f.extraction)
  const actual = header(publicationMetadata(pending, 'sources/S-0001.md', raw)).created
  expect(Number.isNaN(Date.parse(actual))).toBe(false)
})
