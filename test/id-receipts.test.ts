import { afterEach, expect, it, vi } from 'vitest'
import { readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { validatedTask } from '../src/layered/extraction-cache.js'
import { writeJson } from '../src/layered/files.js'
import { extractSource } from '../src/layered/extraction.js'
import { readLocalSource } from '../src/layered/snapshot.js'
import { sameClaim, repairParagraphs } from '../src/layered/corrections.js'
import { reviewTopicContent } from '../src/layered/topic-review.js'
import { prepareTerms } from '../src/layered/terms.js'
import { readExtraction } from '../src/layered/publication.js'
import { pendingFixture } from './pipeline-audit-fixture.js'
import type { TermRecord } from '../src/layered/schema.js'
import { buildLayeredLibrary, revokeLayeredSources } from '../src/layered/index.js'
import { cleanupLayeredFixtures, layeredFixture } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
const valid = (value: { text: string }) => value.text === '已核对'

it('同键并发与新调用方共用已校验回执，副本修改不污染缓存', async () => {
  const f = await layeredFixture(), work = vi.fn(async () => ({ text: '已核对' }))
  const run = () => validatedTask(f.options, 'term', { input: '输入', system: '规则', schema: {} }, work, valid)
  const results = await Promise.all(Array.from({ length: 3 }, run))
  expect(work).toHaveBeenCalledTimes(1)
  results[0]!.value.text = '调用方修改'
  expect((await run()).value.text).toBe('已核对')
  expect((await run()).reused).toBe(true)
  expect(work).toHaveBeenCalledTimes(1)
})

it('完整身份的上下文来源协议图片模型参数变化全部失效', async () => {
  const f = await layeredFixture(), work = vi.fn(async () => ({ text: '已核对' }))
  const base = { input: '输入', system: '规则', schema: { type: 'string' }, context: '上下文', sourceVersion: 'v1', protocol: '核对1', images: ['图片哈希1'] }
  await validatedTask(f.options, 'term', base, work, valid)
  for (const patch of [{ context: '新上下文' }, { sourceVersion: 'v2' }, { protocol: '核对2' }, { images: ['图片哈希2'] }]) {
    expect((await validatedTask(f.options, 'term', { ...base, ...patch }, work, valid)).reused).toBe(false)
  }
  expect((await validatedTask({ ...f.options, taskModelIdentity: { reasoningEffort: 'high' } }, 'term', base, work, valid)).reused).toBe(false)
  expect(work).toHaveBeenCalledTimes(6)
})

it('未通过校验和传输失败不封存，撤权代次变化拒绝旧回执', async () => {
  const f = await layeredFixture(), work = vi.fn(async () => ({ text: '错误' }))
  const run = () => validatedTask(f.options, 'term', '输入', work, valid)
  await run(); await run(); expect(work).toHaveBeenCalledTimes(2)
  work.mockRejectedValueOnce(new Error('传输失败'))
  await expect(run()).rejects.toThrow('传输失败')
  work.mockResolvedValue({ text: '已核对' })
  await run(); expect((await run()).reused).toBe(true)
  await writeJson(f.root, 'state/revocations.json', { generation: 1, sources: [] })
  expect((await run()).reused).toBe(false)
  expect(work).toHaveBeenCalledTimes(5)
})

it('一个订阅者取消不会取消其他订阅者，完成结果仍可复用', async () => {
  const f = await layeredFixture(), abort = new AbortController(), started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
  const work = vi.fn(async (signal: AbortSignal) => { started.resolve(); await finish.promise; signal.throwIfAborted(); return { text: '已核对' } })
  const a = validatedTask({ ...f.options, signal: abort.signal }, 'term', '输入', work, valid)
  const b = validatedTask(f.options, 'term', '输入', work, valid)
  const rejected = expect(a).rejects.toThrow('取消甲')
  await started.promise; await new Promise(resolve => setTimeout(resolve, 10)); abort.abort(new Error('取消甲')); finish.resolve()
  await rejected; expect((await b).value.text).toBe('已核对')
  expect(work).toHaveBeenCalledTimes(1)
})

it('同一输入提取两次第二次零调用，磁盘回执损坏时重做校验', async () => {
  const f = await layeredFixture(), file = path.join(f.knowledgeRoot, 'a.md')
  await writeFile(file, '本研究有三十名参与者。')
  const source = await readLocalSource(file, 'Markdown')
  const run = () => extractSource(f.root, 'S-0001', source, { tier: 50, prompt_version: '回执测试' }, f.options, 64000)
  const first = await run(); expect(first.gaps ?? []).toEqual([])
  f.call.mockClear()
  const second = await run()
  expect(second.segments).toEqual(first.segments); expect(second.calls).toEqual([]); expect(f.call).not.toHaveBeenCalled()
  const files = await readdir(path.join(f.root, 'cache/tasks'))
  for (const name of files) await writeFile(path.join(f.root, 'cache/tasks', name), '{}')
  // 现有提取检查点仍能恢复；损坏的回执不得返回缺字段对象。
  expect((await run()).segments).toEqual(first.segments)
})

it('撤权物理清除回执，在途任务结束不能重新落入撤权内容', async () => {
  const f = await layeredFixture()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '撤权证据只在该篇出现。')
  await buildLayeredLibrary(f.options)
  expect((await readdir(path.join(f.root, 'cache/tasks'))).length).toBeGreaterThan(0)
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
  const work = validatedTask(f.options, 'term', '在途任务', async () => { started.resolve(); await finish.promise; return { text: '已核对' } }, valid)
  await started.promise
  await revokeLayeredSources(f.knowledgeRoot, ['S-0001'], '撤回测试授权')
  finish.resolve(); await work
  expect(await readdir(path.join(f.root, 'cache/tasks'))).toEqual([])
})

const parts = [
  { paragraph_id: 0, locator: 'L1-L1', text_hash: '甲', text: '甲组有３０名参与者。' },
  { paragraph_id: 1, locator: 'L3-L3', text_hash: '乙', text: '乙组没有参与研究。' },
]
const misplaced = (quote: string) => ({ paragraph_id: 99, text: '原主张', evidence: [{ paragraph_id: 99, locator: 'L99-L99', quote }] })

it('唯一逐字命中修正段号，排版宽容但不改主张', () => {
  const input = misplaced('甲组有30名参与者。'), result = repairParagraphs(parts, input)
  expect(result).toMatchObject({ paragraph_id: 0, text: '原主张', evidence: [{ paragraph_id: 0, locator: 'L1-L1' }] })
  expect(input.paragraph_id).toBe(99)
  expect(sameClaim('甲组有３０名参与者。', '甲组有30名参与者。')).toBe(true)
})

it('多段命中不猜测段号', () => {
  const input = misplaced('甲组有30名参与者。')
  expect(repairParagraphs([...parts, { ...parts[0]!, paragraph_id: 2, locator: 'L5-L5' }], input)).toEqual(input)
})

it('零命中不做相似替换', () => {
  const input = misplaced('甲组有31名参与者。')
  expect(repairParagraphs(parts, input)).toEqual(input)
})

it('同批唯一定位项不请求纠正，其他结构错误照常纠正', async () => {
  const f = await layeredFixture(), file = path.join(f.knowledgeRoot, 'a.md')
  await writeFile(file, parts.map(part => part.text).join('\n\n'))
  const source = await readLocalSource(file, 'Markdown'), corrections: any[] = []
  f.call.mockImplementation(async (_task, _system, raw) => {
    const input = JSON.parse(raw)
    if (input.correction_stage) {
      corrections.push(input)
      return JSON.stringify({ items: input.items.map((item: any) => ({ id: item.id, paragraph_id: item.validationFeedback.item.paragraph_id, section: '主要发现' })) })
    }
    return JSON.stringify({ tags: ['方法', '对象', '结果'], credibility: 'low', credibility_reason: '公开测试', terms: [],
      points: [{ ...misplaced('甲组有30名参与者。'), text: '甲组有30名参与者。', section: '主要发现' },
        { ...misplaced('乙组没有参与研究。'), text: '乙组没有参与研究。', section: '错误分类' }] })
  })
  const result = await extractSource(f.root, 'S-0001', source, { tier: 50, prompt_version: '定位测试' }, f.options, 64000)
  expect(corrections).toHaveLength(1); expect(corrections[0].items.map((item: any) => item.id)).toEqual(['point:1'])
  expect(result.gaps).toEqual([])
  expect(result.segments.flatMap(segment => segment.points).map(point => point.text)).toEqual(['甲组有30名参与者。', '乙组没有参与研究。'])
})

it.each([
  ['否定词', '甲组参与研究。'], ['数字', '甲组没有参与30项研究。'], ['归属对象', '乙组没有参与研究。'],
])('主题纠正更改%s拒收并留下缺口', async (_kind, changed) => {
  const f = await layeredFixture(), original = '甲组没有参与研究。', locator = 'L1-L1'
  const point = { point_id: 'S-0001:p', text_hash: 'h', locator, source_version: 'v1', text: original, section: '主要发现' as const,
    evidence: [{ source_id: 'S-0001', source_version: 'v1', locator, quote: original }] }
  const link = '[依据](../sources/S-0001.md#p)'
  f.options.topics = { topicReview: true }
  f.call.mockImplementation(async (_task, _system, raw) => {
    const input = JSON.parse(raw)
    if (input.review_stage === 'topic-correction') return JSON.stringify({ sentences: input.sentences.map((sentence: any) => ({
      id: sentence.id, text: sentence.text.replace(original, changed), point_ids: ['P1'], support: '完整支撑', missing: null })) })
    return JSON.stringify({ items: input.sentences.map((sentence: any) => ({ id: sentence.id,
      support: sentence.text.includes(original) ? '不支撑' : '完整支撑', missing: sentence.text.includes(original) ? '缺少支撑' : null })) })
  })
  const result = await reviewTopicContent('T-0001', '# 主题\n\n' + original + link, [point], f.options)
  expect(result.content).not.toContain(changed)
  expect(result.review!.removed.length).toBeGreaterThan(0)
  expect(sameClaim(original, changed)).toBe(false)
})

it('贡献身份优先于同名候选，同名异义隔离且冷建确定', async () => {
  const f = await pendingFixture()
  f.options.topics = { ...f.options.topics as object, termThreshold50: 100 }
  for (const [index, source] of f.pending.manifest.sources.entries()) {
    const extraction = await readExtraction(f.root, source.extract.path)
    for (const segment of extraction.segments) segment.terms = []
    const segment = extraction.segments.find(segment => segment.points.length)!
    segment.terms = [{ name: '同名术语', category: '概念', aliases: [], note: '证据' + index, referent: '指称' + index, locator: segment.locator }]
    source.extract.path = source.extract.path.replace('.json', '-identity.json')
    await writeFile(path.join(f.root, source.extract.path), JSON.stringify(extraction))
  }
  delete f.pending.terms
  await prepareTerms(f.root, f.pending, f.committed, f.options)
  const original = structuredClone(f.pending.terms!.records), next = f.pending.manifest.next_term_number
  expect(original).toHaveLength(2)
  // 强制先出现的贡献持有较大的旧 ID，重现旧算法按名称抢占较小 ID 的错误。
  original[0]!.id = 'TM-0099'; original[1]!.id = 'TM-0001'
  f.pending.terms!.records = original.toSorted((a, b) => a.id.localeCompare(b.id)); f.pending.terms!.fingerprint = ''
  await prepareTerms(f.root, f.pending, f.committed, f.options)
  const identity = (records: typeof original) => records.map(record => [record.contributions[0]!.key, record.id]).sort()
  expect(identity(f.pending.terms!.records)).toEqual(identity(original))
  const source = f.pending.manifest.sources[0]!, extraction = await readExtraction(f.root, source.extract.path)
  const segment = extraction.segments.find(segment => segment.terms.length)!
  segment.terms.push({ ...segment.terms[0]!, name: '新术语', referent: '新指称', note: '新证据' })
  source.extract.path = source.extract.path.replace('.json', '-new.json')
  await writeFile(path.join(f.root, source.extract.path), JSON.stringify(extraction))
  await prepareTerms(f.root, f.pending, f.committed, f.options)
  expect(f.pending.terms!.records).toHaveLength(3)
  expect(new Set(f.pending.terms!.records.map(record => record.id)).size).toBe(3)
  expect(identity(f.pending.terms!.records.filter(record => record.name === '同名术语'))).toEqual(identity(original))
  const cold = async () => { delete f.pending.terms; f.pending.manifest.next_term_number = 1; await prepareTerms(f.root, f.pending, f.committed, f.options); return identity(f.pending.terms!.records) }
  expect(await cold()).toEqual(await cold()); expect(next).toBe(3)
})

it('术语回执在纠正全部通过后封存，重做同一分节零调用', async () => {
  const f = await pendingFixture()
  f.options.topics = { ...f.options.topics as object, termThreshold50: 2 }
  await prepareTerms(f.root, f.pending, f.committed, f.options)
  const contributions = await Promise.all(f.pending.manifest.sources.map(async (source, index) => {
    const segment = (await readExtraction(f.root, source.extract.path)).segments.find(segment => segment.points.length)!
    return { key: '测试贡献' + index, name: '共同术语', aliases: [], category: '概念', note: '原主张。',
      source_id: source.source_id, source_version: source.source_version, text_hash: segment.text_hash,
      locator: segment.locator, point_ids: segment.points.map(point => point.point_id), vector: [] }
  }))
  const record: TermRecord = { id: 'TM-0001', name: '共同术语', category: '概念', aliases: [], contributions, sections: [], split: false }
  f.pending.terms!.records = [record]; f.pending.terms!.pages = {}; f.pending.terms!.rewritten = []
  f.call.mockClear()
  f.call.mockImplementation(async (_task, _system, raw) => {
    const input = JSON.parse(raw)
    return JSON.stringify(input.items ? { items: input.items.map((item: any) => ({ id: item.id, text: item.text, keys: ['R1'] })) }
      : { definition: [{ text: '原主张。', keys: ['R999'] }], usage: [], findings: [], differences: [] })
  })
  await prepareTerms(f.root, f.pending, f.committed, f.options)
  expect(f.call).toHaveBeenCalledTimes(2)
  const content = record.sections[0]!.content
  record.sections[0]!.fingerprint = ''; f.pending.terms!.pages = {}; f.pending.terms!.rewritten = []
  f.call.mockClear()
  await prepareTerms(f.root, f.pending, f.committed, f.options)
  expect(f.call).not.toHaveBeenCalled(); expect(record.sections[0]!.content).toBe(content)
})
