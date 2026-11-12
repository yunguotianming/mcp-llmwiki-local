import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { vi } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { copyWithEmbedding } from '../src/layered/query-vectors.js'
import { versionPage } from '../src/layered/objects.js'
import { hydrateVectors } from '../src/layered/vectors.js'
import * as retention from '../src/layered/retention.js'
import { layeredTopicFixture, snapshotManifest } from './layered-fixture.js'
import type { PendingBuild } from '../src/layered/schema.js'

// 复用真实文件与原子发布夹具；本次不测成本逐调用落盘和设备注册。
vi.mock('../src/layered/costs.js', async original => ({ ...await original<typeof import('../src/layered/costs.js')>(),
  meteredOptions: (_root: string, _pending: unknown, options: unknown) => options }))
vi.mock('../src/layered/devices.js', async original => ({ ...await original<typeof import('../src/layered/devices.js')>(),
  checkWriter: async () => {}, claimWriter: async () => {} }))

export async function auditFixture(count = 1) {
  const f = await layeredTopicFixture()
  // GC租约另有专项；避免多轮模型切换反复扫描，与现有30/3/1夹具口径一致。
  vi.spyOn(retention, 'collectGarbage').mockResolvedValue(undefined)
  f.library.models.unified = { provider: 'mock', model: 'terra' }
  const originals = new Map<string, string>()
  for (let i = 0; i < count; i++) {
    const name = `${String.fromCharCode(97 + i)}.md`, text = `# 资料${i}\n\n甲组第${i}篇的研究结果。`
    originals.set(name, text); await writeFile(path.join(f.knowledgeRoot, name), text)
  }
  return { ...f, originals }
}
export async function pendingOf(root: string): Promise<PendingBuild> {
  return hydrateVectors(root, JSON.parse(await readFile(path.join(root, 'work/pending.json'), 'utf8')))
}
export async function preview(f: Awaited<ReturnType<typeof auditFixture>>) {
  await buildLayeredLibrary({ ...f.options, publish: false })
  return pendingOf(f.root)
}
export function largeVectors(f: Awaited<ReturnType<typeof auditFixture>>) {
  f.options.topics = { ...f.options.topics || {}, localEmbeddingModel: 'qwen3-embedding:8b', embeddingChangeToken: '00000000-0000-4000-8000-000000000001' }
  const embed = vi.fn(async (inputs: string[]) => inputs.map(() => [1, 0, 0, 0]))
  f.options.embeddingClient = { identity: async () => 'large-weights', embed }
  return embed
}
export async function copyLargeVectors(f: Awaited<ReturnType<typeof auditFixture>>) {
  const embed = largeVectors(f)
  const copied = await copyWithEmbedding(f.root, { embeddingMode: 'ollama', localEmbeddingModel: 'qwen3-embedding:8b' }, true,
    { embeddingClient: f.options.embeddingClient, settings: f.options.topics || {} })
  f.root = copied.path; f.options.wikiPath = copied.path; f.options.name = copied.name
  return embed
}
export async function products(f: Awaited<ReturnType<typeof auditFixture>>) {
  const manifest = await snapshotManifest(f.root)
  return { pages: await Promise.all(Object.keys(manifest.pages!).sort().map(async page => [page, await versionPage(f.root, manifest, page)])),
    extractions: await Promise.all(manifest.sources.map(async source => [source.source_id, await readFile(path.join(f.root, source.extract.path), 'utf8')])),
    labels: manifest.point_labels, deps: manifest.deps, aliases: manifest.aliases, pageObjects: manifest.pages }
}
