import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { preparePointLabels, pointLabelFingerprint } from '../src/layered/point-labels.js'
import { readExtraction } from '../src/layered/publication.js'
import { writeJson } from '../src/layered/files.js'
import { defaultLayeredSettings, emptyRegistry, layeredSettings } from '../src/domain/config.js'
import { exportConfig, importConfig } from '../src/domain/config-io.js'
import { cleanupLayeredFixtures, layeredTopicFixture, snapshotManifest } from './layered-fixture.js'
import type { PendingBuild } from '../src/layered/schema.js'
import { sameExtractionContext } from '../src/layered/vector-build.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
async function fixture() {
  const f = await layeredTopicFixture()
  // 补标专项显式开启；向量建库默认不再调用补标。
  f.options.topics = { ...f.options.topics || {}, pointLabelsOnBuild: true }
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 甲\n\n甲组的研究发现。')
  await buildLayeredLibrary({ ...f.options, publish: false })
  const pending = JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8')) as PendingBuild
  return { ...f, pending }
}
it('独立补标只读提取要点，按篇一次并从短编号缓存完整 ID 映射', async () => {
  const f = await fixture(), requests = f.call.mock.calls.map(call => JSON.parse(call[2])).filter(input => input.label_stage)
  expect(requests).toHaveLength(1)
  expect(requests[0].paragraphs).toBeUndefined()
  const ids = Object.keys(f.pending.manifest.point_labels!).sort()
  expect(requests[0].points.map((point: { point_id: string }) => point.point_id)).toEqual(ids.map((_id, index) => 'P' + (index + 1)))
  const prior = structuredClone(f.pending.manifest.point_labels)
  f.call.mockClear()
  expect(await preparePointLabels(f.root, f.pending, f.options)).toEqual({ changed: false, modelCalls: 0 })
  expect(f.call).not.toHaveBeenCalled()
  expect(f.pending.manifest.point_labels).toEqual(prior)
})
it('只改变产出模型不补标，新增或变化要点只补增量', async () => {
  const f = await fixture(), source = f.pending.manifest.sources[0]!, extraction = await readExtraction(f.root, source.extract.path)
  const prior = structuredClone(f.pending.manifest.point_labels), first = extraction.segments.flatMap(segment => segment.points)[0]!
  vi.spyOn(f.client, 'info').mockResolvedValue({ provider: 'other', id: 'new-extractor', name: '新模型' })
  f.call.mockClear()
  await preparePointLabels(f.root, f.pending, f.options)
  expect(f.call).not.toHaveBeenCalled()
  const changed = structuredClone(first); changed.point_id += '-new'; changed.text = '实际新增的要点。'
  extraction.segments[0]!.points.push(changed)
  source.extract.path = 'work/labels-extract.json'; await writeJson(f.root, source.extract.path, extraction)
  await preparePointLabels(f.root, f.pending, f.options)
  const inputs = f.call.mock.calls.map(call => JSON.parse(call[2])).filter(input => input.label_stage)
  expect(inputs).toHaveLength(1); expect(inputs[0].points.map((point: { point_id: string }) => point.point_id)).toEqual(['P1'])
  expect(f.pending.manifest.point_labels![changed.point_id]).toBeDefined()
  for (const [id, value] of Object.entries(prior!)) expect(f.pending.manifest.point_labels![id]).toEqual(value)
})
it('补标 ID 重复或遗漏只记缺口，不改变向量主题', async () => {
  const f = await fixture(), topics = structuredClone(f.pending.topics)
  delete f.pending.manifest.point_labels
  f.call.mockResolvedValue(JSON.stringify({ items: [] }))
  await preparePointLabels(f.root, f.pending, f.options)
  expect(f.pending.manifest.point_label_gaps).toHaveLength(1)
  expect(f.pending.manifest.point_labels).toEqual({})
  expect(f.pending.topics).toEqual(topics)
})
it('补标指纹跟随内容和词表，颗粒度或模型溯源不进入指纹', async () => {
  const f = await fixture(), extraction = await readExtraction(f.root, f.pending.manifest.sources[0]!.extract.path), point = extraction.segments.flatMap(segment => segment.points)[0]!
  expect(pointLabelFingerprint(point, [])).toBe(pointLabelFingerprint({ ...point, point_id: '不同段序的同内容' }, []))
  expect(pointLabelFingerprint(point, [])).not.toBe(pointLabelFingerprint({ ...point, text: point.text + '新增条件' }, []))
  expect(pointLabelFingerprint(point, [])).not.toBe(pointLabelFingerprint(point, ['新词表']))
})
it('三种向量方式和离线选项导入导出，默认轻量模型不覆盖显式旧模型', async () => {
  const f = await fixture(), registry = emptyRegistry()
  f.library.wikiPath = f.root
  registry.libraries = [f.library]
  for (const embeddingMode of ['auto', 'ollama', 'none'] as const) {
    f.library.layered = { embeddingMode, embeddingUnavailable: 'continue', localEmbeddingModel: 'qwen3-embedding:8b', embeddingChangeToken: randomUUID() }
    expect(importConfig(exportConfig(registry), emptyRegistry(), 'replace').libraries[0]!.layered).toEqual(f.library.layered)
  }
  expect(defaultLayeredSettings.localEmbeddingModel).toBe('qwen3-embedding:0.6b')
  expect(layeredSettings(f.library.layered).localEmbeddingModel).toBe('qwen3-embedding:8b')
  const context = { registrationKey: JSON.stringify({ id: 'library', layered: { embeddingMode: 'auto' } }), policyRevision: 'fixed' }
  expect(sameExtractionContext(context, { ...context, registrationKey: JSON.stringify({ id: 'library', layered: { embeddingMode: 'none', embeddingUnavailable: 'continue' } }) })).toBe(true)
  expect(sameExtractionContext(context, { ...context, registrationKey: JSON.stringify({ id: 'other-library' }) })).toBe(false)
  expect(sameExtractionContext(context, { ...context, policyRevision: 'changed' })).toBe(false)
})
