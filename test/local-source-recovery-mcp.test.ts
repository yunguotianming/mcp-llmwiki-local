import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalConfigStore } from '../src/local/config.js'
import { createMcpServer } from '../src/mcp/server.js'
import * as localLayered from '../src/local/local-layered.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { temporaryWorkspace } from './temp.js'

vi.mock('../src/local/local-layered.js', async original => ({ ...await original<typeof import('../src/local/local-layered.js')>() }))
afterEach(() => vi.restoreAllMocks())

async function session() {
  const f = await temporaryWorkspace(), source = path.join(f.root, '资料')
  await mkdir(source); await writeFile(path.join(source, 'a.md'), '独立入口的测试资料。')
  const config = new LocalConfigStore(path.join(f.root, 'home')); await config.load()
  const library = await config.add(source), resolve = vi.fn(async (): Promise<never> => { throw new Error('本用例不应派发模型') })
  const runtime: ModelRuntime = { resolveModelInfo: resolve, async *stream() { throw new Error('本用例不应派发模型') } }
  const app = createMcpServer(config, runtime), client = new Client({ name: '来源补缺测试', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair()
  await app.server.connect(a); await client.connect(b)
  const call = async (args: Record<string, unknown>) => {
    const result = await client.callTool({ name: 'wiki_generate', arguments: { libraryId: library.id, extractionGranularity: 'standard', ...args } })
    const text = (result.content as { text: string }[])[0]!.text
    if (result.isError) throw new Error(text)
    return JSON.parse(text)
  }
  const close = async () => { await app.jobs.close(); await client.close(); await app.server.close(); await f.cleanup() }
  return { ...app, config, library, client, call, close, resolve }
}

it.each(['summary', 'review'] as const)('SDK公开%s选择器并经异步作业转发原范围', async kind => {
  const f = await session(), retrySources = { sourceIds: ['S-0001'], kinds: [kind] }
  const generate = vi.spyOn(localLayered, 'generateLocalLayered').mockResolvedValue({ libraryId: f.library.id, status: 'unchanged', version: '', modelCalls: 0 } as any)
  try {
    const tool = (await f.client.listTools()).tools.find(tool => tool.name === 'wiki_generate')!
    expect(tool.inputSchema.properties!.retrySources).toMatchObject({ properties: { sourceIds: { minItems: 1 }, kinds: { minItems: 1 } } })
    const start = await f.call({ retrySources })
    expect(start.status).toBe('running')
    await vi.waitFor(async () => expect((await f.jobs.status(start.jobId)).status).toBe('completed'))
    expect(generate).toHaveBeenCalledWith(expect.anything(), f.library.id, expect.anything(), expect.any(AbortSignal), undefined, undefined, undefined, retrySources)
    expect(f.resolve).not.toHaveBeenCalled()
  } finally { await f.close() }
})

it('SDK拒绝空来源范围，不创建后台作业', async () => {
  const f = await session(), generate = vi.spyOn(localLayered, 'generateLocalLayered')
  try {
    await expect(f.call({ retrySources: { sourceIds: [], kinds: ['summary'] } })).rejects.toThrow()
    expect(generate).not.toHaveBeenCalled(); expect(f.resolve).not.toHaveBeenCalled()
    await expect(readFile(path.join(f.config.home, 'jobs'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await f.close() }
})

it('SDK选择器与重提互斥，在创建后台作业前拒绝', async () => {
  const f = await session(), generate = vi.spyOn(localLayered, 'generateLocalLayered')
  try {
    await expect(f.call({ reextract: 'gaps', retrySources: { sourceIds: ['S-0001'], kinds: ['summary'] } })).rejects.toThrow('不能与')
    expect(generate).not.toHaveBeenCalled(); expect(f.resolve).not.toHaveBeenCalled()
    await expect(readFile(path.join(f.config.home, 'jobs'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await f.close() }
})

it('SDK选择器与扫描互斥，在创建后台作业前拒绝', async () => {
  const f = await session(), scan = vi.spyOn(localLayered, 'scanLocalLayered')
  try {
    await expect(f.call({ action: 'scan', retrySources: { sourceIds: ['S-0001'], kinds: ['review'] } })).rejects.toThrow('只适用于')
    expect(scan).not.toHaveBeenCalled(); expect(f.resolve).not.toHaveBeenCalled()
    await expect(readFile(path.join(f.config.home, 'jobs'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await f.close() }
})
