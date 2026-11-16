import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalConfigStore } from '../src/local/config.js'
import { createMcpServer } from '../src/mcp/server.js'
import { createLocalRuntime } from '../src/local/runtime.js'
import { withBuildLock } from '../src/layered/files.js'
import { readCurrent } from '../src/layered/objects.js'
import { temporaryWorkspace } from './temp.js'
import { modelOutput, mockSupportReview, cleanupLayeredFixtures, type ExtractionInput } from './layered-fixture.js'
import { fixture as queryFixture } from './query-pages-audit-fixture.js'
import type { ModelRuntime } from '../src/llm/client.js'

const sessions: (() => Promise<void>)[] = []
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(async () => { for (const close of sessions.splice(0).reverse()) await close(); cleanupLayeredFixtures(); vi.unstubAllEnvs() })
async function session(config: LocalConfigStore, runtime?: ModelRuntime) {
  const app = createMcpServer(config, runtime), client = new Client({ name: '测试客户端', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair()
  await app.server.connect(a); await client.connect(b)
  sessions.push(async () => { await app.jobs.close(); await client.close(); await app.server.close() })
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args })
    const content = (result.content as { type: string; text: string }[])[0]!.text
    if (result.isError) throw new Error(content)
    return JSON.parse(content)
  }
  return { ...app, client, call }
}
async function setupBuild(runtime?: ModelRuntime) {
  const f = await temporaryWorkspace(); sessions.push(f.cleanup)
  const source = path.join(f.root, '资料'); await mkdir(source); await writeFile(path.join(source, '研究.md'), '研究记录指出，温度升高会影响样本观察结果。')
  const config = new LocalConfigStore(path.join(f.root, 'home')); await config.load(); const library = await config.add(source)
  const old = config.registry(), next = structuredClone(old)
  next.libraries[0]!.layered = { embeddingMode: 'none', extractionReview: 'off', topicReview: false }
  await config.writeRegistry(next, old)
  const fake: ModelRuntime = runtime ?? { async resolveModelInfo(provider, id) { return { provider, id, name: id, context: { contextWindow: 32768 }, reasoning: { efforts: [{ id: 'high', name: '高' }] } } }, async *stream(options) {
    const input = JSON.parse((options.messages[0]!.content[0] as { text: string }).text)
    yield { type: 'text-delta', index: 0, text: mockSupportReview(input) ?? modelOutput(input as ExtractionInput) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  return { ...f, config, source, library, ...await session(config, fake) }
}
async function finished(call: Awaited<ReturnType<typeof session>>['call'], jobId: string) {
  for (let i = 0; i < 500; i++) {
    const result = await call('wiki_status', { jobId, includePreview: true })
    if (result.status !== 'running') return result
    await new Promise(resolve => setTimeout(resolve, 20))
  }
  throw new Error('假模型作业未按期结束。')
}

it('SDK 保留作业工具并接入库管理、回答和回源，搜索浏览阅读均走核心', async () => {
  const f = await queryFixture(), config = new LocalConfigStore(path.join(f.root, 'mcp-home')); await config.load()
  sessions.push(async () => f.cleanup()); f.library.layered = { embeddingMode: 'none' }
  await config.writeRegistry(f.store.snapshot(), config.registry())
  const app = await session(config)
  const names = (await app.client.listTools()).tools.map(tool => tool.name)
  expect(names).toHaveLength(19)
  expect(names).toEqual(expect.arrayContaining(['wiki_generate', 'wiki_status', 'wiki_commit', 'wiki_cancel', 'wiki_answer', 'wiki_source_read', 'wiki_find_library', 'wiki_update_library']))
  const search = await app.call('wiki_search', { query: '审查证据', variants: ['审查'], include: 'hits' })
  expect(search.total).toBeGreaterThan(0)
  const browse = await app.call('wiki_browse', { library: f.library.id, ref: 'root' })
  expect(browse.children.length).toBeGreaterThan(0)
  expect((await app.call('wiki_read', { library: f.library.id, path: 'T-0001' })).content).toContain('审查证据')
  const page = await app.call('wiki_read', { library: f.library.id, path: 'sources/S-0001.md#^proof' })
  expect(page.content).toContain('逐字证据')
  await expect(app.call('wiki_read', { library: f.library.id, path: '../../外部文件' })).rejects.toThrow()
})

it('SDK 假模型生成立即返回，状态含预览成本，签名提交后新布局可查询', async () => {
  const f = await setupBuild()
  expect((await f.call('wiki_list_libraries')).libraries[0].libraryId).toBe(f.library.id)
  const start = await f.call('wiki_generate', { libraryId: f.library.id })
  expect(start.status).toBe('running')
  const status = await finished(f.call, start.jobId)
  expect(status.status, status.error).toBe('preview'); expect(status.digest).toBeTruthy(); expect(status.preview.length).toBeGreaterThan(0)
  expect(status.costs).not.toBeNull(); expect(status.gaps).toEqual([])
  expect(await readCurrent(f.library.wikiPath)).toBeUndefined()
  await expect(f.call('wiki_commit', { jobId: start.jobId, digest: '过期签名' })).rejects.toThrow()
  expect((await f.call('wiki_commit', { jobId: start.jobId, digest: status.digest })).status).toBe('committed')
  expect(JSON.parse(await readFile(path.join(f.library.wikiPath, 'data/layout.json'), 'utf8')).version).toBe(2)
  expect((await f.call('wiki_search', { query: '温度', variants: ['样本'], include: 'hits' })).total).toBeGreaterThan(0)
}, 20000)

it('源库同一写锁占用时立即返回明确错误，不启动作业', async () => {
  const f = await setupBuild()
  await withBuildLock(f.source, async () => {
    await expect(f.call('wiki_generate', { libraryId: f.library.id })).rejects.toThrow('正在被占用')
  })
})

it('缺 DeepSeek 密钥仍搜索原话，并返回理解降级标注', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', '')
  const f = await queryFixture(), config = new LocalConfigStore(path.join(f.root, 'mcp-home')); await config.load()
  sessions.push(async () => f.cleanup()); f.library.layered = { embeddingMode: 'none' }
  const registry = f.store.snapshot(); registry.libraries[0]!.queryUnderstanding = { enabled: true }
  await config.writeRegistry(registry, config.registry())
  const app = await session(config, createLocalRuntime(config.snapshot().runtime))
  const result = await app.call('wiki_search', { query: '审查证据', include: 'hits' })
  expect(result.total).toBeGreaterThan(0)
  expect(result.understanding.status).toBe('model-unconfigured')
  expect(result.degradations).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'understanding' })]))
})

it('SDK 取消预览保留当前版本，参数非法时拒绝', async () => {
  const f = await setupBuild(), start = await f.call('wiki_generate', { libraryId: f.library.id })
  const status = await finished(f.call, start.jobId); expect(status.status, status.error).toBe('preview')
  expect((await f.call('wiki_cancel', { jobId: start.jobId })).status).toBe('cancelled')
  expect(await readCurrent(f.library.wikiPath)).toBeUndefined()
  await expect(f.call('wiki_search', { query: '问题', limit: 100 })).rejects.toThrow()
}, 20000)
