import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary, preparePointLabels } from '../src/layered/index.js'
import { writeJson } from '../src/layered/files.js'
import type { PendingBuild } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, layeredTopicFixture, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('自动和本地向量建库默认均不补标，显式独立补标仍可处理旧库且不重新提取', async () => {
  for (const embeddingMode of ['auto', 'ollama'] as const) {
    const fixture = await layeredTopicFixture()
    fixture.options.topics = { ...fixture.options.topics || {}, embeddingMode }
    await writeFile(path.join(fixture.knowledgeRoot, 'a.md'), '# 甲\n\n甲组的研究发现。')
    await buildLayeredLibrary(fixture.options)
    expect(fixture.call.mock.calls.filter(args => JSON.parse(args[2]).label_stage)).toHaveLength(0)
    const manifest = await snapshotManifest(fixture.root)
    expect(manifest.point_labels ?? {}).toEqual({})
    const pending: PendingBuild = { format_version: 2, base_version: manifest.version, version: null, manifest: structuredClone(manifest),
      card: manifest.card!, added: [], model_calls: 0, started_at: '2026-11-10T00:00:00.000Z' }
    const extraction = await readFile(path.join(fixture.root, manifest.sources[0]!.extract.path), 'utf8')
    fixture.call.mockClear(); fixture.embed.mockClear()
    expect(await preparePointLabels(fixture.root, pending, fixture.options)).toEqual({ changed: true, modelCalls: 1 })
    expect(fixture.call).toHaveBeenCalledTimes(1)
    expect(JSON.parse(fixture.call.mock.calls[0]![2]).label_stage).toBe('point-labels')
    expect(fixture.embed).not.toHaveBeenCalled()
    expect(await readFile(path.join(fixture.root, manifest.sources[0]!.extract.path), 'utf8')).toBe(extraction)
  }
})

it('登记改成不使用向量不会改变已锁定模型，未变增量零模型零嵌入', async () => {
  const fixture = await layeredTopicFixture()
  await writeFile(path.join(fixture.knowledgeRoot, 'a.md'), '# 甲\n\n甲组的研究发现。')
  await buildLayeredLibrary(fixture.options)
  const before = await snapshotManifest(fixture.root)
  const extraction = await readFile(path.join(fixture.root, before.sources[0]!.extract.path), 'utf8')
  fixture.options.topics = { ...fixture.options.topics || {}, embeddingMode: 'none', pointLabelsOnBuild: false,
    embeddingChangeToken: '00000000-0000-4000-8000-000000000001' }
  fixture.call.mockClear(); fixture.embed.mockClear()
  const changed = await buildLayeredLibrary(fixture.options)
  expect(changed.modelCalls).toBe(0)
  expect(fixture.call).not.toHaveBeenCalled()
  expect(fixture.embed).not.toHaveBeenCalled()
  const after = await snapshotManifest(fixture.root)
  expect(after.sources[0]!.extract).toEqual(before.sources[0]!.extract)
  expect(after.point_labels).toEqual(before.point_labels)
  expect(after.vector_state!.identity).toEqual(before.vector_state!.identity)
  expect(await readFile(path.join(fixture.root, after.sources[0]!.extract.path), 'utf8')).toBe(extraction)
  fixture.call.mockClear(); fixture.embed.mockClear()
  const unchanged = await buildLayeredLibrary(fixture.options)
  expect(unchanged).toEqual({ version: changed.version, added: [], modelCalls: 0, unchanged: true })
  expect(fixture.call).not.toHaveBeenCalled()
  expect(fixture.embed).not.toHaveBeenCalled()
})

it('高级补标开关变化可续做已有提取上下文，不重新提取、不重写主题且不重新嵌入', async () => {
  const fixture = await layeredTopicFixture()
  await writeFile(path.join(fixture.knowledgeRoot, 'a.md'), '# 甲\n\n甲组的研究发现。')
  await buildLayeredLibrary(fixture.options)
  const before = await snapshotManifest(fixture.root)
  const context = { registrationKey: JSON.stringify({ id: fixture.library.id, layered: fixture.options.topics }), policyRevision: 'fixed' }
  const pending: PendingBuild = { format_version: 2, base_version: before.version, version: null, manifest: structuredClone(before),
    card: before.card!, added: [], model_calls: 0, started_at: '2026-11-10T00:00:00.000Z', preview_context: context }
  await writeJson(fixture.root, 'work/pending.json', pending)
  fixture.options.topics = { ...fixture.options.topics || {}, pointLabelsOnBuild: true }
  fixture.options.previewContext = { ...context, registrationKey: JSON.stringify({ id: fixture.library.id, layered: fixture.options.topics }) }
  fixture.call.mockClear(); fixture.embed.mockClear()
  const result = await buildLayeredLibrary(fixture.options)
  expect(result.modelCalls).toBe(1)
  expect(fixture.call).toHaveBeenCalledTimes(1)
  expect(JSON.parse(fixture.call.mock.calls[0]![2]).label_stage).toBe('point-labels')
  expect(fixture.embed).not.toHaveBeenCalled()
  const after = await snapshotManifest(fixture.root)
  expect(after.sources.map(source => source.extract)).toEqual(before.sources.map(source => source.extract))
  for (const [page, object] of Object.entries(before.pages!).filter(([page]) => page.startsWith('topics/'))) {
    expect(after.pages![page]).toBe(object)
  }
  expect(after.deps).toEqual(before.deps)
})

it('显式补标预览重复请求复用已生成版本，零模型调用且零嵌入', async () => {
  const fixture = await layeredTopicFixture()
  fixture.options.topics = { ...fixture.options.topics || {}, pointLabelsOnBuild: true }
  await writeFile(path.join(fixture.knowledgeRoot, 'a.md'), '# 甲\n\n甲组的研究发现。')
  const first = await buildLayeredLibrary({ ...fixture.options, publish: false })
  expect(fixture.call.mock.calls.filter(args => JSON.parse(args[2]).label_stage)).toHaveLength(1)
  fixture.call.mockClear(); fixture.embed.mockClear()
  expect(await buildLayeredLibrary({ ...fixture.options, publish: false })).toEqual({
    version: first.version, added: first.added, modelCalls: 0, unchanged: false,
  })
  expect(fixture.call).not.toHaveBeenCalled()
  expect(fixture.embed).not.toHaveBeenCalled()
})
