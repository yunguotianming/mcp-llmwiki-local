import { existsSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { setImmediate } from 'node:timers/promises'
import { prepareTerms } from '../src/layered/terms.js'
import { prepareTagMerges } from '../src/layered/tag-merges.js'
import { publishLibrary, readExtraction } from '../src/layered/publication.js'
import { meteredOptions } from '../src/layered/costs.js'
import { pendingFixture } from './pipeline-audit-fixture.js'
import { cleanupLayeredFixtures, snapshotManifest, versionFile } from './layered-fixture.js'
import type { TermRecord } from '../src/layered/schema.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
const hasFixtures = ['520.input.json', '520.output.json'].every(name => existsSync(new URL('./fixtures/real20j/' + name, import.meta.url)))
const input520 = hasFixtures ? JSON.parse(await readFile(new URL('./fixtures/real20j/520.input.json', import.meta.url), 'utf8')) : undefined
const output520 = hasFixtures ? JSON.parse(await readFile(new URL('./fixtures/real20j/520.output.json', import.meta.url), 'utf8')) : undefined
const output = (keys: string[]) => ({ definition: [{ text: '可核对定义。', keys }], usage: [], findings: [], differences: [] })

async function fixture() {
  const f = await pendingFixture()
  f.options.topics = { ...f.options.topics as object, termThreshold50: 2 }
  await prepareTerms(f.root, f.pending, f.committed, f.options)
  const contributions = await Promise.all(input520.contributions.map(async (item: { key: string; note: string }, index: number) => {
    const source = f.pending.manifest.sources[index % 2]!
    const segment = (await readExtraction(f.root, source.extract.path)).segments.find(segment => segment.points.length)!
    return { ...item, source_id: source.source_id, source_version: source.source_version, text_hash: segment.text_hash, locator: segment.locator,
      name: input520.name, category: '概念', aliases: [], point_ids: segment.points.map(point => point.point_id), vector: [] }
  }))
  const record: TermRecord = { id: 'TM-0038', name: input520.name, category: '概念', aliases: [], contributions, sections: [], split: false }
  f.pending.terms!.records = [record, { ...structuredClone(record), id: 'TM-0039', name: '其他术语' }]
  f.call.mockClear()
  return { ...f, record, run: () => prepareTerms(f.root, f.pending, f.committed, meteredOptions(f.root, f.pending, f.options)) }
}

it.skipIf(!hasFixtures)('20j 调用520：重复168的长键被拒，三条输入映射R1/R2/R3后正确回源并发布（夹具含第三方论文原文，未随公开仓库发布）', async () => {
  const f = await fixture(), allowed = input520.contributions.map((item: any) => item.key)
  expect(allowed).not.toContain(output520.usage[0].keys[0])
  expect(output520.usage[0].keys[0].replace('168168', '168')).toBe(allowed[2])
  f.call.mockImplementation(async (_task, _system, raw) => {
    const d = JSON.parse(raw)
    expect(d.contributions.map((item: any) => item.key)).toEqual(['R1', 'R2', 'R3'])
    expect(raw).not.toContain('sha256:')
    const result = structuredClone(output520)
    result.definition[0].keys = ['R1', 'R2', 'R3']; result.usage[0].keys = ['R3']
    return JSON.stringify(result)
  })
  await f.run()
  expect(f.pending.terms!.gaps ?? []).toEqual([])
  const section = f.record.sections[0]!
  expect(section.keys).toEqual(allowed)
  expect(section.content).toContain(output520.usage[0].text)
  for (const item of f.record.contributions) expect(section.content).toContain(`[${item.source_id}@${item.source_version}#${item.locator}]`)
  await publishLibrary(f.root, f.pending, undefined, false)
  f.call.mockClear()
  await publishLibrary(f.root, f.pending)
  expect(f.call).not.toHaveBeenCalled()
})

it.skipIf(!hasFixtures)('未知短编号只纠正坏条目一次，正常定义逐字保留且纠正成本被记录（夹具含第三方论文原文，未随公开仓库发布）', async () => {
  const f = await fixture(), corrections: any[] = []
  f.call.mockImplementation(async (_task, _system, raw) => {
    const d = JSON.parse(raw)
    if (d.items) {
      corrections.push(d)
      expect(d.items.map((item: any) => item.id)).toEqual(['usage:0'])
      return JSON.stringify({ items: d.items.map((item: any) => ({ id: item.id, text: item.text, keys: ['R3'] })) })
    }
    return JSON.stringify({ ...output(['R1']), usage: d.term_id === 'TM-0038' ? [{ text: '固定用法。', keys: ['R999'] }] : [] })
  })
  await f.run()
  expect(corrections).toHaveLength(1)
  expect(f.record.sections[0]!.content).toContain('可核对定义。')
  expect(f.record.sections[0]!.content).toContain('固定用法。')
  expect(f.pending.terms!.gaps ?? []).toEqual([])
  expect(f.pending.costs!.stages['术语']!.corrections).toBe(1)
})

it.skipIf(!hasFixtures)('未知短编号纠正仍错则隔离该条，其他术语、标签和发布继续（夹具含第三方论文原文，未随公开仓库发布）', async () => {
  const f = await fixture()
  f.call.mockImplementation(async (...args) => {
    const d = JSON.parse(args[2])
    if (d.new_tags) return '{"groups":[]}'
    if (d.items) return JSON.stringify({ items: d.items.map((item: any) => ({ id: item.id, text: item.text, keys: ['R999'] })) })
    return JSON.stringify({ ...output(['R1']), usage: d.term_id === 'TM-0038' ? [{ text: '不得发布的错误引用。', keys: ['R999'] }] : [] })
  })
  await f.run(); await prepareTagMerges(f.root, f.pending, f.options)
  expect(f.call.mock.calls.filter(args => JSON.parse(args[2]).items)).toHaveLength(1)
  expect(f.pending.terms!.pages['terms/TM-0038.md']!.content).not.toContain('不得发布的错误引用。')
  expect(f.pending.terms!.pages['terms/TM-0039.md']!.content).toContain('可核对定义。')
  expect(f.pending.manifest.term_gaps).toHaveLength(1)
  await publishLibrary(f.root, f.pending)
  const manifest = await snapshotManifest(f.root)
  expect(await versionFile(f.root, manifest.version!, 'index.md')).toContain('术语缺口')
  expect(manifest.tag_merges!.checked.length).toBeGreaterThan(0)
})

it.skipIf(!hasFixtures)('引用纠正改写主张拒收，整个坏分节留缺口且不取消另一在途术语（夹具含第三方论文原文，未随公开仓库发布）', async () => {
  const f = await fixture(), started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  let otherSignal: AbortSignal | undefined
  f.options.client.concurrency = () => 2
  f.call.mockImplementation(async (_task, _system, raw, signal) => {
    const d = JSON.parse(raw)
    if (d.term_id === 'TM-0039') { otherSignal = signal; started.resolve(); await release.promise; return JSON.stringify(output(['R1'])) }
    await started.promise
    if (d.items) return JSON.stringify({ items: d.items.map((item: any) => ({ id: item.id, text: '被偷偷改写。', keys: ['R1'] })) })
    return JSON.stringify(output(['R404']))
  })
  const run = f.run()
  await started.promise; await setImmediate()
  expect(otherSignal!.aborted).toBe(false)
  release.resolve(); await run
  expect(otherSignal!.aborted).toBe(false)
  expect(f.pending.terms!.pages['terms/TM-0038.md']!.content).toContain('生成缺口')
  expect(f.pending.terms!.pages['terms/TM-0038.md']!.content).not.toContain('被偷偷改写')
  await publishLibrary(f.root, f.pending)
})

it.skipIf(!hasFixtures)('单术语传输异常不取消同批任务，下一次发布复用已封存成果（夹具含第三方论文原文，未随公开仓库发布）', async () => {
  const f = await fixture()
  f.call.mockImplementation(async (_task, _system, raw, signal) => {
    const d = JSON.parse(raw)
    if (d.term_id === 'TM-0038') throw new Error('单术语服务失败')
    await setImmediate(); expect(signal!.aborted).toBe(false)
    return JSON.stringify(output(['R2']))
  })
  await f.run(); await publishLibrary(f.root, f.pending, undefined, false)
  expect(f.pending.manifest.term_gaps).toEqual([expect.objectContaining({ term_id: 'TM-0038', message: 'Error: 单术语服务失败' })])
  f.call.mockClear(); await publishLibrary(f.root, f.pending)
  expect(f.call).not.toHaveBeenCalled()
})
