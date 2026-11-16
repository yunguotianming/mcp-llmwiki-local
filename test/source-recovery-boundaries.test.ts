import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary, readLayeredPage } from '../src/layered/index.js'
import { resultFingerprint } from '../src/layered/extraction.js'
import { hash } from '../src/layered/files.js'
import { storageJson } from '../src/layered/vectors.js'
import { createMcpHandler } from '../src/mcp/server.js'
import { createLocalHost } from '../src/local/host.js'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { defaultPolicy } from '../src/domain/policy.js'
import { cleanupLayeredFixtures, mockSupportReview, snapshotManifest } from './layered-fixture.js'
import { sourceRecoveryExtraction, sourceRecoveryFixture } from './source-recovery-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('新核实但无旧依赖/嵌入的点保留pending与向量缺口，不启动旧主题池', async () => {
  const f = await sourceRecoveryFixture(), before = await sourceRecoveryExtraction(f.root, f.manifest, 'S-0001')
  // 取夹具中“待补核对”的点；“保留已接受”的点仍被基线主题页引用，补缺发布继承基线页时会校验引用（07bfd2b）。
  const point = before.segments.flatMap(segment => segment.points).find(item => item.text.includes('待补核对'))!, pointId = point.point_id
  point.verification = { status: 'unverified', missing: '核对未完成：测试中断', fingerprint: point.verification!.fingerprint }
  before.correction_batches = { ...before.correction_batches, semantic: 0 }
  const entry = f.manifest.sources[0]!, state = f.manifest.vector_state!, textHash = hash(point.text)
  entry.extract.processing_fingerprint = resultFingerprint(before)
  delete f.manifest.deps!.reverse[pointId]
  for (const dependency of Object.values(f.manifest.deps!.pages)) dependency.points = dependency.points.filter(item => item.point_id !== pointId)
  for (const topic of f.manifest.topics!.topics) {
    topic.point_ids = topic.point_ids.filter(id => id !== pointId)
    if (topic.direct_point_ids) topic.direct_point_ids = topic.direct_point_ids.filter(id => id !== pointId)
  }
  delete f.manifest.topics!.vectors[pointId]
  state.coverage.embedded = state.coverage.embedded.filter(id => id !== pointId)
  state.coverage.missing = [...new Set([...state.coverage.missing, pointId])].sort()
  state.pending_points = state.pending_points.filter(id => id !== pointId)
  for (const page of Object.values(state.page_vectors ?? {})) page.vectors = page.vectors.filter(vector => vector.input_hash !== textHash)
  const cachePath = path.join(f.root, 'state/embeddings.json'), cache = JSON.parse(await readFile(cachePath, 'utf8'))
  cache.vectors = Object.fromEntries(Object.entries(cache.vectors).filter(([, value]) => (value as { input_hash: string }).input_hash !== textHash))
  await writeFile(cachePath, JSON.stringify(cache, null, 2) + '\n')
  await writeFile(path.join(f.root, entry.extract.path), JSON.stringify(before, null, 2) + '\n')
  await writeFile(path.join(f.root, 'versions', f.manifest.version! + '.json'), JSON.stringify({ checksum: hash(storageJson(f.manifest)), manifest: f.manifest }, null, 2) + '\n')
  const requests: any[] = []
  f.call.mockImplementation(async (...args) => { const request = JSON.parse(args[2]); requests.push(request); return mockSupportReview(request) ?? f.originalCall(...args) })
  await buildLayeredLibrary({ ...f.options, retrySources: { sourceIds: ['S-0001'], kinds: ['review'] } })
  const next = await snapshotManifest(f.root)
  expect(requests).toHaveLength(1)
  expect(requests[0].review_stage).toBe('extraction')
  expect(next.vector_state!.pending_points).toContain(pointId)
  expect(next.vector_state!.coverage.missing).toContain(pointId)
  expect(next.vector_state!.coverage.embedded).not.toContain(pointId)
  expect(next.sources[0]!.pending_topic_points).toContain(pointId)
  expect(next.topics).toEqual(f.manifest.topics)
  expect(next.topic_gaps).toEqual(f.manifest.topic_gaps)
  expect(f.embed).not.toHaveBeenCalled()
})

it('零成员组即使输入预算极小也不请求摘要，排除原因进入来源页', async () => {
  const f = await sourceRecoveryFixture(true)
  await buildLayeredLibrary({ ...f.options, maxInputBytes: 1, retrySources: f.retrySources })
  const next = await snapshotManifest(f.root), after = await sourceRecoveryExtraction(f.root, next, 'S-0001')
  expect(Object.values(after.group_cache!)[0]!.summary_excluded_reason).toContain('无可用摘要依据')
  expect(await readLayeredPage(f.knowledgeRoot, 'sources/S-0001.md', { version: next.version! })).toContain('摘要补缺排除：1 组无可用摘要依据')
  expect(f.call).not.toHaveBeenCalled()
})

it('暂停后不能把summary种类切成review', async () => {
  const f = await sourceRecoveryFixture()
  f.call.mockRejectedValue(Object.assign(new Error('测试预算暂停'), { budgetPause: true }))
  await expect(buildLayeredLibrary({ ...f.options, retrySources: f.retrySources })).rejects.toThrow('测试预算暂停')
  f.call.mockClear()
  await expect(buildLayeredLibrary({ ...f.options, retrySources: { sourceIds: ['S-0001'], kinds: ['review'] } })).rejects.toThrow('范围或种类已变化')
  expect(f.call).not.toHaveBeenCalled()
})

it('显式空种类零派发拒绝', async () => {
  const f = await sourceRecoveryFixture()
  await expect(buildLayeredLibrary({ ...f.options, retrySources: { sourceIds: ['S-0001'], kinds: [] } })).rejects.toThrow('非空')
  expect(f.call).not.toHaveBeenCalled()
})

it('独立MCP公开并转发现有generate的来源选择器', async () => {
  const f = await sourceRecoveryFixture()
  const registry = emptyRegistry()
  registry.libraries.push({ ...newLibrary('library1'), wikiPath: f.root, sourceRoots: [f.knowledgeRoot] })
  const host = createLocalHost(registry), handle = createMcpHandler(host)
  vi.spyOn(host.store, 'policy').mockResolvedValue({ initialized: true, writable: true, revision: 'r', message: '', policy: defaultPolicy() })
  const generate = vi.spyOn(host.operations, 'generate').mockResolvedValue({ status: 'unchanged', version: 'v000001', modelCalls: 0 })
  const retrySources = { sourceIds: ['S-0001'], kinds: ['summary'] }
  try {
    const listed = await handle({ id: 1, method: 'tools/list' }) as any
    expect(listed.result.tools.find((tool: any) => tool.name === 'wiki_generate').inputSchema.properties.retrySources).toBeTruthy()
    await handle({ id: 2, method: 'tools/call', params: { name: 'wiki_generate', arguments: { libraryId: 'library1', retrySources } } })
    expect(generate).toHaveBeenCalledWith('library1', 'generate', expect.any(AbortSignal), undefined, false, undefined, undefined, undefined, retrySources)
  } finally { handle.dispose(); host.dispose() }
})
