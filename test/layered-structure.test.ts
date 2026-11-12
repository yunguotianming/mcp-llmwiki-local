import { batchModel } from './layered-fixture.js'
import { mockSupportReview } from './layered-fixture.js'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary, readLayeredSource } from '../src/layered/index.js'
import { extractSource } from '../src/layered/extraction.js'
import { readLocalSource } from '../src/layered/snapshot.js'
import type { Extraction, Processing } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, layeredFixture, snapshotManifest } from './layered-fixture.js'
import type { ExtractionInput } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
const processing: Processing = { tier: 50, granularity: 'custom', prompt_version: 'layered-extract-v2', model: 'mock/extractor' }
function output(input: ExtractionInput) {
  return { tags: ['研究方法', '研究对象', '核心主题'], credibility: 'low', credibility_reason: '测试笔记',
    points: input.paragraphs.map(part => ({ paragraph_id: part.paragraph_id, text: `主张 ${part.paragraph_id}`, section: '主要发现',
      evidence: [{ locator: part.locator, quote: part.text }] })),
    terms: [{ paragraph_id: input.paragraphs[0]!.paragraph_id, name: '测试术语', category: '概念', aliases: ['别称'], locator: input.paragraphs[0]!.locator, note: '原含义' }] }
}
async function fixture(count = 1) {
  const f = await layeredFixture(), file = path.join(f.knowledgeRoot, 'a.md')
  await writeFile(file, Array.from({ length: count }, (_, i) => `证据 ${i}。`).join('\n\n'))
  const source = await readLocalSource(file, 'Markdown')
  return { ...f, source, run: () => extractSource(f.root, 'S-0001', source, processing, f.options, 32000) }
}

it.each(['点外壳', '术语外壳', '字段大小写与空白', '枚举空白', '多余字段'])('%s 无歧义规范化后零纠正调用', async kind => {
  const f = await fixture()
  f.call.mockImplementation(batchModel(async (_task, _system, input) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(input))
    if (support) return support
    const value = output(JSON.parse(input)), point = value.points[0]!
    if (kind === '点外壳') value.points[0] = { source_id: 'S-0001', validationFeedback: { kind: 'point', item: point }, paragraphs: [] } as never
    if (kind === '术语外壳') value.terms[0] = { validationFeedback: { kind: 'term', item: value.terms[0] } } as never
    if (kind === '字段大小写与空白') { value.points[0] = { ...point, ' TEXT ': point.text } as never; delete (value.points[0] as Partial<typeof point>).text }
    if (kind === '枚举空白') point.section = ' 主要发现\n'
    if (kind === '多余字段') Object.assign(point, { source_id: 'S-0001' })
    return JSON.stringify(value)
  }))
  const result = await f.run()
  expect(result.gaps).toEqual([]); expect(f.call).toHaveBeenCalledTimes(1)
  expect(result.segments[0]!.points[0]).toMatchObject({ text: '主张 0', section: '主要发现', evidence: [{ locator: 'L1-L1', quote: '证据 0。' }] })
  expect(result.segments[0]!.terms[0]).toMatchObject({ name: '测试术语', note: '原含义' })
})

it('结构错误携带字段路径、期望、实际和原条目，点与术语各纠正一次', async () => {
  const f = await fixture(3), corrected: string[] = []
  f.call.mockImplementation(batchModel(async (_task, system, input, _signal, _images, options) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(input))
    if (support) return support
    const data = JSON.parse(input)
    if (data.validationFeedback) {
      const { kind, item, reasons } = data.validationFeedback
      corrected.push(kind + ':' + item.paragraph_id)
      expect(system).toContain('不要回显'); expect(system).toContain('每个输入 id 恰好返回一次')
      expect(options?.structuredSchema?.schema).toHaveProperty('properties.items.items.properties.paragraph_id')
      if (kind === 'term') {
        expect(reasons[0]).toMatchObject({ rule: 'item-schema:aliases', actual: '"别称"' })
        expect(reasons[0].expected).toContain('array')
        return JSON.stringify({ ...item, aliases: ['别称'] })
      }
      if (item.paragraph_id === 0) {
        expect(item.evidence).toEqual([]); expect(reasons[0].rule).toBe('item-schema:evidence')
        expect(reasons[0].expected).toContain('>=1'); expect(reasons[0].actual).toBe('[]')
      } else if (item.paragraph_id === 1) {
        expect(reasons[0]).toMatchObject({ rule: 'item-schema:evidence.0.quote', actual: 'undefined' })
        expect(reasons[0].expected).toContain('string')
      } else {
        expect(reasons[0]).toMatchObject({ rule: 'item-schema:section', actual: '"结论"' })
        expect(reasons[0].expected).toContain('主要发现')
      }
      const part = data.paragraphs.find((part: any) => part.paragraph_id === item.paragraph_id)
      return JSON.stringify({ ...item, section: '主要发现', evidence: [{ locator: part.locator, quote: part.text }] })
    }
    const value = output(data)
    value.points[0]!.evidence = []
    delete (value.points[1]!.evidence[0] as { quote?: string }).quote
    value.points[2]!.section = '结论'; value.terms[0]!.aliases = '别称' as never
    return JSON.stringify(value)
  }))
  const result = await f.run()
  expect(result.gaps).toEqual([]); expect(result.segments.flatMap(segment => segment.points)).toHaveLength(3)
  expect(corrected.sort()).toEqual(['point:0', 'point:1', 'point:2', 'term:0']); expect(f.call).toHaveBeenCalledTimes(2) // 一次首提加一批四项纠正。
})

it('纠正仍结构失败只丢弃该条并保留具体缺口和原始输出', async () => {
  const f = await fixture(2)
  f.call.mockImplementation(batchModel(async (_task, _system, input) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(input))
    if (support) return support
    const data = JSON.parse(input)
    if (data.validationFeedback) return JSON.stringify(data.validationFeedback.item)
    const value = output(data); value.points[0]!.evidence = []
    return JSON.stringify(value)
  }))
  const result = await f.run()
  expect(f.call).toHaveBeenCalledTimes(2)
  expect(result.segments.map(segment => segment.points.length)).toEqual([0, 1])
  expect(result.gaps).toMatchObject([{ kind: 'point', reasons: [{ rule: 'item-schema:evidence', actual: '[]' }] }])
  const directory = path.join(f.root, 'logs/failures/S-0001')
  const records = await Promise.all((await readdir(directory)).map(async file => JSON.parse(await readFile(path.join(directory, file), 'utf8'))))
  expect(records.some(record => JSON.parse(record.raw_output).items?.[0].evidence?.length === 0 && record.rejections[0].reasons[0].rule === 'item-schema:evidence')).toBe(true)
})

it('多证据混用编号与原文时结构反馈仍定位到具体字段', async () => {
  const f = await fixture(), file = path.join(f.knowledgeRoot, 'a.md')
  await writeFile(file, '相同证据。\n\n相同证据。')
  const source = await readLocalSource(file, 'Markdown')
  f.call.mockImplementation(batchModel(async (_task, _system, input) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(input))
    if (support) return support
    const data = JSON.parse(input)
    if (data.validationFeedback) {
      expect(data.validationFeedback.reasons).toMatchObject([{ rule: 'item-schema:evidence.1.quote', actual: 'undefined' }])
      return JSON.stringify({ ...data.validationFeedback.item, evidence: [{ locator: 'L1-L1', quote: '相同证据。' }] })
    }
    const value = output(data)
    value.points = [{ ...value.points[0]!, evidence: [{ evidence_ref: Object.keys(data.evidence_dictionary)[0] }, { locator: 'L1-L1' }] as never }]
    return JSON.stringify(value)
  }))
  const result = await extractSource(f.root, 'S-0001', source, processing, f.options, 32000)
  expect(f.call).toHaveBeenCalledTimes(2); expect(result.gaps).toEqual([])
  expect(result.segments[0]!.points[0]!.evidence).toMatchObject([{ locator: 'L1-L1', quote: '相同证据。' }])
})

it('纠正 JSON 损坏不追加调用，单条原始输出仍留痕', async () => {
  const f = await fixture()
  f.call.mockImplementation(batchModel(async (_task, _system, input) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(input))
    if (support) return support
    const data = JSON.parse(input)
    if (data.validationFeedback) return '{"paragraph_id":0}尾随字符'
    const value = output(data); value.points[0]!.evidence = []
    return JSON.stringify(value)
  }))
  const result = await f.run()
  expect(f.call).toHaveBeenCalledTimes(2); expect(result.gaps).toMatchObject([{ kind: 'point', reasons: [{ rule: 'correction-schema' }] }])
  const directory = path.join(f.root, 'logs/failures/S-0001')
  const records = await Promise.all((await readdir(directory)).map(async file => JSON.parse(await readFile(path.join(directory, file), 'utf8'))))
  expect(records.some(record => record.raw_output === '{"paragraph_id":0}尾随字符')).toBe(true)
})

it('组级结构错误对半缩段，兄弟成功保留且第三层停止', async () => {
  const f = await fixture(16), sizes: number[] = []
  f.call.mockImplementation(batchModel(async (_task, _system, input) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(input))
    if (support) return support
    const data = JSON.parse(input); sizes.push(data.paragraphs.length)
    const value = output(data)
    if (data.paragraphs.some((part: { paragraph_id: number }) => part.paragraph_id < 8)) return JSON.stringify({ ...value, points: {} })
    return JSON.stringify(value)
  }))
  const result = await f.run()
  expect(sizes).toEqual([16, 8, 4, 2, 2, 4, 2, 2, 8])
  expect(result.gaps).toHaveLength(4); expect(result.gaps!.every(gap => gap.kind === 'group' && (gap.item as { depth: number }).depth === 3)).toBe(true)
  expect(result.gaps!.flatMap(gap => gap.segment_hashes).sort()).toEqual(f.source.segments.slice(0, 8).map(segment => segment.text_hash).sort())
  expect(result.segments.slice(8).map(segment => segment.points.length)).toEqual(Array(8).fill(1))
})

it('规范化和结构纠正不放宽逐字、定位或原主张校验', async () => {
  const f = await fixture(5)
  f.call.mockImplementation(batchModel(async (_task, _system, input) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(input))
    if (support) return support
    const data = JSON.parse(input)
    if (data.validationFeedback) {
      const item = data.validationFeedback.item
      if (item.paragraph_id === 4) return JSON.stringify({ ...item, text: '改写主张', evidence: [{ locator: 'L9-L9', quote: '证据 4。' }] })
      return JSON.stringify({ validationFeedback: { kind: 'point', item } })
    }
    const value = output(data)
    value.points[0]!.evidence[0]!.quote = ' 证据 0。 '
    value.points[1]!.evidence[0]!.locator = ' L3-L3 '
    value.points[2]!.evidence[0]!.locator = 'L1-L1'
    value.points[3]!.paragraph_id = '3' as never
    value.points[4]!.evidence = []
    return JSON.stringify(value)
  }))
  const result = await f.run()
  // 排版空白直接通过；已有主段号与定位冲突时仍须纠正，未完成纠正不能接收。
  expect(f.call).toHaveBeenCalledTimes(2)
  expect(result.segments.flatMap(segment => segment.points)).toMatchObject([{ evidence: [{ quote: '证据 0。' }] }])
  expect(result.gaps).toHaveLength(4)
  expect(result.gaps!.flatMap(gap => gap.reasons.map(reason => reason.rule)).sort()).toEqual(['correction-claim', 'item-schema:paragraph_id', 'locator-format', 'paragraph-range'])
})

it('单一主张提示与多证据回源通过，默认指纹升级重提且保留旧成果', async () => {
  const f = await fixture(), file = path.join(f.knowledgeRoot, 'a.md')
  await writeFile(file, '实验组改善。\n对照组未改善。')
  f.call.mockImplementation(batchModel(async (_task, system, input) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(input))
    if (support) return support
    if (JSON.parse(input).new_tags) return JSON.stringify({ groups: [] })
    expect(system).toContain('每个要点只写一个能被所附引文完整支持的主张')
    expect(system).toContain('拆成多个要点或附多段证据')
    const value = output(JSON.parse(input))
    value.points[0]!.text = '实验组相较对照组改善。'
    value.points[0]!.evidence = [{ locator: 'L1-L1', quote: '实验组改善。' }, { locator: 'L2-L2', quote: '对照组未改善。' }]
    return JSON.stringify(value)
  }))
  await buildLayeredLibrary({ ...f.options, promptVersion: 'layered-extract-v1' })
  const old = (await snapshotManifest(f.root)).sources[0]!, oldFile = path.join(f.root, old.extract.path), oldBytes = await readFile(oldFile)
  f.call.mockClear()
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ modelCalls: 1 })
  const entry = (await snapshotManifest(f.root)).sources[0]!
  expect(entry.extract.processing.prompt_version).toBe('layered-extract-v5')
  expect(entry.extract.processing_fingerprint).not.toBe(old.extract.processing_fingerprint)
  expect(entry.extract.path).not.toBe(old.extract.path); expect(await readFile(oldFile)).toEqual(oldBytes)
  const result: Extraction = JSON.parse(await readFile(path.join(f.root, entry.extract.path), 'utf8'))
  expect(result.gaps).toEqual([]); expect(result.segments[0]!.points[0]!.evidence).toHaveLength(2)
  for (const evidence of result.segments[0]!.points[0]!.evidence) {
    const original = await readLayeredSource(f.knowledgeRoot, entry.source_id, { sourceVersion: evidence.source_version, locator: evidence.locator })
    expect(original.content).toBe(evidence.quote)
  }
  f.call.mockClear()
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ unchanged: true, modelCalls: 0 }); expect(f.call).not.toHaveBeenCalled()
})
