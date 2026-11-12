import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { emptyRegistry } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { layeredCacheDirectory, layeredIndex } from '../src/storage/jobs.js'
import { WikiQuery } from '../src/wiki/query.js'
import * as layeredFiles from '../src/layered/files.js'
import { topicHeader } from '../src/layered/topics.js'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import * as hierarchy from '../src/layered/hierarchy.js'
import * as publication from '../src/layered/publication.js'
import { buildLayeredLibrary, readLayeredPage } from '../src/layered/index.js'
import { putPage, readVersion, versionPage, writeVersion } from '../src/layered/objects.js'
import { writeJson } from '../src/layered/files.js'
import { renderSource } from '../src/layered/extraction.js'
import { hydrateVectors } from '../src/layered/vectors.js'
import type { PendingBuild, Topic } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, layeredFixture, layeredIncrementalFixture, shareLayeredFixture, snapshotManifest } from './layered-fixture.js'
import type { FixtureSnapshot, TopicInput } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

const settings = { topicMaxSources: 4, topicMaxDepth: 1, topicMergeMinSources: 2 }
let template: FixtureSnapshot, reuseRoot: string

async function fixture(saved?: FixtureSnapshot, directory?: string) {
  const f = await layeredIncrementalFixture(saved, directory), original = f.call.getMockImplementation()!
  // 本用例只验证成员转移与发布，每条输入要点都保留引用。
  f.call.mockImplementation(async (...args) => {
    const output = JSON.parse(await original(...args)), input = JSON.parse(args[2]) as TopicInput
    if (input.topic_id && !input.children && output.conditions) {
      output.conditions = [...(input.current_points ?? []), ...input.points].map(point => ({ text: point.text, point_ids: [point.point_id] }))
    }
    return JSON.stringify(output)
  })
  return { ...f, options: { ...f.options, topics: settings } }
}

beforeAll(async () => {
  const f = await fixture()
  for (let i = 0; i < 6; i++) await writeFile(path.join(f.knowledgeRoot, `${i}.md`), `# 资料${i}\n\n甲组证据${i}。`)
  await buildLayeredLibrary(f.options)
  template = await shareLayeredFixture(f); reuseRoot = f.knowledgeRoot
})

async function shrunkenFixture() {
  const f = await fixture(template, reuseRoot), manifest = await snapshotManifest(f.root)
  const leaves = manifest.topics!.topics.filter(topic => topic.parent_id).sort((a, b) => a.id.localeCompare(b.id))
  expect(leaves).toHaveLength(2)
  const [target, source] = leaves as [Topic, Topic]
  expect(source.sources).toHaveLength(3); expect(target.sources).toHaveLength(3)
  const emptied = source.sources.slice(1)
  // 保留来源和原题，只删正文要点；直接删文件会先撤权并清理旧树，无法验证来源数收缩。
  for (const id of emptied) {
    const file = path.join(f.knowledgeRoot, manifest.sources.find(entry => entry.source_id === id)!.current_path)
    await writeFile(file, (await readFile(file, 'utf8')).split('\n')[0]! + '\n')
  }
  const points = [...target.point_ids, ...source.point_ids.filter(id => !emptied.includes(id.split(':')[0]!))].sort()
  return { ...f, source, target, points }
}

async function expectMerged(f: Awaited<ReturnType<typeof shrunkenFixture>>, version: string) {
  const manifest = await snapshotManifest(f.root), parent = manifest.topics!.topics.find(topic => topic.id === f.target.parent_id)!
  expect(manifest.aliases).toEqual({ [f.source.id]: f.target.id })
  expect(manifest.topics!.topics.map(topic => topic.id).sort()).toEqual([parent.id, f.target.id].sort())
  expect(manifest.topics!.topics.find(topic => topic.id === f.target.id)!.point_ids).toEqual(f.points)
  expect(Object.keys(manifest.pages!).filter(page => page.startsWith('topics/')).sort()).toEqual([parent.path, f.target.path].sort())
  expect(manifest.deps!.pages[f.source.path]).toBeUndefined()
  expect(manifest.deps!.pages[f.target.path]!.points.map(point => point.point_id).sort()).toEqual(f.points)
  expect(manifest.deps!.pages[parent.path]!.children).toEqual([{ page: f.target.path, version }])
  expect(Object.values(manifest.deps!.reverse).flat()).not.toContain(f.source.path)
  expect(await readLayeredPage(f.knowledgeRoot)).not.toContain(f.source.path)
  expect(await readLayeredPage(f.knowledgeRoot, parent.id)).not.toContain(path.posix.basename(f.source.path))
  const target = await readLayeredPage(f.knowledgeRoot, f.target.id)
  expect(await readLayeredPage(f.knowledgeRoot, f.source.id)).toBe(target)
  expect(await readLayeredPage(f.knowledgeRoot, f.source.path)).toBe(target)
  expect(await readFile(path.join(f.root, 'wiki', f.target.path), 'utf8')).toBe(target)
  await expect(readFile(path.join(f.root, 'wiki', f.source.path))).rejects.toMatchObject({ code: 'ENOENT' })
  const state = JSON.parse(await readFile(path.join(f.root, 'state/topics.json'), 'utf8'))
  expect(state.topics.map((topic: Topic) => topic.id).sort()).toEqual([parent.id, f.target.id].sort())
  await expect(publication.validatePublication(f.root, version)).resolves.toBeUndefined()
}

async function legacyPendingFixture() {
  const f = await shrunkenFixture(), merge = hierarchy.mergeShrunken
  // 复现旧版本的合并产物，让主题阶段保存真实页面和输入指纹。
  const legacy = vi.spyOn(hierarchy, 'mergeShrunken').mockImplementation((state, previous, minimum, aliases) => {
    const before = structuredClone(state.topics), rebuilt = merge(state, previous, minimum, aliases)
    state.topics.push(...before.filter(topic => aliases[topic.id] && !state.topics.some(current => current.id === topic.id))
      .map(topic => ({ ...topic, archived: true })))
    hierarchy.refreshTree(state)
    return rebuilt
  })
  const interrupted = vi.spyOn(publication, 'publishLibrary').mockRejectedValue(new Error('模拟旧版发布中断'))
  try { await expect(buildLayeredLibrary(f.options)).rejects.toThrow('模拟旧版发布中断') }
  finally { legacy.mockRestore(); interrupted.mockRestore() }
  // 检查点通过 content_id 外置正文，按真实续跑入口还原后再检查内容。
  const file = path.join(f.root, 'work/pending.json'), pending = await hydrateVectors(f.root, JSON.parse(await readFile(file, 'utf8')) as PendingBuild)
  expect(pending.topics!.aliases).toEqual({ [f.source.id]: f.target.id })
  expect(pending.topics!.state.topics.find(topic => topic.id === f.source.id)?.archived).toBe(true)
  expect(pending.topics!.pages[f.source.path]!.content).toContain('archived: true')
  expect(pending.topics!.state.topics.find(topic => topic.id === f.target.id)!.point_ids).toEqual(f.points)
  pending.manifest.aliases = { ...pending.topics!.aliases }
  await writeJson(f.root, 'work/pending.json', pending)
  const extracts = await Promise.all(pending.manifest.sources.map(source => readFile(path.join(f.root, source.extract.path), 'utf8')))
  return { ...f, pending, extracts }
}

describe('合并发布回归', () => {
  it('收缩合并后只发布目标实体并保留源编号重定向及全部剩余要点', async () => {
    const f = await shrunkenFixture()
    expect(await readFile(path.join(f.root, 'wiki', f.source.path), 'utf8')).toContain(f.source.id)
    const result = await buildLayeredLibrary(f.options)
    await expectMerged(f, result.version)
  })

  it('旧 pending 同时有归档实体和重定向时零模型调用续跑发布', async () => {
    const f = await legacyPendingFixture()
    f.call.mockClear()
    const result = await buildLayeredLibrary(f.options)
    expect(result.modelCalls).toBe(0); expect(f.call).not.toHaveBeenCalled()
    expect(await Promise.all(f.pending.manifest.sources.map(source => readFile(path.join(f.root, source.extract.path), 'utf8')))).toEqual(f.extracts)
    await expectMerged(f, result.version)
  })

  it('兼容清理后再次中断再续跑仍零模型调用且与一次跑完相同', async () => {
    const f = await legacyPendingFixture(), saved = await shareLayeredFixture(f)
    const parentPath = f.pending.topics!.state.topics.find(topic => topic.id === f.target.parent_id)!.path
    const previous = f.pending.topics!.pages[parentPath]!, persist = layeredFiles.writeJson
    expect(previous.dependencies.review?.fingerprint).toBeTruthy()
    let cleaned = false
    const interrupted = vi.spyOn(layeredFiles, 'writeJson').mockImplementation(async (root, relative, value) => {
      await persist(root, relative, value)
      const pending = value as PendingBuild
      if (root === f.root && relative === 'work/pending.json' && pending.topics
        && !pending.topics.state.topics.some(topic => topic.id === f.source.id)) {
        cleaned = true
        throw new Error('模拟清理后再次中断')
      }
    })
    f.call.mockClear(); f.call.mockRejectedValue(new Error('兼容续跑不应调用模型'))
    try { await expect(buildLayeredLibrary(f.options)).rejects.toThrow('模拟清理后再次中断') }
    finally { interrupted.mockRestore() }
    expect(cleaned).toBe(true); expect(f.call).not.toHaveBeenCalled()
    const pending = await hydrateVectors(f.root, JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8')) as PendingBuild)
    const parent = pending.topics!.pages[parentPath]!
    expect(parent.input_fingerprint).not.toBe(previous.input_fingerprint)
    expect(topicHeader(parent.content).input_fingerprint).toBe(parent.input_fingerprint)
    expect(parent.dependencies.review!.fingerprint).not.toBe(previous.dependencies.review!.fingerprint)
    expect(parent.dependencies.children!.map(child => child.page)).toEqual([f.target.path])
    const result = await buildLayeredLibrary(f.options)
    expect(result.modelCalls).toBe(0); expect(f.call).not.toHaveBeenCalled()
    await expectMerged(f, result.version)
    const actual = await mergedPublication(f)
    const once = { ...f, ...await fixture(saved, f.knowledgeRoot) }
    once.call.mockClear(); once.call.mockRejectedValue(new Error('一次续跑不应调用模型'))
    const direct = await buildLayeredLibrary(once.options)
    expect(direct.modelCalls).toBe(0); expect(once.call).not.toHaveBeenCalled()
    await expectMerged(once, direct.version)
    expect(await mergedPublication(once)).toEqual(actual)
    expect(await Promise.all(f.pending.manifest.sources.map(source => readFile(path.join(once.root, source.extract.path), 'utf8')))).toEqual(f.extracts)
  })

  it('别名链 A→B→C 的中间目标也是别名时拒绝发布', async () => {
    const f = await invalidAliasFixture(), [source, middle] = f.pending.topics!.state.topics.filter(topic => topic.parent_id) as [Topic, Topic]
    const target = f.pending.topics!.state.topics.find(topic => !topic.parent_id)!
    source.archived = true; middle.archived = true
    f.pending.topics!.aliases = { [source.id]: middle.id, [middle.id]: target.id }
    await expect(publication.publishLibrary(f.root, f.pending)).rejects.toThrow('主题别名目标无效')
    expect((await publication.readCurrent(f.root))!.version).toBe(f.pending.base_version)
  })

  it('实际查询中旧 ID 和旧路径重定向到目标且索引不含源实体', async () => {
    const f = await shrunkenFixture(), registry = emptyRegistry()
    f.library.name = '合并查询库'; f.library.wikiPath = f.knowledgeRoot; f.library.queryUnderstanding = { enabled: false }
    registry.libraries = [f.library]
    const query = new WikiQuery(new LibraryStore(() => registry), f.options.embeddingClient)
    const cache = layeredCacheDirectory(f.root)
    try {
      await query.search('甲组', f.library.name, ['topic'], 20)
      const before = await layeredIndex<{ path: string }[]>(f.root, 'index-read')
      expect(before.map(row => row.path)).toContain(f.source.path)
      await buildLayeredLibrary(f.options)
      const target = await query.read(f.target.id, f.library.name)
      for (const link of [f.source.id, f.source.path]) {
        const redirected = await query.read(link, f.library.name)
        expect(redirected).toMatchObject({ status: 'ok', path: f.target.path, content: target.content })
      }
      const search = await query.search('甲组', f.library.name, ['topic'], 20)
      expect(search.results.map(hit => hit.path)).toContain(f.target.path)
      expect(search.results.map(hit => hit.path)).not.toContain(f.source.path)
      const rows = await layeredIndex<{ path: string; data: string }[]>(f.root, 'index-read')
      expect(rows.map(row => row.path)).toContain(f.target.path)
      expect(rows.map(row => row.path)).not.toContain(f.source.path)
      expect(rows.map(row => JSON.parse(row.data).id)).not.toContain(f.source.id)
    } finally { await rm(cache, { recursive: true, force: true }) }
  })

  it('归档源的别名目标不存在仍拒绝发布', async () => {
    const f = await invalidAliasFixture(), source = f.pending.topics!.state.topics.find(topic => topic.parent_id)!
    source.archived = true
    f.pending.topics!.aliases = { [source.id]: 'T-9999' }
    await expect(publication.publishLibrary(f.root, f.pending)).rejects.toThrow('主题别名目标无效')
    expect((await publication.readCurrent(f.root))!.version).toBe(f.pending.base_version)
  })

  it('归档源的别名成环仍拒绝发布', async () => {
    const f = await invalidAliasFixture(), [left, right] = f.pending.topics!.state.topics.filter(topic => topic.parent_id) as [Topic, Topic]
    left.archived = true; right.archived = true
    f.pending.topics!.aliases = { [left.id]: right.id, [right.id]: left.id }
    await expect(publication.publishLibrary(f.root, f.pending)).rejects.toThrow('主题别名目标无效')
    expect((await publication.readCurrent(f.root))!.version).toBe(f.pending.base_version)
  })

  it('旧来源页带传输缺口时零模型调用续跑发布，新页面缺少重试提示仍拒绝', async () => {
    const f = await layeredFixture(), original = f.call.getMockImplementation()!
    await writeFile(path.join(f.knowledgeRoot, 'a.md'), '连接失败时保留来源与提取缺口。')
    f.call.mockImplementation(async (...args) => {
      if (JSON.parse(args[2]).paragraphs) throw new Error('Connection error.')
      return original(...args)
    })
    await buildLayeredLibrary(f.options)
    const manifest = await snapshotManifest(f.root), entry = manifest.sources[0]!, page = `sources/${entry.source_id}.md`
    const extraction = await publication.readExtraction(f.root, entry.extract.path)
    expect(extraction.gaps).toMatchObject([{ kind: 'group', retryable: true }])
    // 旧提取对象没有 retryable 字段，旧来源页也没有提示；保留其余真实建库产物。
    for (const gap of extraction.gaps!) delete gap.retryable
    entry.extract.path = entry.extract.path.replace(/\.json$/, '-legacy.json')
    await writeJson(f.root, entry.extract.path, extraction)
    const extractionBytes = await readFile(path.join(f.root, entry.extract.path), 'utf8')
    const hint = '（可重试，下次建库自动重提）', expected = renderSource(entry, extraction)
    expect(expected).toContain(hint)
    const legacyPage = expected.replaceAll(hint, '')
    manifest.pages![page] = await putPage(f.root, legacyPage)
    manifest.version = 'v000002'; delete manifest.source_page_format
    await writeVersion(f.root, manifest)
    await writeJson(f.root, 'state/current.json', { version: manifest.version, revocation_generation: manifest.revocation_generation })
    await expect(publication.validatePublication(f.root, manifest.version)).resolves.toBeUndefined()
    const pending: PendingBuild = { format_version: manifest.format_version, base_version: manifest.version, version: null,
      manifest, card: manifest.card!, added: [], model_calls: 0, started_at: new Date().toISOString() }
    await writeJson(f.root, 'work/pending.json', pending)
    f.call.mockClear(); f.call.mockRejectedValue(new Error('发布续跑不应调用模型'))
    const resumed = await hydrateVectors(f.root, JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8')) as PendingBuild)
    const version = await publication.publishLibrary(f.root, resumed, undefined, true, f.options)
    expect(resumed.model_calls).toBe(0); expect(f.call).not.toHaveBeenCalled()
    expect((await publication.readCurrent(f.root))!.version).toBe(version)
    expect(await readLayeredPage(f.knowledgeRoot, page)).toContain(hint)
    expect(await readFile(path.join(f.root, entry.extract.path), 'utf8')).toBe(extractionBytes)
    await expect(publication.validatePublication(f.root, version)).resolves.toBeUndefined()
    const invalid = await readVersion(f.root, version)
    expect(invalid.source_page_format).toBe('retryable-gaps-v1')
    invalid.version = 'v000004'; invalid.pages![page] = await putPage(f.root, legacyPage)
    await writeVersion(f.root, invalid)
    await expect(publication.validatePublication(f.root, invalid.version)).rejects.toThrow('来源页与提取快照不一致')
    // 兼容旧页不能接受正文或缺口原因发生变化。
    invalid.version = 'v000005'; delete invalid.source_page_format
    invalid.pages![page] = await putPage(f.root, legacyPage.replace('Connection error.', '原因被篡改'))
    await writeVersion(f.root, invalid)
    await expect(publication.validatePublication(f.root, invalid.version)).rejects.toThrow('来源页与提取快照不一致')
  })
})

async function mergedPublication(f: { root: string }) {
  const manifest = await snapshotManifest(f.root), deps = structuredClone(manifest.deps!)
  for (const dependency of Object.values(deps.pages)) for (const child of dependency.children ?? []) child.version = '本次版本'
  const pages = Object.fromEntries(await Promise.all(manifest.topics!.topics.map(async topic =>
    [topic.path, (await versionPage(f.root, manifest, topic.path)).replace(/^created:.*\n/gm, '')] as const)))
  // 首次发布时间和版本号随发布尝试变化，主题正文、成员、重定向与依赖必须一致。
  return { topics: manifest.topics!.topics, aliases: manifest.aliases, deps, pages }
}

async function invalidAliasFixture() {
  const f = await fixture(template, reuseRoot), manifest = await snapshotManifest(f.root)
  const pages = Object.fromEntries(await Promise.all(manifest.topics!.topics.map(async topic => [topic.path,
    { content: await versionPage(f.root, manifest, topic.path), dependencies: manifest.deps!.pages[topic.path]! }] as const)))
  const pending: PendingBuild = { format_version: manifest.format_version, base_version: manifest.version, version: null,
    manifest, card: manifest.card!, added: [], model_calls: 0, started_at: new Date().toISOString(),
    topics: { fingerprint: '别名校验', state: manifest.topics!, pages, rewritten: [], model_calls: 0, aliases: {} } }
  return { ...f, pending }
}
