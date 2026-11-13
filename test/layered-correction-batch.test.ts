import { existsSync } from 'node:fs'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { schemaExample, jsonProtocol } from '../src/llm/protocol.js'
import { extractSource, wireOutput, outputSchema } from '../src/layered/extraction.js'
import { reviewExtraction } from '../src/layered/review.js'
import { chapterMinimum, coveragePurpose, sourceChapters } from '../src/layered/longdoc.js'
import { layeredSettings } from '../src/domain/config.js'
import { readLocalSource } from '../src/layered/snapshot.js'
import { correctionBatches } from '../src/layered/corrections.js'
import { cleanupLayeredFixtures, layeredFixture } from './layered-fixture.js'
import type { Extraction, Processing } from '../src/layered/schema.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
const processing: Processing = { tier: 50, prompt_version: '批量协议测试', model: 'mock/extractor' }
const envelope = (points: unknown[], terms: unknown[] = []) => ({ tags: ['方法', '对象', '结果'], credibility: 'low', credibility_reason: '公开测试资料', points, terms })
async function fixture(text: string) {
  const f = await layeredFixture(), file = path.join(f.knowledgeRoot, 'paper.md')
  await writeFile(file, text)
  const source = await readLocalSource(file, 'Markdown')
  return { ...f, source, run: (previous?: Extraction) => extractSource(f.root, 'S-0001', source, processing, f.options, 64000, previous) }
}

it.skipIf(!(existsSync(new URL('./fixtures/correction-20h-request.json', import.meta.url)) && existsSync(new URL('./fixtures/correction-20h-output.txt', import.meta.url))))('同源完整示例通过校验，真实20h请求与旧输出按新协议离线首提通过结构校验（夹具含第三方论文原文，未随公开仓库发布）', async () => {
  const request = JSON.parse(await readFile(new URL('./fixtures/correction-20h-request.json', import.meta.url), 'utf8'))
  const captured = JSON.parse(await readFile(new URL('./fixtures/correction-20h-output.txt', import.meta.url), 'utf8'))
  const example = wireOutput.parse(schemaExample(wireOutput.toJSONSchema()))
  expect(example.points[0]!.evidence).toHaveLength(2)
  expect(example.terms[0]!.referent).toBeTruthy()
  expect(wireOutput.safeParse(captured).success).toBe(false)
  // 保留真实主张与引文；假模型依照新协议补齐结构，绝不把旧输出冒充真实新模型结果。
  const first = { ...captured, points: captured.points.map((point: any) => ({ ...point, paragraph_id: point.evidence[0].paragraph_id, section: '主要发现',
    evidence: point.evidence.map((evidence: any) => ({ ...evidence, locator: request.input.paragraphs.find((part: any) => part.paragraph_id === evidence.paragraph_id).locator })) })),
  terms: captured.terms.map((term: any) => {
    const part = request.input.paragraphs.find((part: any) => [term.term, ...term.aliases].some(name => part.text?.includes(name)))
    expect(part).toBeDefined()
    return { ...term, name: term.term, paragraph_id: part.paragraph_id, locator: part.locator, category: '概念', note: term.referent }
  }) }
  const protocol = jsonProtocol(request.system, wireOutput.toJSONSchema())
  expect(protocol).toContain('合法JSON示例'); expect(protocol).toContain('referent'); expect(protocol).toContain('paragraph_id')
  expect(outputSchema.parse(first).points.map(point => point.text)).toEqual(captured.points.map((point: any) => point.text))
  expect(outputSchema.parse(first).terms.map(term => term.referent)).toEqual(captured.terms.map((term: any) => term.referent))
  expect(first.points).toHaveLength(28)
})

it('缺顶层字段批量一次修复，局部前后两段、跨段逐字证据及 referent 保留', async () => {
  const f = await fixture(Array.from({ length: 14 }, (_, i) => '段' + i + '研究结果。').join('\n\n'))
  let corrections = 0
  f.call.mockImplementation(async (_task, system, input) => {
    const data = JSON.parse(input)
    if (data.correction_stage) {
      corrections++
      expect(data.items).toHaveLength(4)
      expect(data).not.toHaveProperty('paragraphs')
      expect(system).toContain('不得改写主张')
      return JSON.stringify({ items: data.items.map((item: any) => {
        expect(item.paragraphs.length).toBeLessThanOrEqual(item.id === 'point:0' ? 10 : 5)
        const original = item.validationFeedback.item
        return { id: item.id, paragraph_id: original.evidence ? Number(original.evidence[0].quote.match(/段(\d+)/)[1]) : 6,
          ...(original.evidence ? { section: '主要发现', evidence: original.evidence } : { locator: 'L13-L13' }) }
      }) })
    }
    const point = (id: number) => ({ text: '主张' + id, evidence: [{ locator: 'L' + (id * 2 + 1) + '-L' + (id * 2 + 1), quote: '段' + id + '研究结果。' }] })
    const cross = point(2); cross.evidence.push(point(10).evidence[0]!)
    return JSON.stringify(envelope([cross, point(5), point(8)], [{ name: '术语', category: '概念', aliases: [], note: '稳定原含义', referent: '原指称', locator: 'L13-L13' }]))
  })
  const result = await f.run()
  expect(corrections).toBe(1); expect(f.call).toHaveBeenCalledTimes(2)
  expect(result.gaps).toEqual([])
  expect(result.segments[2]!.points[0]!.evidence.map(item => item.quote)).toEqual(['段2研究结果。', '段10研究结果。'])
  expect(result.segments[6]!.terms[0]).toMatchObject({ name: '术语', note: '稳定原含义', referent: '原指称' })
  expect(Object.values(result.correction_attempts!).map(item => item.structure)).toEqual([1, 1, 1, 1])
  // 增量插入首段后，各条跨段证据独立重绑，不能沿用主段偏移或旧段号。
  const at = f.source.segments[6]!.start
  const changedText = f.source.text.slice(0, at) + '新增说明。\n\n' + f.source.text.slice(at)
  await writeFile(f.source.path, changedText)
  const changed = await readLocalSource(f.source.path, 'Markdown')
  f.call.mockResolvedValue(JSON.stringify(envelope([])))
  const rebound = await extractSource(f.root, 'S-0001', changed, processing, f.options, 64000, result)
  expect(rebound.segments[2]!.points[0]!.evidence.map(item => item.locator)).toEqual(['L5-L5', 'L23-L23'])
  expect(rebound.segments[7]!.terms[0]!.referent).toBe('原指称')
})

it('批次最多两批且逐字错误保持拒绝，取消续做不重复用尽的结构尝试', async () => {
  expect(correctionBatches([1, 2, 3, 4, 5], values => values.length <= 2)).toEqual({ batches: [[1, 2], [3, 4]], overflow: [5] })
  const f = await fixture('结果为20%。'), abort = new AbortController()
  f.options.signal = abort.signal
  f.call.mockImplementation(async (_task, _system, input) => {
    const data = JSON.parse(input)
    if (data.correction_stage) { abort.abort(new Error('取消')); return JSON.stringify({ items: [{ id: 'point:0', paragraph_id: 0, section: '主要发现', evidence: [{ locator: 'L1-L1', quote: '结果为30%。' }] }] }) }
    return JSON.stringify(envelope([{ paragraph_id: 0, text: '结果为20%。', section: '主要发现', evidence: [{ locator: 'L1-L1', quote: '结果为30%。' }] }]))
  })
  await expect(f.run()).rejects.toThrow('取消')
  const files = await readdir(path.join(f.root, 'work/extractions'), { recursive: true })
  const saved = JSON.parse(await readFile(path.join(f.root, 'work/extractions', files.find(file => file.endsWith('-progress.json'))!), 'utf8')) as Extraction
  expect(saved.segments[0]!.points).toEqual([])
  delete f.options.signal
  const resumed = await f.run(saved)
  expect(f.call).toHaveBeenCalledTimes(2)
  expect(resumed.segments[0]!.points).toEqual([])
  expect(resumed.gaps!.flatMap(gap => gap.reasons.map(reason => reason.rule))).toContain('correction-limit')
})

it('覆盖按用途排除全部元数据，含研究结果仍覆盖且正文未达底线只补一次', async () => {
  const labels = ['Author information', 'Author contributions', 'ORCID', 'Conflicts of interest', 'Funding', 'Acknowledgments', 'Publication information', 'Supplementary material', 'References', 'Author biographies']
  for (const title of labels) expect(coveragePurpose(title, 'Alice; https://example.org/0000')).not.toBe('研究内容')
  expect(coveragePurpose('Supplementary material', 'Results show an improvement of 20%.')).toBe('研究内容')
  const f = await fixture(labels.map(title => '# ' + title + '\n\nAlice; https://example.org/0000').join('\n\n'))
  // 纯行政资料没有研究候选；首次提取仍送全文，覆盖阶段不能为它追加模型请求。
  f.call.mockResolvedValue(JSON.stringify(envelope([])))
  const result = await f.run(), chapters = sourceChapters(f.source)
  const parts = f.source.segments.map((segment, paragraph_id) => ({ ...segment, paragraph_id, text: f.source.text.slice(segment.start, segment.end) }))
  expect(chapters.map(chapter => chapterMinimum(chapter, parts, layeredSettings()))).toEqual(Array(10).fill(0))
  expect(f.call).toHaveBeenCalledTimes(1); expect(result.gaps).toEqual([]); expect(result.segments.flatMap(segment => segment.points)).toEqual([])
})

it('补证统一一批且按同一长行新跨度验收，程序保留原主张，续做零重复', async () => {
  const f = await fixture('设计A。结果为20%。条件B。')
  f.call.mockResolvedValue(JSON.stringify(envelope([0, 1].map(id => ({ paragraph_id: 0, text: '设计A的结果为20%。' + id, section: '主要发现', evidence: [{ locator: 'L1-L1', quote: '设计A。' }] })))))
  const extracted = await f.run(); f.call.mockClear()
  f.call.mockImplementation(async (_task, _system, input) => {
    const data = JSON.parse(input)
    if (data.review_stage === 'extraction') return JSON.stringify({ items: data.points.map((point: any) => ({ id: point.id, support: '部分支撑', missing: '补充结果' })) })
    expect(data.items).toHaveLength(2)
    return JSON.stringify({ items: data.items.map((point: any) => ({ id: point.id, evidence: [{ locator: 'L1-L1', quote: '设计A。结果为20%。' }], support: '完整支撑', missing: '' })) })
  })
  expect(await reviewExtraction(extracted, f.source, { ...f.options, topics: { extractionReview: 'all' } }, 64000)).toBe(2)
  expect(extracted.segments[0]!.points.map(point => point.text)).toEqual(['设计A的结果为20%。0', '设计A的结果为20%。1'])
  expect(extracted.segments[0]!.points.map(point => point.verification?.status)).toEqual(['verified', 'verified'])
  expect(await reviewExtraction(extracted, f.source, { ...f.options, topics: { extractionReview: 'all' } }, 64000)).toBe(0)
  expect(f.call).toHaveBeenCalledTimes(2)
})
