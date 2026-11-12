import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { layeredSettings } from '../src/domain/config.js'
import { prepareVectorRun } from '../src/layered/vector-build.js'
import { readManifest } from '../src/layered/objects.js'
import { vectorStatus } from '../src/layered/vector-status.js'
import type { BuildLayeredOptions, PendingBuild } from '../src/layered/schema.js'

const settings = { cloudEmbeddingUrl: 'https://embedding.invalid/v1', cloudEmbeddingKeyEnv: 'LLMWIKI_TEST_CLOUD_KEY' }
const roots: string[] = []
beforeEach(() => { vi.stubEnv(settings.cloudEmbeddingKeyEnv, randomUUID()); vi.stubEnv('LLMWIKI_EMBEDDING_API_KEY', undefined) })
afterEach(async () => {
  vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks()
  for (const root of roots.splice(0)) {
    if (!path.resolve(root).startsWith(path.join(tmpdir(), 'cloud-vector-selection-'))) throw new Error('测试清理路径越界')
    await rm(root, { recursive: true, force: true })
  }
})
async function fixture(topics: BuildLayeredOptions['topics']) {
  const root = await mkdtemp(path.join(tmpdir(), 'cloud-vector-selection-')); roots.push(root)
  const committed = await readManifest(root), pending = { manifest: structuredClone(committed) } as PendingBuild
  const options = { topics } as BuildLayeredOptions
  return { root, committed, pending, options }
}
function mockService(local = false) {
  const request = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url) === 'http://127.0.0.1:11434/api/tags') return Response.json({ models: local ? [{ name: 'qwen3-embedding:0.6b', digest: 'weights', capabilities: ['embedding'] }] : [] })
    const input = JSON.parse(String(init!.body)).input as string[]
    if (String(url) === 'http://127.0.0.1:11434/api/embed') return Response.json({ embeddings: input.map(() => [1, 0]) })
    if (String(url) === settings.cloudEmbeddingUrl + '/embeddings') return Response.json({ data: input.map((_, index) => ({ index, embedding: [1, 0] })) })
    throw new Error('测试禁止未声明的请求')
  })
  vi.stubGlobal('fetch', request)
  return request
}

it('S01 自动无本地且未同时配置地址与密钥时绝不请求外部', async () => {
  for (const topics of [{}, { cloudEmbeddingKeyEnv: settings.cloudEmbeddingKeyEnv }, { cloudEmbeddingUrl: settings.cloudEmbeddingUrl }]) {
    const f = await fixture(topics), request = mockService()
    await expect(prepareVectorRun(f.root, f.pending, f.committed, f.options)).rejects.toThrow('不使用向量')
    expect(request.mock.calls.map(([url]) => url)).toEqual(['http://127.0.0.1:11434/api/tags'])
  }
})

it('S02 自动缺少选定本地模型时暂停，已配置云端也不会切换或外发', async () => {
  const f = await fixture(settings), request = mockService()
  await expect(prepareVectorRun(f.root, f.pending, f.committed, f.options)).rejects.toThrow('不使用向量')
  expect(request.mock.calls.map(([url]) => url)).toEqual(['http://127.0.0.1:11434/api/tags'])
  expect(f.pending.manifest.vector_state!.identity).toBeUndefined()
})

it('S03 自动同时有本地和云端配置仍优先本地且不请求外部', async () => {
  const f = await fixture(settings), request = mockService(true)
  await prepareVectorRun(f.root, f.pending, f.committed, f.options)
  expect(f.pending.manifest.vector_state).toMatchObject({ mode: 'ollama', identity: { provider: 'ollama', model: 'qwen3-embedding:0.6b' } })
  expect(request.mock.calls.every(([url]) => String(url).startsWith('http://127.0.0.1:11434/'))).toBe(true)
})

it('S04 锁定云端后本地上线或默认地址变化均不重新选，离线不偷偷回落', async () => {
  const f = await fixture({ ...settings, embeddingMode: 'cloud' }), request = mockService()
  await prepareVectorRun(f.root, f.pending, f.committed, f.options)
  const identity = structuredClone(f.pending.manifest.vector_state!.identity)
  request.mockClear()
  f.options.topics = { ...settings, cloudEmbeddingUrl: 'https://changed.invalid/v1', cloudEmbeddingModel: 'changed' }
  const run = await prepareVectorRun(f.root, f.pending, f.committed, f.options)
  expect(f.pending.manifest.vector_state!.identity).toEqual(identity)
  await run.embeddingClient!.embed(['后续要点'])
  expect(request.mock.calls.map(([url]) => url)).toEqual([settings.cloudEmbeddingUrl + '/embeddings'])
  vi.stubEnv(settings.cloudEmbeddingKeyEnv, undefined); request.mockClear()
  await expect(run.embeddingClient!.embed(['后续要点'])).rejects.toThrow('环境变量')
  expect(request).not.toHaveBeenCalled()
})

it('S05 云端设置状态只读本机配置且地址拒绝携带凭据', async () => {
  const f = await fixture(settings), request = mockService()
  const status = await vectorStatus(f.root, { ...settings, embeddingMode: 'cloud' })
  expect(status.available).toContain('已配置云端'); expect(request).not.toHaveBeenCalled()
  for (const cloudEmbeddingUrl of ['https://user:pass@embedding.invalid/v1', 'https://embedding.invalid/v1?key=value', 'https://embedding.invalid/v1#key', 'bad'])
    expect(() => layeredSettings({ cloudEmbeddingUrl })).toThrow()
  expect(() => layeredSettings({ cloudEmbeddingKeyEnv: 'Bearer key' })).toThrow('变量名')
})
