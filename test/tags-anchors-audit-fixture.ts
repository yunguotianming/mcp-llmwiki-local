import { mockSupportReview } from './layered-fixture.js'
import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { parse } from 'yaml'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { hash } from '../src/layered/files.js'
import { storageJson } from '../src/layered/vectors.js'
import { readExtraction } from '../src/layered/publication.js'
import { extractSource } from '../src/layered/extraction.js'
import { readLocalSource } from '../src/layered/snapshot.js'
import { layeredFixture, modelOutput, snapshotManifest, snapshotFixture } from './layered-fixture.js'
import type { FixtureSnapshot } from './layered-fixture.js'
import type { SnapshotManifest, SourceEntry, Processing } from '../src/layered/schema.js'

// 复用既有真实文件夹具；模型全部为本地假实现，不访问真实资料或服务。
export const header = (value: string): any => parse(/^---\r?\n([\s\S]*?)\r?\n---/.exec(value)![1]!)
export async function saveManifest(root: string, manifest: SnapshotManifest) {
  await writeFile(path.join(root, 'versions', manifest.version + '.json'), storageJson({ checksum: hash(storageJson(manifest)), manifest }))
}
export async function fixture(topics: boolean | 'topics' = false, text = '可核验的研究证据。', transform?: (output: any, request: any) => void, template?: FixtureSnapshot, reuseRoot?: string) {
  const f = await layeredFixture(template, reuseRoot)
  if (topics) {
    f.options.topics = { topicMergeMinSources: 1, termThreshold50: topics === 'topics' ? 2 : 1 }
    f.options.embeddingClient = { embed: async texts => texts.map(() => [1, 0]), identity: async () => 'tags-anchors-audit' }
  }
  f.call.mockImplementation(async (_task, _system, input) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(input))
    if (support) return support
    const request = JSON.parse(input)
    const output = request.topic_id ? { title: '研究主题', aliases: ['主题别名'], summary: '研究范围', consensus: [], differences: [], conditions: [request.children ? { text: '子主题综合', child_ids: [request.children[0].id] } : { text: '可核验的结论', point_ids: [request.points[0].point_id] }] }
      : request.term_id ? { definition: [{ text: '术语定义', keys: [request.contributions[0].key] }], usage: [], findings: [], differences: [] }
      : JSON.parse(modelOutput(request))
    if (output.points) output.points = output.points.slice(0, 1)
    if (output.terms && topics !== true) output.terms = []
    if (request.summary_point_limit && output.points) output.summary_point_indices = output.points.map((_: unknown, index: number) => index)
    transform?.(output, request)
    return JSON.stringify(output)
  })
  if (!template) await writeFile(path.join(f.knowledgeRoot, '审查资料.md'), text)
  return f
}
const templates = new Map<string, { snapshot: FixtureSnapshot; root: string }>()
export async function built(topics: boolean | 'topics' = false, text?: string, transform?: (output: any, request: any) => void) {
  const key = JSON.stringify([topics, text, transform?.toString()]), template = templates.get(key)
  const f = await fixture(topics, text, transform, template?.snapshot, template?.root)
  if (!template) {
    await buildLayeredLibrary(f.options)
    templates.set(key, { snapshot: await snapshotFixture(f.knowledgeRoot), root: f.knowledgeRoot })
  }
  const manifest = await snapshotManifest(f.root), entry = manifest.sources[0]!
  const extraction = await readExtraction(f.root, entry.extract.path)
  return { ...f, manifest, entry, extraction }
}
export async function replaceExtraction(f: Awaited<ReturnType<typeof built>>, mutate: (value: any) => void, oldFingerprint = false) {
  const value = structuredClone(f.extraction)
  mutate(value)
  const original = f.entry.extract.path
  // 使用独立的旧成果路径；不以覆盖不可变对象导致的异常冒充缓存缺陷。
  f.entry.extract.path = f.entry.extract.path.replace(/\.json$/, '-tags-anchors-audit.json')
  if (oldFingerprint) {
    for (const segment of value.segments) segment.processing_fingerprint = hash(JSON.stringify(value.processing))
    f.entry.extract.processing_fingerprint = hash(JSON.stringify([value.segments.map((segment: any) => segment.processing_fingerprint), value.grouping_fingerprint]))
  }
  const bytes = JSON.stringify(value)
  await writeFile(path.join(f.root, f.entry.extract.path), bytes)
  await unlink(path.join(f.root, original))
  await saveManifest(f.root, f.manifest)
  f.call.mockClear()
  return { value, bytes, read: () => readFile(path.join(f.root, f.entry.extract.path), 'utf8') }
}

// 渲染边界用例只运行真实提取及渲染，不重复建立不参与断言的主题与发布状态。
export async function extracted(text: string, transform?: (output: any, request: any) => void) {
  const f = await fixture(false, text, transform)
  await mkdir(f.root, { recursive: true })
  const source = await readLocalSource(path.join(f.knowledgeRoot, '审查资料.md'), '笔记')
  const processing: Processing = { tier: 50, prompt_version: 'audit', model: 'mock/extractor' }
  const extraction = await extractSource(f.root, 'S-0001', source, processing, f.options, 20000)
  const entry: SourceEntry = { source_id: 'S-0001', origin_type: 'local', current_path: '审查资料.md', previous_paths: [],
    content_hash: source.contentHash, source_version: source.contentHash, resource_version: [], segments: source.segments,
    metadata: extraction.metadata, files: { source: '', assets: [] }, extract: { path: '', processing, processing_fingerprint: '' },
    revocation_generation: 0, updated_at: '2026-11-09T00:00:00.000Z' }
  return { ...f, extraction, entry }
}
