import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { emptyRegistry, layeredSettings } from '../src/domain/config.js'
import { createLocalHost } from '../src/local/host.js'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { createEmbeddingClient } from '../src/layered/cloud-embedding.js'
import { OllamaEmbeddingClient } from '../src/layered/embedding.js'
import { cleanupLayeredFixtures, layeredTopicFixture } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => { cleanupLayeredFixtures(); vi.unstubAllGlobals() })
it('没有向量服务配置时沿用本地 Ollama', () => {
  expect(createEmbeddingClient(layeredSettings())).toBeInstanceOf(OllamaEmbeddingClient)
  expect(layeredSettings().localEmbeddingUrl).toBe('http://127.0.0.1:11434')
})
it.each(['plain', 'env'] as const)('本机 %s embedding 凭据驱动独立副本，原库页面、向量、版本逐字节保持', async source => {
  const f = await layeredTopicFixture(), key = 'embedding-secret-b5'
  f.library.wikiPath = f.root; f.library.sourceRoots = [f.knowledgeRoot]
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组的研究结果。')
  await buildLayeredLibrary(f.options)
  const snapshot = async (root: string) => Object.fromEntries(await Promise.all((await readdir(root, { recursive: true, withFileTypes: true })).filter(entry => entry.isFile())
    .map(async entry => [path.relative(root, path.join(entry.parentPath, entry.name)), (await readFile(path.join(entry.parentPath, entry.name))).toString('base64')])) )
  const before = await snapshot(f.root), registry = emptyRegistry(); registry.libraries = [f.library]
  registry.embeddingService = { baseUrl: 'https://vectors.invalid/v1', model: 'new-embedding', ...(source === 'plain' ? { apiKey: key } : { apiKeyEnv: 'B5_EMBEDDING_KEY' }) }
  const request = vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe('https://vectors.invalid/v1/embeddings'); expect(init?.headers).toMatchObject({ authorization: 'Bearer ' + key })
    const body = JSON.parse(String(init?.body)); expect(body.model).toBe('new-embedding')
    return Response.json({ data: body.input.map((_: string, index: number) => ({ index, embedding: [1, 0, 0] })) })
  })
  vi.stubGlobal('fetch', request)
  const host = createLocalHost(registry, { request, env: { B5_EMBEDDING_KEY: key } }), copied = await host.copyEmbedding(f.library.id)
  expect(copied.path).not.toBe(f.root); expect(copied.identity.model).toBe('new-embedding'); expect(copied.identity.dimensions).toBe(3)
  expect(await snapshot(f.root)).toEqual(before)
  expect(host.store.snapshot().libraries).toHaveLength(2)
  for (const root of [f.root, copied.path]) for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) if (entry.isFile())
    expect((await readFile(path.join(entry.parentPath, entry.name))).toString('utf8')).not.toContain(key)
})
