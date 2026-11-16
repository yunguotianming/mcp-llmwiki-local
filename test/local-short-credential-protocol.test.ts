import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalConfigStore } from '../src/local/config.js'
import { createMcpServer } from '../src/mcp/server.js'
import { createLocalHost } from '../src/local/host.js'
import { runCli } from '../src/cli.js'
import { LocalJobs } from '../src/local/jobs.js'
import * as copies from '../src/local/query-vectors.js'
import { ChangeStore } from '../src/storage/changes.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { readCurrent } from '../src/layered/objects.js'
import { publicResult } from '../src/host/public-results.js'
import { registryRevision } from '../src/wiki/library-discovery.js'
import { temporaryWorkspace } from './temp.js'
import { fixture } from './query-pages-audit-fixture.js'
import { cleanupLayeredFixtures, modelOutput, mockSupportReview, type ExtractionInput } from './layered-fixture.js'
import type { ModelRuntime } from '../src/llm/client.js'

const cleanups: (() => Promise<unknown> | unknown)[] = []
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
const provider = (apiKey: string) => ({ 'compatible:fixture': { baseUrl: 'https://offline.invalid/v1', model: 'fixture', api: 'openai-responses' as const, apiKey } })
const fake: ModelRuntime = {
  async resolveModelInfo(provider, id) { return { provider, id, name: id, context: { contextWindow: 32768 }, reasoning: { efforts: [{ id: 'high', name: '高' }] } } },
  async *stream(options) {
    const input = JSON.parse((options.messages[0]!.content[0] as { text: string }).text)
    yield { type: 'text-delta', index: 0, text: mockSupportReview(input) ?? modelOutput(input as ExtractionInput) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
  cleanupLayeredFixtures(); vi.restoreAllMocks(); vi.unstubAllEnvs()
})
async function session(config: LocalConfigStore) {
  const app = createMcpServer(config, fake), client = new Client({ name: '短凭据协议验证', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await app.server.connect(a); await client.connect(b)
  cleanups.push(async () => { await app.jobs.close(); await client.close(); await app.server.close() })
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args })
    if (result.isError) throw new Error(JSON.stringify(result))
    return JSON.parse((result.content as { text: string }[])[0]!.text)
  }
  return { ...app, client, call }
}
async function querySetup(key: string) {
  const f = await fixture(); cleanups.push(f.cleanup)
  f.library.id = '10000000-0000-4000-8000-000000000001'
  f.library.name = '名称凭据=' + key; f.library.description = JSON.stringify({ detail: JSON.stringify({ key }) })
  f.library.layered = { embeddingMode: 'none' }; f.registry.compatibleProviders = provider(key)
  const config = new LocalConfigStore(path.join(f.temp, 'home')); await config.load()
  await config.writeRegistry(f.registry, config.registry())
  return { ...f, config }
}
async function finished(call: Awaited<ReturnType<typeof session>>['call'], jobId: string) {
  let status: Record<string, any>
  await vi.waitFor(async () => { status = await call('wiki_status', { jobId, includePreview: true }); expect(status.status).not.toBe('running') }, { timeout: 15000 })
  return status!
}

it('key=1时假模型生成、落盘、预览签名与提交保持同一协议身份', async () => {
  const f = await temporaryWorkspace(); cleanups.push(f.cleanup)
  const source = path.join(f.root, '资料1'); await mkdir(source)
  await writeFile(path.join(source, '研究1.md'), '研究记录指出，温度升高会影响样本观察结果。凭据=1。')
  const config = new LocalConfigStore(path.join(f.root, 'home')); await config.load(); await config.add(source)
  const old = config.registry(), next = structuredClone(old), library = next.libraries[0]!
  library.id = '10000000-0000-4000-8000-000000000001'; next.activeLibraryId = library.id
  library.models.unified = { provider: 'fake', model: 'fake' }
  library.layered = { embeddingMode: 'none', extractionReview: 'off', topicReview: false }
  next.compatibleProviders = provider('1'); await config.writeRegistry(next, old)
  const app = await session(config), start = await app.call('wiki_generate', { libraryId: library.id })
  expect(start).toMatchObject({ libraryId: library.id, status: 'running' }); expect(start.jobId).toMatch(/^[a-f0-9-]{36}$/)
  const status = await finished(app.call, start.jobId)
  expect(status.status, status.error).toBe('preview'); expect(status.jobId).toBe(start.jobId)
  const saved = JSON.parse(await readFile(path.join(config.home, 'jobs', start.jobId + '.json'), 'utf8'))
  expect(saved).toMatchObject({ jobId: start.jobId, libraryId: library.id, batchId: status.batchId, ownerPid: process.pid })
  expect(saved.result.version).toBe(status.result.version); expect(saved.result.version).toMatch(/^v\d+$/)
  const preview = await new ChangeStore(new LibraryStore(config.registry)).preview(library.id, status.batchId)
  expect(status.digest).toBe(preview.batch.digest); expect(status.preview.map((page: { path: string }) => page.path)).toEqual(preview.pages.map(page => page.path))
  expect(JSON.stringify(status.preview.map((page: { after: string }) => page.after))).not.toContain('凭据=1')
  expect((await app.call('wiki_commit', { jobId: start.jobId, digest: status.digest })).status).toBe('committed')
  expect((await readCurrent(library.wikiPath))?.version).toBe(saved.result.version)
}, 25000)

it('复制结果的实际路径、版本和数值落盘后仍可回读状态', async () => {
  const f = await querySetup('1'), jobs = new LocalJobs(f.config, fake); cleanups.push(() => jobs.close())
  const result = { path: f.root, sourceLibraryId: f.library.id, libraryId: 'copy1', name: '副本凭据=1',
    identity: { model: 'embedding1' }, version: 'v000001', vectors: 1, points: 1, generation_calls: 0, generation_tokens: 0 }
  vi.spyOn(copies, 'copyLibraryWithEmbedding').mockResolvedValue(result as Awaited<ReturnType<typeof copies.copyLibraryWithEmbedding>>)
  const start = await jobs.copy({ libraryId: f.library.id, confirm: true, target: { embeddingMode: 'ollama', localEmbeddingModel: 'embedding1' } })
  let status: Awaited<ReturnType<typeof jobs.status>> | undefined
  await vi.waitFor(async () => { status = await jobs.status(start.jobId); expect(status.status).not.toBe('running') })
  expect(status!.status).toBe('completed'); expect(status!.result).toMatchObject({ path: f.root, libraryId: 'copy1', version: 'v000001', vectors: 1, generation_calls: 0 })
  expect((status!.result as { name: string }).name).toBe('副本凭据=[已脱敏]')
  const saved = JSON.parse(await readFile(path.join(f.config.home, 'jobs', start.jobId + '.json'), 'utf8'))
  expect(saved.result.path).toBe(f.root); expect(saved.result.identity).toEqual(result.identity)
})

it('资源URI与模板、查询路径和来源定位保留，库名描述与正文继续脱敏', async () => {
  const f = await querySetup('1'), app = await session(f.config)
  const resources = await app.client.listResources(), resource = resources.resources[0]!
  expect(resource.uri).toContain(f.library.id); expect(resource.name).toBe('名称凭据=[已脱敏]')
  expect((await app.client.listResourceTemplates()).resourceTemplates[0]!.uriTemplate).toBe('llmwiki://libraries/{libraryId}/card')
  const card = JSON.parse((await app.client.readResource({ uri: resource.uri })).contents[0]!.text as string)
  expect(card.libraryId).toBe(f.library.id); expect(card.publishedVersion).toBe('v000001'); expect(card.long).not.toContain('"1"')
  const search = await app.call('wiki_search', { query: '审查证据', include: 'excerpts' })
  expect(search.groups[0].libraryId).toBe(f.library.id)
  const hit = search.groups[0].results.find((item: { path: string }) => item.path === 'sources/S-0001.md')
  expect(hit).toBeTruthy(); expect(hit.version).toBe('v000001'); expect(hit.sourceVersions[0].sourceId).toBe('S-0001')
  for (const item of search.groups[0].results) for (const quote of [{ content: item.snippet, segments: item.snippetSegments }, ...item.excerpts]) {
    for (const segment of quote.segments ?? []) {
      expect(segment.start).toBeGreaterThanOrEqual(0); expect(segment.end).toBeLessThanOrEqual(quote.content.length)
      if (quote.content.includes('[已脱敏]')) expect(segment).toMatchObject({ start: 0, end: quote.content.length, unverified: true, sources: [] })
    }
  }
  const sourceBinding = { sourceId: 'S-0001', sourceVersion: 'sha256:1', path: 'sources/S-0001.md', title: '来源题名1' }
  const segment = { start: 0, end: 4, anchor: '^p1', locator: 'L1-L1', contextLocator: 'L1-L1', truncated: false, unverified: false, sources: [sourceBinding] }
  const answer = { question: '', answer: '', historyUsed: 0, createdAt: '', citations: [{ number: 1, path: 'sources/S-0001.md', title: '', excerpt: '未改正文', hash: 'sha256:1', segments: [segment] }] }
  const binding = (publicResult(answer, ['1'], 'wiki_answer') as typeof answer).citations[0]!.segments[0]!.sources[0]!
  expect(binding).toEqual({ ...sourceBinding, title: '来源题名[已脱敏]' })
  answer.citations[0]!.excerpt = '正文1尾'
  const changed = (publicResult(answer, ['1'], 'wiki_answer') as typeof answer).citations[0]!
  expect(changed.segments[0]).toMatchObject({ start: 0, end: changed.excerpt.length, unverified: true, truncated: true, sources: [] })
  const read = await app.call('wiki_read', { library: f.library.id, path: hit.path })
  expect(read.path).toBe(hit.path); expect(read.version).toBe('v000001'); expect(read.content).toContain('[已脱敏]')
  const source = await app.call('wiki_source_read', { library: f.library.id, sourceId: 'S-0001', locator: 'L1-L1' })
  expect(source).toMatchObject({ sourceId: 'S-0001', locator: 'L1-L1', version: 'v000001', status: 'ok' })
  const browse = await app.call('wiki_browse', { library: f.library.id, ref: 'root', limit: 1 })
  expect(browse.version).toBe('v000001'); expect(browse.children[0].read_ref).toBe(browse.children[0].path)
  expect((await app.call('wiki_browse', { library: f.library.id, ref: 'root', limit: 1, cursor: browse.next_cursor })).version).toBe('v000001')
})

it('key=running时启动、取消与状态仍可用，未知错误和嵌套转义仍遮蔽', async () => {
  const f = await querySetup('running'), app = await session(f.config)
  const start = await app.call('wiki_generate', { libraryId: f.library.id, action: 'scan' })
  expect(start.status).toBe('running'); expect((await finished(app.call, start.jobId)).status).toBe('completed')
  vi.spyOn(copies, 'copyLibraryWithEmbedding').mockImplementation(async (_store, _input, signal) =>
    new Promise((_resolve, reject) => { signal?.addEventListener('abort', () => reject(signal.reason), { once: true }) }))
  const copying = await app.call('wiki_copy_with_embedding', { libraryId: f.library.id, confirm: true,
    target: { embeddingMode: 'ollama', localEmbeddingModel: 'fixture' } })
  expect(copying.status).toBe('running')
  expect((await app.call('wiki_cancel', { jobId: copying.jobId })).status).toBe('cancelling')
  expect((await finished(app.call, copying.jobId)).status).toBe('cancelled')
  const host = createLocalHost(f.config.registry(), { runtime: fake })
  try {
    const quoted = 'quoted-"key\\tail', nested = JSON.stringify({ detail: JSON.stringify({ credential: quoted, status: 'running' }) })
    expect(JSON.stringify(host.sanitize({ status: 'running', arbitrary: nested }, undefined, [quoted]))).not.toContain('quoted-')
    expect(host.failure(new Error(JSON.stringify({ detail: 'running' }))).message).toContain('[已脱敏]')
    expect(host.sanitize({ arbitrary: { path: 'running' } })).toEqual({ arbitrary: { path: '[已脱敏]' } })
    const safe = publicResult({ topic_gaps: [{ topic_id: 'T-0001', point_ids: ['S-0001:p1'], message: '凭据=1' }] }, ['1'], 'gaps') as { topic_id: string; message: string }[]
    expect(safe[0]).toMatchObject({ topic_id: 'T-0001', point_ids: ['S-0001:p1'], message: '凭据=[已脱敏]' })
  } finally { host.dispose() }
})

it('CLI短key不改写登记身份、路径、修订，stdout和stderr自由文本仍遮蔽', async () => {
  const f = await querySetup('1'), output: string[] = []
  await runCli(['library', 'list'], f.config, text => output.push(text))
  const legacy = JSON.parse(output.pop()!)[0]
  expect(legacy).toMatchObject({ id: f.library.id, wikiPath: f.library.wikiPath, name: '名称凭据=[已隐藏]' })
  expect(legacy.models).toEqual(f.library.models)
  const publicRegistry = publicResult({ registry: f.config.registry(), registryRevision: registryRevision(f.config.registry()) }, ['1'], 'registry/get') as { registry: ReturnType<LocalConfigStore['registry']> }
  expect(publicRegistry.registry.compatibleProviders!['compatible:fixture']).toEqual({ baseUrl: 'https://offline.invalid/v1', model: 'fixture', api: 'openai-responses' })
  expect(publicRegistry.registry.libraries[0]!.models).toEqual(f.library.models)
  await runCli(['libraries', 'list'], f.config, text => output.push(text))
  const page = JSON.parse(output.pop()!)
  expect(page.registryRevision).toBe(registryRevision(f.config.registry())); expect(page.libraries[0].libraryId).toBe(f.library.id)
  const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true)
  const action = vi.spyOn(LibraryStore.prototype, 'snapshot').mockImplementationOnce(() => { throw new Error('错误凭据=1') })
  await runCli(['libraries', 'list'], f.config, text => output.push(text))
  expect(stderr.mock.calls.map(call => String(call[0])).join('')).toMatch(/错误凭据=\[已隐藏\]|错误凭据=\[已脱敏\]/)
  action.mockRestore(); process.exitCode = 0
})
