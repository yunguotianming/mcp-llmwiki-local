import path from 'node:path'
import { vi } from 'vitest'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { defaultPolicy } from '../src/domain/policy.js'
import { createBuildModelClient } from '../src/host/models.js'
import { atomicWrite, hash, writeJson } from '../src/layered/files.js'
import { putPage } from '../src/layered/objects.js'
import { storageJson } from '../src/layered/vectors.js'
import type { Extraction, SnapshotManifest } from '../src/layered/schema.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { legacyFixture } from './b3-fixture.js'

export const parent = 'topics/T-父.md', child = 'topics/T-父/T-子.md', leaf = 'topics/T-父/T-子/T-叶.md'
export async function evidenceFixture() {
  const f = await legacyFixture('0.2.1'), manifest = f.manifest, source = manifest.sources[0]!
  const raw = '资料记载：项目甲的采集时间为2026年11月，采集对象为护士。项目乙的采集时间为2026年10月。'
  await atomicWrite(f.root, source.files.source, raw)
  source.content_hash = hash(raw); source.source_version = hash(raw)
  const segment = { locator: 'L1-L1', start: 0, end: raw.length, text_hash: hash(raw) }
  source.segments = [segment]
  const points = ['项目甲于2026年11月采集护士资料。', '项目乙的数据采集月份为2026年10月。'].map((text, index) => ({
    point_id: `${source.source_id}:${segment.text_hash}:${index + 1}`, text, section: '主要发现', text_hash: segment.text_hash, locator: 'L1-L1',
    source_version: source.source_version, evidence: [{ source_id: source.source_id, source_version: source.source_version, locator: 'L1-L1',
      quote: index ? '项目乙的采集时间为2026年10月。' : '项目甲的采集时间为2026年11月，采集对象为护士。' }],
    verification: { status: 'verified' as const, missing: '', fingerprint: '旧核对' } }))
  const extraction: Extraction = { format_version: 1, source_id: source.source_id, source_hash: source.content_hash, processing: source.extract.processing,
    metadata: source.metadata, calls: [], segments: [{ ...segment, resource_hashes: [], processing_fingerprint: hash(raw), terms: [], points }] }
  const saveExtraction = () => writeJson(f.root, source.extract.path, extraction)
  await saveExtraction()
  const own = (number: number) => ({ point_id: points[number - 1]!.point_id, text_hash: points[number - 1]!.text_hash })
  for (const page of [parent, child, leaf, 'topics/T-旁支.md']) manifest.pages![page] = await putPage(f.root, `# ${path.basename(page, '.md')}\n\n${page === 'topics/T-旁支.md' ? points[1]!.text : points[0]!.text}\n`)
  manifest.deps!.pages[parent] = { sources: [source.source_id], points: [], children: [{ page: child, version: 'v000001' }] }
  manifest.deps!.pages[child] = { sources: [source.source_id], points: [], children: [{ page: leaf, version: 'v000001' }], review: { fingerprint: '旧核对', removed: [] } }
  manifest.deps!.pages[leaf] = { sources: [source.source_id], points: [own(1)], review: { fingerprint: '旧核对', removed: [] } }
  manifest.deps!.pages['topics/T-旁支.md'] = { sources: [source.source_id], points: [own(2)], review: { fingerprint: '旧核对', removed: [] } }
  const save = (value: SnapshotManifest = manifest) => writeJson(f.root, `versions/${value.version}.json`, { manifest: value, checksum: hash(storageJson(value)) })
  await save()
  const calls: { topic: string; source_versions: { source_id: string; source_version: string }[];
    members: { point_id: string; text: string; evidence: { quote: string; locator: string; source_version: string; context?: string }[] }[] }[] = []
  const library = newLibrary('父页证据夹具'), policy = defaultPolicy()
  library.wikiPath = f.root; library.sourceRoots = [f.parent]; library.models.unified = { provider: 'offline', model: 'review' }
  library.models.layeredRoutes = {}; library.models.fallbacks = []; library.layered = { embeddingMode: 'none' }
  library.models.providerProfiles.offline = { concurrency: 1, retryLimit: 0, backoffMs: 0, cacheMode: 'none' }
  policy.batchDelayMs = 0; policy.pageGenerationConcurrency = 1; policy.maxTokensPerCall = 512
  const runtime: ModelRuntime = { resolveModelInfo: vi.fn(async (provider, id) => ({ provider, id, name: id, context: { contextWindow: 131072 } })),
    stream: vi.fn(async function* (request) {
      const message = request.messages[0]!.content[0]!
      if (message.type !== 'text') throw new Error('只接受离线文本')
      const input = JSON.parse(message.text); calls.push({ topic: input.topic_id, source_versions: input.source_versions, members: input.members })
      yield { type: 'usage' as const, usage: { inputTokens: 11, outputTokens: 5 } }
      yield { type: 'text-delta' as const, index: 0, text: JSON.stringify({ items: input.sentences.map((item: { id: string }) => ({ id: item.id, support: '完整支撑', missing: null })) }) }
      yield { type: 'finish' as const, reason: { kind: 'stop' as const } }
    }) }
  const client = (maxCalls = 2) => createBuildModelClient(runtime, library, policy, { ...emptyRegistry(), upgrade: { maxCalls } })
  return { ...f, raw, source, extraction, saveExtraction, save, points, calls, library, client }
}
