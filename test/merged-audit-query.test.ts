import { unlink } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { vectorPath } from '../src/layered/vectors.js'
import { LayeredQuery } from '../src/wiki/layered-query.js'
import { WikiQuery } from '../src/wiki/query.js'
import { excerpts } from '../src/wiki/page-search.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { emptyRegistry } from '../src/domain/config.js'
import { cleanupLayeredFixtures, snapshotManifest } from './layered-fixture.js'
import { auditFixture, largeVectors } from './merged-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => { vi.unstubAllGlobals(); cleanupLayeredFixtures() })

it('M13 物理缺失全部要点向量时全文命中并标0覆盖，查询不嵌入整页', async () => {
  const f = await auditFixture(); await buildLayeredLibrary(f.options)
  const manifest = await snapshotManifest(f.root)
  for (const id of new Set(Object.values(manifest.topics!.vectors).map(ref => ref.vector_id!))) await unlink(path.join(f.root, vectorPath(id)))
  const embed = vi.fn(async (inputs: string[]) => inputs.map(() => [1, 0]))
  const result = await new LayeredQuery({ identity: f.options.embeddingClient!.identity!, embed }).search(f.library, { root: f.root, card: manifest.card! }, '研究结果')
  expect(result.value.length).toBeGreaterThan(0)
  expect(result.value.every(hit => hit.retrieval === 'fts')).toBe(true)
  expect(result.notices).toContainEqual(expect.objectContaining({ reason: 'partial-coverage', message: expect.stringContaining('0/4') }))
  expect(embed.mock.calls.map(call => call[0])).toEqual([['Instruct: Given a web search query, retrieve relevant passages that answer the query\nQuery: 研究结果']])
})

it('M14 同维度异权重只走全文，不嵌入且不改库身份', async () => {
  const f = await auditFixture(); await buildLayeredLibrary(f.options)
  const manifest = await snapshotManifest(f.root), embed = vi.fn(async (inputs: string[]) => inputs.map(() => [1, 0]))
  const result = await new LayeredQuery({ identity: async () => '别的权重但同维度', embed }).search(f.library, { root: f.root, card: manifest.card! }, '研究结果')
  expect(result.degradation).toBeDefined(); expect(result.value.length).toBeGreaterThan(0)
  expect(result.value.every(hit => hit.retrieval === 'fts')).toBe(true)
  expect(embed).not.toHaveBeenCalled()
  expect((await snapshotManifest(f.root)).vector_state).toEqual(manifest.vector_state)
})

it('M15 两库异维身份各嵌入查询词，库内融合后跨库按名次融合', async () => {
  const small = await auditFixture(), large = await auditFixture(), registry = emptyRegistry()
  largeVectors(large)
  for (const [i, f] of [small, large].entries()) {
    await buildLayeredLibrary(f.options)
    f.library.id = 'merged-audit-' + i; f.library.name = '反例库' + i; f.library.wikiPath = f.root
    f.library.layered = { localEmbeddingUrl: 'http://merged-audit-' + i, localEmbeddingModel: '错误的设备默认' }
    registry.libraries.push(f.library)
  }
  const calls: { model: string; input: string[] }[] = []
  vi.stubGlobal('fetch', async (url: string | URL | Request, init?: RequestInit) => {
    const small = String(url).includes('audit-0'), model = small ? 'qwen3-embedding:0.6b' : 'qwen3-embedding:8b'
    if (String(url).endsWith('/api/tags')) return Response.json({ models: [{ name: model, digest: small ? 'fixture-weights-v1' : 'large-weights' }] })
    if (!String(url).endsWith('/api/embed')) throw new Error('反例不允许其他网络调用')
    const body = JSON.parse(String(init?.body)); calls.push(body)
    return Response.json({ embeddings: body.input.map(() => small ? [1, 0] : [1, 0, 0, 0]) })
  })
  const result = await new WikiQuery(new LibraryStore(() => registry)).search('研究结果')
  expect(calls.map(c => c.model).sort()).toEqual(['qwen3-embedding:0.6b', 'qwen3-embedding:8b'])
  expect(calls.map(c => c.input.length)).toEqual([1, 1])
  expect(result.groups).toHaveLength(2)
  for (const group of result.groups) {
    const first = group.results[0]!
    expect(result.results.find(hit => hit.library === first.library && hit.path === first.path)!.score).toBe(1 / 61)
    expect(first.retrieval).toBe('hybrid')
  }
})

it('M16 中后部答案与查询变体优先，摘录每段都是带行号的原文连续子串', () => {
  const content = '# 研究资料\n\n' + '研究背景与研究过程。'.repeat(100) + '\n\n## 测验\n\n答对8题通过；未通过可免费重考。\n第二行保留例外条件。\n\n其他材料。'
  const result = excerpts({ library: '反例库', path: 'sources/S-0001.md', title: '研究资料', content }, ['补考费用', '免费重考'], 100)
  expect(result[0]!.content).toContain('未通过可免费重考')
  for (const item of result) {
    expect(content).toContain(item.content)
    const [, first, last] = /^L(\d+)-L(\d+)$/.exec(item.locator)!
    expect(content.split('\n').slice(Number(first) - 1, Number(last)).join('\n').startsWith(item.content)).toBe(true)
  }
})
