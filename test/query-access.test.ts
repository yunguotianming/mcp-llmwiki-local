import { readVersion, putPage, writeVersion } from '../src/layered/objects.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { LocalConfigStore } from '../src/local/config.js'
import { createMcpServer } from '../src/mcp/server.js'
import { askWiki } from '../src/wiki/chat.js'
import { createLibraryDiscovery, searchDiscovered } from '../src/wiki/library-reader.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'
import { fixture } from './query-pages-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

async function session(f: Awaited<ReturnType<typeof fixture>>) {
  const config = new LocalConfigStore(path.join(f.root, 'mcp-home')); await config.load()
  f.library.layered = { embeddingMode: 'none' }
  await config.writeRegistry(f.store.snapshot(), config.registry())
  const app = createMcpServer(config, f.runtime), client = new Client({ name: '查询边界测试', version: '1' })
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair()
  await app.server.connect(serverTransport); await client.connect(clientTransport)
  const execute = async (name: string, input: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: input })
    const content = (result.content as { type: string; text: string }[])[0]!.text
    if (result.isError) throw new Error(content)
    return JSON.parse(content)
  }
  return { config, execute, close: async () => { await app.jobs.close(); await client.close(); await app.server.close() } }
}

it('发现返回的库身份可直接用于检索、浏览、读页和回源', async () => {
  const f = await fixture(), app = await session(f), { execute } = app
  try {
    const catalog = await execute('wiki_list_libraries', {}) as { libraries: { libraryId: string }[] }
    const library = catalog.libraries[0]!.libraryId
    expect(library).toBe(f.library.id)
    const search = await execute('wiki_search', { library, query: '公开证据', types: ['source'] }) as { groups: { results: { path: string }[] }[] }
    const hit = search.groups[0]!.results[0]!
    expect(hit.path).toBe('sources/S-0002.md')
    expect(await execute('wiki_read', { library, path: hit.path })).toMatchObject({ status: 'ok', content: expect.stringContaining('公开证据') })
    expect(await execute('wiki_browse', { library, ref: 'S-0002' })).toMatchObject({ node: { path: hit.path } })
    expect(await execute('wiki_source_read', { library, sourceId: 'S-0002', locator: 'L1-L1' })).toMatchObject({ status: 'ok', content: '公开来源证据。' })
    expect(f.runtime.stream).not.toHaveBeenCalled()
  } finally { await app.close(); cleanupLayeredFixtures(); f.cleanup() }
})

it('主题核对失败和待恢复草稿不遮蔽已发布来源、原文及模型证据', async () => {
  const f = await fixture()
  try {
    const manifest = structuredClone(await readVersion(f.root, 'v000001')); manifest.version = 'v000002'
    delete manifest.pages!['topics/T-0002.md']; delete manifest.deps!.pages['topics/T-0002.md']
    manifest.topic_gaps = [{ topic_id: 'T-0002', point_ids: [], stage: 'review', message: 'S0 缺失、重复或判定格式错误', effect: '整页阻塞' }]
    manifest.topic_recovery = { topics: [], repairs: { 'T-0002': { protocol: '旧协议', input: '', evidence: '', content: '错误合成结论：公开来源证明月亮由奶酪构成。', member_ids: [], stage: 'review', run_id: 'old', rounds: 1, total_rounds: 1, max_rounds: 3, deadline: 0 } } }
    await writeVersion(f.root, manifest)
    await f.put('state/current.json', { version: 'v000002', revocation_generation: 0 })
    const found = await f.query.search('公开证据', f.library.name, ['source'])
    expect(found.results.some(hit => hit.path === 'sources/S-0002.md')).toBe(true)
    expect(await f.query.browse(f.library.name, 'S-0002')).toMatchObject({ node: { path: 'sources/S-0002.md' } })
    expect(await f.query.read('sources/S-0002.md', f.library.name)).toMatchObject({ status: 'ok', content: expect.stringContaining('公开证据') })
    expect(await f.query.sourceRead('S-0002', 'L1-L1', f.library.name)).toMatchObject({ status: 'ok', content: '公开来源证据。' })
    f.library.models.unified = { provider: 'fake', model: 'fake' }
    f.runtime.resolveModelInfo.mockResolvedValue({ provider: 'fake', id: 'fake', name: 'fake', context: { contextWindow: 32768 } } as never)
    f.runtime.stream.mockImplementation(async function* (options) {
      const input = JSON.stringify(options)
      expect(input).toContain('公开证据'); expect(input).not.toContain('月亮由奶酪构成')
      expect(input).toContain('不把未核实主张写成已核实事实')
      yield { type: 'text-delta', text: '{"units":[{"block":"paragraph","text":"公开证据见来源。","citationIds":[1]}]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const answer = await askWiki(f.store, f.library.id, '公开证据', [], f.runtime)
    expect(f.runtime.stream).toHaveBeenCalledTimes(1)
    expect(answer.citations[0]!.path).toBe('sources/S-0002.md')
  } finally { cleanupLayeredFixtures(); f.cleanup() }
})

it('坏主题只返回格式降级，工具仍可检索来源、读页并回原文', async () => {
  const f = await fixture(), app = await session(f), { execute } = app
  try {
    const manifest = structuredClone(await readVersion(f.root, 'v000001')); manifest.version = 'v000002'
    manifest.pages!['topics/T-0002.md'] = await putPage(f.root, '---\npage_type: topic\ntitle: [损坏格式\n---\n# 错误主题\n\n不能当作核实知识。')
    await writeVersion(f.root, manifest)
    await f.put('state/current.json', { version: 'v000002', revocation_generation: 0 })
    const before = JSON.stringify(await readVersion(f.root, 'v000002'))
    const args = { library: f.library.id, query: '公开证据' }
    const found = await execute('wiki_search', args) as { groups: { results: { path: string }[] }[]; degradations: { reason: string; message: string }[] }
    expect(found.groups[0]!.results.some(hit => hit.path === 'sources/S-0002.md')).toBe(true)
    expect(found.groups[0]!.results.some(hit => hit.path === 'topics/T-0002.md')).toBe(false)
    expect(found.degradations).toContainEqual(expect.objectContaining({ reason: 'page-metadata-invalid', message: expect.stringContaining('topics/T-0002.md') }))
    expect((await execute('wiki_search', args) as typeof found).degradations).toEqual(found.degradations)
    expect(await execute('wiki_browse', { library: f.library.id, ref: 'S-0002' })).toMatchObject({ node: { path: 'sources/S-0002.md' }, warning: expect.stringContaining('topics/T-0002.md') })
    expect(await execute('wiki_read', { library: f.library.id, path: '审查证据S-0002' })).toMatchObject({ status: 'ok', path: 'sources/S-0002.md' })
    expect(await execute('wiki_source_read', { library: f.library.id, sourceId: 'S-0002', locator: 'L1-L1' })).toMatchObject({ status: 'ok', content: '公开来源证据。' })
    await expect(execute('wiki_read', { library: f.library.id, path: 'topics/T-0002.md' })).rejects.toThrow('页面元数据格式无效')
    expect(JSON.stringify(await readVersion(f.root, 'v000002'))).toBe(before)
    expect(f.runtime.stream).not.toHaveBeenCalled()
    f.library.models.unified = { provider: 'fake', model: 'fake' }
    f.runtime.stream.mockImplementation(async function* (options) {
      const input = JSON.stringify(options)
      expect(input).toContain('公开证据'); expect(input).not.toContain('不能当作核实知识')
      yield { type: 'text-delta', text: '{"units":[{"block":"paragraph","text":"公开证据见来源。","citationIds":[1]}]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    expect((await askWiki(f.store, f.library.id, '公开证据', [], f.runtime)).citations[0]!.path).toBe('sources/S-0002.md')
    expect(f.runtime.stream).toHaveBeenCalledTimes(1)
  } finally { await app.close(); cleanupLayeredFixtures(); f.cleanup() }
})

it('精确库身份优先于同名登记，禁用身份不能回退读取同名库', async () => {
  const f = await fixture()
  try {
    const other = await f.addLegacy('other'); other.name = f.library.id
    f.registry.libraries = [other, f.library]
    const discovery = createLibraryDiscovery(f.store)
    const found = await searchDiscovered(f.store, discovery, '公开证据', f.library.id)
    expect(found.groups.map(group => group.libraryId)).toEqual([f.library.id])
    expect(await f.query.read('S-0002', f.library.id)).toMatchObject({ path: 'sources/S-0002.md' })
    expect(await f.query.sourceRead('S-0002', 'L1-L1', f.library.id)).toMatchObject({ status: 'ok', content: '公开来源证据。' })
    other.name = f.library.name
    const app = await session(f), { execute } = app
    try {
      const catalog = await execute('wiki_list_libraries', {}) as { libraries: { libraryId: string }[] }
      const library = catalog.libraries.find(item => item.libraryId === f.library.id)!.libraryId
      expect((await execute('wiki_search', { library, query: '公开证据' })).groups.map((group: { libraryId: string }) => group.libraryId)).toEqual([library])
      expect(await execute('wiki_browse', { library, ref: 'S-0002' })).toMatchObject({ node: { path: 'sources/S-0002.md' } })
      expect(await execute('wiki_read', { library, path: 'S-0002' })).toMatchObject({ path: 'sources/S-0002.md' })
      expect(await execute('wiki_source_read', { library, sourceId: 'S-0002', locator: 'L1-L1' })).toMatchObject({ status: 'ok', content: '公开来源证据。' })
      f.library.enabled = false
      await app.config.writeRegistry(f.store.snapshot(), app.config.registry())
      await expect(execute('wiki_search', { library, query: '公开证据' })).rejects.toThrow()
      await expect(execute('wiki_browse', { library, ref: 'S-0002' })).rejects.toThrow('未找到已启用本地 Wiki')
      await expect(execute('wiki_read', { library, path: 'S-0002' })).rejects.toThrow('未找到已启用本地 Wiki')
      await expect(execute('wiki_source_read', { library, sourceId: 'S-0002', locator: 'L1-L1' })).rejects.toThrow('未找到已启用 Wiki')
      expect(f.runtime.stream).not.toHaveBeenCalled()
    } finally { await app.close() }
  } finally { cleanupLayeredFixtures(); f.cleanup() }
})

it('元数据隔离不吞来源快照损坏、路径越界及撤权限制', async () => {
  const f = await fixture()
  try {
    await expect(f.query.read('../state/current.json', f.library.id)).rejects.toThrow()
    await f.put('state/revocations.json', { generation: 1, sources: [{ source_id: 'S-0002', generation: 1, current_path: 'S-0002.md', reason: '用户撤权', revoked_at: '2026-11-15T00:00:00Z' }] })
    expect(await f.query.sourceRead('S-0002', 'L1-L1', f.library.id)).toMatchObject({ status: 'updating' })
    expect((await f.query.search('公开证据', f.library.id)).results.some(hit => hit.path === 'sources/S-0002.md')).toBe(false)
    const manifest = await readVersion(f.root, 'v000001'), source = manifest.sources.find(source => source.source_id === 'S-0001')!
    await f.put(source.files.source, '被篡改的原文')
    await expect(f.query.search('审查证据', f.library.id)).rejects.toThrow('校验失败')
  } finally { cleanupLayeredFixtures(); f.cleanup() }
})

it('未闭合页头隔离且无页头索引和虚拟章节仍可读', async () => {
  const f = await fixture()
  try {
    const manifest = structuredClone(await readVersion(f.root, 'v000001')); manifest.version = 'v000002'
    manifest.pages!['topics/T-0002.md'] = await putPage(f.root, '---\npage_type: topic\ntitle: 未闭合主题\n\n# 错误页头')
    await writeVersion(f.root, manifest)
    await f.put('state/current.json', { version: 'v000002', revocation_generation: 0 })
    const browse = await f.query.browse(f.library.id, 'root', { depth: 2 })
    expect(browse.children.some(node => node.path === 'topics/T-0002.md')).toBe(false)
    expect(browse.warning).toContain('topics/T-0002.md')
    expect((await f.query.search('公开证据', f.library.id)).results.some(hit => hit.path === 'sources/S-0002.md')).toBe(true)
    await expect(f.query.read('topics/T-0002.md', f.library.id)).rejects.toThrow('页面元数据格式无效')
    expect(await f.query.read('index.md', f.library.id)).toMatchObject({ status: 'ok', type: 'navigation', content: expect.stringContaining('审查索引') })
    expect(await f.query.read('sources/S-0002.md#^chapter-1', f.library.id)).toMatchObject({ status: 'ok', type: 'source', content: expect.stringContaining('方法证据') })
    expect(f.runtime.stream).not.toHaveBeenCalled()
  } finally { cleanupLayeredFixtures(); f.cleanup() }
})
