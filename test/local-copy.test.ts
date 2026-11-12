import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { expect, it, vi } from 'vitest'
import path from 'node:path'
import { writeFile, readFile } from 'node:fs/promises'
import { createMcpServer } from '../src/mcp/server.js'
import { LocalConfigStore } from '../src/local/config.js'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { OllamaEmbeddingClient } from '../src/layered/embedding.js'
import { layeredTopicFixture, cleanupLayeredFixtures, snapshotManifest } from './layered-fixture.js'
import { emptyRegistry } from '../src/domain/config.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
it('MCP 复制换模异步登记副本、保留页面且不调用生成模型', async () => {
  const f = await layeredTopicFixture(), config = new LocalConfigStore(path.join(f.knowledgeRoot, 'home')); await config.load()
  const sourceRoot = path.join(f.knowledgeRoot, '.llmwiki-qwen3-8b')
  f.options.wikiPath = sourceRoot; f.options.topics = { ...f.options.topics || {}, localEmbeddingModel: 'qwen3-embedding:8b' }
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 甲组\n\n甲组的研究结果。')
  await buildLayeredLibrary(f.options)
  f.library.wikiPath = sourceRoot; f.library.sourceRoots = [f.knowledgeRoot]; f.library.layered = f.options.topics || {}
  const registry = emptyRegistry(); registry.libraries = [f.library]; registry.activeLibraryId = f.library.id
  await config.writeRegistry(registry, config.registry())
  const embedding = vi.spyOn(OllamaEmbeddingClient.prototype, 'embed').mockImplementation(async input => input.map(() => [1, 0, 0]))
  vi.spyOn(OllamaEmbeddingClient.prototype, 'identity').mockResolvedValue('weights-fixture-copy')
  const forbidden = { async resolveModelInfo(): Promise<never> { throw new Error('复制不得调用模型') }, stream: vi.fn(async function* () { throw new Error('复制不得调用模型') }) }
  const app = createMcpServer(config, forbidden), client = new Client({ name: '复制验收', version: '1' }), [a, b] = InMemoryTransport.createLinkedPair()
  await app.server.connect(a); await client.connect(b)
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args }), text = (result.content as { text: string }[])[0]!.text
    if (result.isError) throw new Error(text)
    return JSON.parse(text)
  }
  try {
    const start = await call('wiki_copy_with_embedding', { libraryId: f.library.id, confirm: true, target: { embeddingMode: 'ollama', localEmbeddingModel: 'qwen3-embedding:0.6b' } })
    expect(start.status).toBe('running')
    let status
    for (let i = 0; i < 500; i++) { status = await call('wiki_status', { jobId: start.jobId }); if (status.status !== 'running') break; await new Promise(resolve => setTimeout(resolve, 10)) }
    expect(status.status, status.error).toBe('completed'); expect(status.result.generation_calls).toBe(0)
    expect(config.registry().libraries).toHaveLength(2); expect(embedding).toHaveBeenCalled(); expect(forbidden.stream).not.toHaveBeenCalled()
    const before = await snapshotManifest(sourceRoot), after = await snapshotManifest(status.result.path)
    expect(after.pages).toEqual(before.pages)
    expect(await readFile(path.join(status.result.path, 'wiki/index.md'), 'utf8')).toBe(await readFile(path.join(sourceRoot, 'wiki/index.md'), 'utf8'))
    await expect(call('wiki_copy_with_embedding', { libraryId: f.library.id, confirm: false, target: { embeddingMode: 'ollama', localEmbeddingModel: 'qwen3-embedding:0.6b' } })).rejects.toThrow()
  } finally { await app.jobs.close(); await client.close(); await app.server.close(); cleanupLayeredFixtures() }
}, 20000)
