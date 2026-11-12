// 修改夹具保留同一来源标题达到 50% 段重合；来源 ID、核对范围及贡献断言保持。
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { publishLibrary, readExtraction } from '../src/layered/publication.js'
import { renderSource } from '../src/layered/extraction.js'
import { cleanupLayeredFixtures, layeredIncrementalFixture, snapshotManifest } from './layered-fixture.js'
import { extractionFixture, output } from './quality-fix2-audit-fixture.js'
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
async function twoTopics() {
  const f = await layeredIncrementalFixture()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 资料a\n\n甲组随机样本显示提高。')
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '乙组独立实验显示降低。')
  await buildLayeredLibrary(f.options)
  expect((await snapshotManifest(f.root)).topics!.topics).toHaveLength(2)
  f.call.mockClear(); f.embed.mockClear()
  return f
}
it('A26 全部来源未变的增量模型和嵌入调用均为零', async () => {
  const f = await twoTopics(), result = await buildLayeredLibrary(f.options)
  expect(result.modelCalls).toBe(0); expect(f.call).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled()
})
it('A27 只改1篇，提取核对仅该来源且主题核对仅受影响主题', async () => {
  const f = await twoTopics(), before = await snapshotManifest(f.root)
  const untouched = before.topics!.topics.find(t => t.sources.includes('S-0002'))!
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 资料a\n\n甲组随机样本显示显著提高。')
  await buildLayeredLibrary(f.options)
  const inputs = f.call.mock.calls.map(c => JSON.parse(c[2]))
  expect(inputs.filter(c => c.review_stage === 'extraction').map(c => c.source_id)).toEqual(['S-0001'])
  expect(inputs.filter(c => c.paragraphs && !c.review_stage).map(c => c.source_id)).toEqual(['S-0001'])
  expect(inputs.filter(c => c.topic_id).every(c => c.topic_id !== untouched.id)).toBe(true)
  expect(inputs.filter(c => c.review_stage === 'topic')).toHaveLength(1)
})
it('A28 改档重提全部来源但不重核对未变点和不重写未变主题', async () => {
  const f = await twoTopics()
  await buildLayeredLibrary({ ...f.options, tier: 100, granularity: 'fine', topics: { ...f.options.topics || {}, contradictionReview: false } })
  const inputs = f.call.mock.calls.map(c => JSON.parse(c[2]))
  expect(inputs.filter(c => c.paragraphs && !c.review_stage).map(c => c.source_id).sort()).toEqual(['S-0001', 'S-0002'])
  expect(inputs.filter(c => c.review_stage === 'extraction')).toHaveLength(0)
  expect(inputs.filter(c => c.topic_id)).toHaveLength(0)
  const manifest = await snapshotManifest(f.root)
  expect(manifest.sources.every(s => s.extract.processing.tier === 100)).toBe(true)
})
it('A29 重新发布、纯渲染和配置前置拒绝仍为零调用', async () => {
  const f = await extractionFixture('真实结果。')
  await buildLayeredLibrary({ ...f.options, topics: false, publish: false })
  const pending = JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8'))
  f.call.mockClear()
  const entry = pending.manifest.sources[0], result = await readExtraction(f.root, entry.extract.path)
  expect(renderSource(entry, result)).toContain('真实结果。')
  await publishLibrary(f.root, pending)
  await expect(buildLayeredLibrary({ ...f.options, maxInputBytes: -1 })).rejects.toThrow()
  expect(f.call).not.toHaveBeenCalled()
})
it('A30 阶段次数token墙钟并发纠正原因写入状态与日志', async () => {
  const f = await extractionFixture('结果证据。')
  f.call.mockImplementation(async (_t, _s, raw, _signal, _images, options) => {
    options?.beforeAttempt?.(); options?.onAttempt?.({ route: { provider: 'mock', model: 'extractor' }, startedAt: new Date().toISOString(), durationMs: 2, finish: 'stop', usage: { inputTokens: 7, outputTokens: 3 } })
    const input = JSON.parse(raw)
    if (input.review_stage === 'extraction') return JSON.stringify({ items: input.points.map((p: any) => ({ id: p.id, support: '部分支撑', missing: '缺条件' })) })
    if (input.review_stage === 'extraction-correction') return JSON.stringify({ ...input.validationFeedback.item, support: '不支撑', missing: '缺条件' })
    return JSON.stringify(output(input))
  })
  await buildLayeredLibrary({ ...f.options, topics: false, publish: false })
  const pending = JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8'))
  const stage = pending.costs.stages['提取后核对']
  expect(stage).toMatchObject({ actual_calls: 2, input_tokens: 14, output_tokens: 6, corrections: 1, correction_reasons: { 'semantic-support': 1 } })
  expect(stage.wall_ms).toBeGreaterThan(0); expect(stage.peak_concurrency).toBeGreaterThan(0)
  const version = await publishLibrary(f.root, pending)
  const logs = JSON.parse(await readFile(path.join(f.root, 'logs/costs.json'), 'utf8'))
  expect(logs[version].stages['提取后核对']).toEqual(stage)
  expect(await readFile(path.join(f.root, 'logs/cost-report.md'), 'utf8')).toContain('semantic-support')
})
