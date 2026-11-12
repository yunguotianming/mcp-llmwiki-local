import * as fs from 'node:fs/promises'
import { rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { layeredCacheDirectory } from '../src/storage/jobs.js'
import { localDevice } from '../src/layered/devices.js'
import { putPage, writeVersion } from '../src/layered/objects.js'
import { hash } from '../src/layered/files.js'
import type { Dependencies, SourceEntry } from '../src/layered/schema.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { WikiQuery } from '../src/wiki/query.js'
import { cleanupLayeredFixtures, mockFixtureSync } from './layered-fixture.js'

export const secret = '撤权专属证据：紫色海豚在周三读取编号七三九。'
export function model(output = '{"variants":["审查证据"]}') {
  const stream = vi.fn<ModelRuntime['stream']>(async function* () {
    yield { type: 'text-delta', index: 0, text: output }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const resolveModelInfo = vi.fn<ModelRuntime['resolveModelInfo']>(async (provider, id) => ({ provider, id, name: id }))
  return { stream, resolveModelInfo }
}
export async function fixture(layered = true) {
  const parent = path.resolve(os.tmpdir()), temp = await fs.mkdtemp(path.join(parent, 'query-pages-audit-'))
  mockFixtureSync(temp)
  const root = path.join(temp, '.llmwiki')
  await fs.mkdir(root, { recursive: true })
  const put = async (relative: string, value: unknown) => {
    const file = path.join(root, relative)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, typeof value === 'string' ? value : JSON.stringify(value), 'utf8')
  }
  const sources: SourceEntry[] = []
  for (const id of layered ? ['S-0001', 'S-0002'] : []) {
    const content = id === 'S-0001' ? secret : '公开来源证据。', version = hash(content)
    const source: SourceEntry = { source_id: id, origin_type: 'local', current_path: id + '.md', previous_paths: [], content_hash: version,
      source_version: version, resource_version: [], segments: [], metadata: { title: id, source_type: '论文', credibility: 'high', credibility_reason: '夹具', source_date: '', source_date_basis: '原文' },
      files: { source: `objects/snapshots/${id}/${version.slice(7)}/source.md`, assets: [] }, extract: { path: `objects/snapshots/${id}/extract.json`, processing: { tier: 50, prompt_version: 'test', model: 'test' }, processing_fingerprint: '' }, revocation_generation: 0, updated_at: '' }
    sources.push(source)
    await put(source.files.source, content)
    await put(source.extract.path, { format_version: 1, segments: [], chapters: [
      { id: 'chapter-1', title: '方法', depth: 1, parent_id: null, paragraph_ids: [], quota: 1 },
      { id: 'chapter-2', title: '访谈', depth: 2, parent_id: 'chapter-1', paragraph_ids: [], quota: 1 },
      { id: 'chapter-3', title: '结果', depth: 1, parent_id: null, paragraph_ids: [], quota: 1 },
    ] })
  }
  const deps: Dependencies = { pages: {}, reverse: {} }, pages: Record<string, string> = layered ? { 'index.md': await putPage(root, '# 审查索引') } : {}, markdown = new Map<string, string>()
  for (const [relative, type, source] of [
    ['sources/S-0001.md', 'source', 'S-0001'], ['sources/S-0002.md', 'source', 'S-0002'],
    ['topics/T-0001.md', 'topic', 'S-0001'], ['topics/T-0001/T-0001-01.md', 'topic', 'S-0001'],
    ['topics/T-0002.md', 'topic', 'S-0002'], ['terms/TM-0001.md', 'term', 'S-0001'],
  ] as const) {
    if (!layered) break
    const content = `---\npage_type: ${type}\nid: ${path.posix.basename(relative, '.md')}\ntitle: 审查证据${source}\n---\n# 审查证据\n\n## 逐字证据 ^proof\n\n审查证据：空格  保留，标点、emoji🦊与换行\n同段第二行。${source === 'S-0001' ? secret : '公开证据。'}\n\n` +
      (type === 'source' ? '## 方法 ^chapter-1\n\n方法证据。\n\n### 访谈 ^chapter-2\n\n访谈证据。\n\n## 结果 ^chapter-3\n\n结果证据。' : '')
    pages[relative] = await putPage(root, content); markdown.set(relative, content)
    deps.pages[relative] = { sources: [source], points: [] }
  }
  if (layered) deps.pages['topics/T-0001.md']!.children = [{ page: 'topics/T-0001/T-0001-01.md', version: 'v000001' }]
  const card = { name: '审查库', domain: '审查证据', origin_type: 'local', source_type: '论文', default_credibility: 'high', source_count: 2, updated_at: '', format_version: 2 } as const
  if (layered) {
    await put('library.yaml', 'format_version: 2\norigin_type: local\n')
    await put('state/current.json', { version: 'v000001', revocation_generation: 0 })
    await put('state/revocations.json', { generation: 0, sources: [] }); await put('state/writer.json', await localDevice())
    await writeVersion(root, { format_version: 2, version: 'v000001', next_source_number: 3, revocation_generation: 0, sources, deps, aliases: {}, pages, card })
  }
  const library = Object.assign(newLibrary('query-pages-audit'), { name: '审查库', wikiPath: root }), registry = emptyRegistry()
  library.queryUnderstanding = { enabled: false }; registry.libraries = [library]
  const store = new LibraryStore(() => registry), embed = vi.fn(async (input: string[]) => input.map(() => [1, 0])), runtime = model()
  const query = new WikiQuery(store, { embed }, () => runtime)
  const database = path.join(layeredCacheDirectory(root), 'v000001-g0.sqlite')
  const addLegacy = async (id = 'public') => {
    const other = Object.assign(newLibrary(id), { name: id, kind: 'obsidian' as const, mode: 'readonly' as const, wikiPath: path.join(temp, id), queryUnderstanding: { enabled: false } })
    await fs.mkdir(path.join(other.wikiPath, 'concepts'), { recursive: true })
    await fs.writeFile(path.join(other.wikiPath, 'concepts/a.md'), '# 审查证据\n\n审查证据：公开资料。', 'utf8')
    registry.libraries.push(other); return other
  }
  const cleanup = () => {
    const target = path.resolve(temp)
    if (path.dirname(target) !== parent || !path.basename(target).startsWith('query-pages-audit-')) throw new Error('夹具清理越界')
    rmSync(target, { recursive: true, force: true })
  }
  return { root, temp, put, library, registry, store, embed, runtime, query, database, markdown, pages, addLegacy, cleanup }
}
export function sharedFixture(layered = true) {
  let f: Awaited<ReturnType<typeof fixture>>
  beforeAll(async () => { f = await fixture(layered) })
  beforeEach(() => { mockFixtureSync(f.temp); f.registry.libraries = [f.library]; f.library.queryUnderstanding = { enabled: false }; f.embed.mockClear(); f.runtime.stream.mockClear() })
  afterEach(() => { vi.useRealTimers(); cleanupLayeredFixtures() })
  afterAll(() => f?.cleanup())
  return () => f
}
