import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalConfigStore } from '../src/local/config.js'
import { createLocalHost } from '../src/local/host.js'
import { createMcpServer, createMcpHandler } from '../src/mcp/server.js'
import { prepareMcpGeneration } from '../src/mcp/generation-selection.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { safePath } from '../src/storage/paths.js'
import { temporaryWorkspace } from './temp.js'
import { modelOutput, mockSupportReview, cleanupLayeredFixtures, type ExtractionInput } from './layered-fixture.js'
import type { ModelRuntime } from '../src/llm/client.js'

const close: (() => Promise<void>)[] = []
afterEach(async () => { for (const cleanup of close.splice(0).reverse()) await cleanup(); cleanupLayeredFixtures(); vi.restoreAllMocks() })
async function session() {
  const f = await temporaryWorkspace(); close.push(f.cleanup)
  const source = path.join(f.root, '资料'); await mkdir(source); await writeFile(path.join(source, '研究.md'), '温度升高会影响样本观察结果。')
  const config = new LocalConfigStore(path.join(f.root, 'home')); await config.load(); const library = await config.add(source)
  const previous = config.registry(), next = structuredClone(previous)
  next.libraries[0]!.layered = { embeddingMode: 'none', extractionReview: 'off', topicReview: false }
  await config.writeRegistry(next, previous)
  const resolve = vi.fn(async (provider: string, id: string) => ({ provider, id, name: id, context: { contextWindow: 32768 }, reasoning: { efforts: [{ id: 'high', name: '高' }] } }))
  const stream = vi.fn<ModelRuntime['stream']>(async function* (options) {
    const input = JSON.parse((options.messages[0]!.content[0] as { text: string }).text)
    yield { type: 'text-delta', index: 0, text: mockSupportReview(input) ?? modelOutput(input as ExtractionInput) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  const runtime: ModelRuntime = { resolveModelInfo: resolve, stream }
  const app = createMcpServer(config, runtime), host = createLocalHost(config.registry(), { runtime }), handle = createMcpHandler(host)
  const client = new Client({ name: '首次颗粒度测试', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair()
  await app.server.connect(a); await client.connect(b)
  close.push(async () => { handle.dispose(); host.dispose(); await app.jobs.close(); await client.close(); await app.server.close() })
  const sdk = async (args: Record<string, unknown> = {}) => {
    const response = await client.callTool({ name: 'wiki_generate', arguments: { libraryId: library.id, ...args } })
    const text = (response.content as { text: string }[])[0]!.text
    if (response.isError) throw new Error(text)
    return JSON.parse(text)
  }
  const fallback = async (args: Record<string, unknown> = {}) => {
    const response = await handle({ id: 1, method: 'tools/call', params: { name: 'wiki_generate', arguments: { libraryId: library.id, ...args } } }) as any
    if (response.result.isError) throw new Error(response.result.content[0].text)
    return JSON.parse(response.result.content[0].text)
  }
  return { ...app, config, library, source, host, handle, client, sdk, fallback, resolve, stream }
}

it('SDK与备用入口首次均返回全部档位并零写入零模型，公开询问说明', async () => {
  const f = await session(), first = await f.sdk()
  expect(first.status).toBe('selection_required'); expect(first.jobId).toBeUndefined()
  expect(first.choices.map((choice: any) => choice.extractionGranularity)).toEqual(['fine', 'detailed', 'standard', 'balanced', 'coarse', 'minimal', 'custom'])
  expect(first.choices.every((choice: any) => choice.description && choice.review)).toBe(true)
  expect(first.explanation).toContain('上限不是产出配额'); expect(first.explanation).toContain('扩额')
  expect(await f.fallback()).toEqual(first)
  expect(await readdir(f.source)).toEqual(['研究.md'])
  await expect(readFile(path.join(f.config.home, 'jobs'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(f.resolve).not.toHaveBeenCalled(); expect(f.stream).not.toHaveBeenCalled()
  const init = await f.handle({ id: 2, method: 'initialize' }) as any
  expect(init.result.instructions).toContain('不得自行选择标准档')
  const tools = await f.client.listTools()
  expect(tools.tools.find(tool => tool.name === 'wiki_generate')!.description).toContain('selection_required')
})

it('SDK明确custom后保存并假模型生成，预览任务沿用原策略且拒绝换档', async () => {
  const f = await session(), start = await f.sdk({ extractionGranularity: 'custom', customPointLimit: 17 })
  expect(start.status).toBe('running')
  await vi.waitFor(async () => { const status = await f.jobs.status(start.jobId); expect(status.status, status.error).toBe('preview') }, { timeout: 15000 })
  expect((await f.jobs.store.policy(f.library.id)).policy).toMatchObject({ extractionGranularity: 'custom', customPointLimit: 17 })
  const raw = await readFile(await safePath(f.library.wikiPath, '.llmwiki/policy.json'), 'utf8')
  const generate = vi.spyOn(f.host.operations, 'generate').mockResolvedValue({ status: 'unchanged', version: 'v000001', modelCalls: 0 } as any)
  expect((await f.fallback()).status).toBe('unchanged')
  expect((await f.fallback({ extractionGranularity: 'custom', customPointLimit: 17 })).status).toBe('unchanged')
  await expect(f.sdk({ extractionGranularity: 'fine' })).rejects.toThrow('仅用于首次建库')
  await expect(f.fallback({ extractionGranularity: 'custom', customPointLimit: 18 })).rejects.toThrow('保留原颗粒度')
  expect(generate).toHaveBeenCalledTimes(2)
  expect(await readFile(await safePath(f.library.wikiPath, '.llmwiki/policy.json'), 'utf8')).toBe(raw)
  const preview = await f.jobs.status(start.jobId)
  await f.jobs.commit(start.jobId, preview.digest!)
  const resumed = await f.sdk()
  expect(resumed.status).toBe('running')
  await vi.waitFor(async () => expect((await f.jobs.status(resumed.jobId)).status).toBe('completed'), { timeout: 15000 })
  expect((await f.jobs.store.policy(f.library.id)).policy).toMatchObject({ extractionGranularity: 'custom', customPointLimit: 17 })
}, 20000)

it('备用入口明确预设后先保存再派发，空状态区无选择仍询问', async () => {
  const f = await session()
  await f.host.store.initialize(f.library.id)
  expect((await f.fallback()).status).toBe('selection_required')
  const generate = vi.spyOn(f.host.operations, 'generate').mockImplementation(async () => {
    expect((await f.host.store.policy(f.library.id)).policy.extractionGranularity).toBe('balanced')
    return { status: 'unchanged', version: '', modelCalls: 0 } as any
  })
  expect((await f.fallback({ extractionGranularity: 'balanced' })).status).toBe('unchanged')
  expect(generate).toHaveBeenCalledTimes(1)
  expect(f.resolve).not.toHaveBeenCalled(); expect(f.stream).not.toHaveBeenCalled()
})

it.each([
  { extractionGranularity: 'custom' }, { extractionGranularity: 'custom', customPointLimit: 0 },
  { extractionGranularity: 'custom', customPointLimit: 501 }, { extractionGranularity: 'custom', customPointLimit: 1.5 },
  { extractionGranularity: 'standard', customPointLimit: 10 },
])('两个入口拒绝非法自定义参数%j且不初始化', async args => {
  const f = await session()
  await expect(f.sdk(args)).rejects.toThrow(); await expect(f.fallback(args)).rejects.toThrow()
  expect(await readdir(f.source)).toEqual(['研究.md'])
  expect(f.resolve).not.toHaveBeenCalled(); expect(f.stream).not.toHaveBeenCalled()
})

it('只读库明确选择也不初始化或派发', async () => {
  const f = await session(), registry = f.config.registry()
  registry.libraries[0]!.mode = 'readonly'
  await f.config.writeRegistry(registry, f.config.registry()); f.host.replace(registry)
  const store = new LibraryStore(() => registry)
  await expect(prepareMcpGeneration(store, { libraryId: f.library.id, extractionGranularity: 'fine' })).rejects.toThrow('只读')
  await expect(f.fallback()).rejects.toThrow('只读')
  await expect(f.sdk({ extractionGranularity: 'fine' })).rejects.toThrow('只读')
  expect(await readdir(f.source)).toEqual(['研究.md']); expect(f.resolve).not.toHaveBeenCalled()
})

it('初始化后策略保存失败不派发，重试无参数仍要求选择', async () => {
  const f = await session(), save = vi.spyOn(f.jobs.store, 'savePolicy').mockRejectedValue(new Error('模拟策略保存失败'))
  await expect(f.sdk({ extractionGranularity: 'fine' })).rejects.toThrow('模拟策略保存失败')
  expect((await f.jobs.store.policy(f.library.id)).initialized).toBe(true)
  save.mockRestore()
  expect((await f.sdk()).status).toBe('selection_required'); expect((await f.fallback()).status).toBe('selection_required')
  expect(f.resolve).not.toHaveBeenCalled(); expect(f.stream).not.toHaveBeenCalled()
  await expect(readFile(path.join(f.config.home, 'jobs'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('SDK派发前与启动后均拒绝第二次选择，不改正在使用的策略', async () => {
  const f = await session(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  vi.spyOn(f.jobs, 'generate').mockImplementation(async () => {
    entered.resolve(); await release.promise
    f.jobs.running.set(f.library.id, new AbortController())
    return { libraryId: f.library.id, status: 'running', jobId: '测试作业', message: '' }
  })
  const first = f.sdk({ extractionGranularity: 'balanced' })
  try {
    await entered.promise
    await expect(f.sdk({ extractionGranularity: 'fine' })).rejects.toThrow('正在被占用')
    expect((await f.jobs.store.policy(f.library.id)).policy.extractionGranularity).toBe('balanced')
    release.resolve(); await first
    await expect(f.sdk({ extractionGranularity: 'coarse' })).rejects.toThrow('正在被占用')
    expect((await f.jobs.store.policy(f.library.id)).policy.extractionGranularity).toBe('balanced')
  } finally { release.resolve(); await first; f.jobs.running.delete(f.library.id) }
})

it('备用入口生成期间拒绝第二次选择，不改正在使用的策略', async () => {
  const f = await session(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  vi.spyOn(f.host.operations, 'generate').mockImplementation(async () => {
    entered.resolve(); await release.promise
    return { status: 'unchanged', version: '', modelCalls: 0 } as any
  })
  const first = f.fallback({ extractionGranularity: 'coarse' })
  try {
    await entered.promise
    await expect(f.fallback({ extractionGranularity: 'fine' })).rejects.toThrow('正在被占用')
    expect((await f.host.store.policy(f.library.id)).policy.extractionGranularity).toBe('coarse')
  } finally { release.resolve(); await first }
})
