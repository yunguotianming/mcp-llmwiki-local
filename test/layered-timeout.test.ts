import { batchModel } from './layered-fixture.js'
import { mockSupportReview } from './layered-fixture.js'
import * as filesystem from 'node:fs/promises'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { layeredSettings } from '../src/domain/config.js'
import { ModelCallError } from '../src/llm/client.js'
import { buildLayeredLibrary, readLayeredPage } from '../src/layered/index.js'
import { extractSource } from '../src/layered/extraction.js'
import { readLocalSource } from '../src/layered/snapshot.js'
import type { Extraction, Processing } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, layeredFixture, layeredTopicFixture, modelOutput, snapshotManifest } from './layered-fixture.js'
import type { ExtractionInput } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => { vi.useRealTimers(); cleanupLayeredFixtures() })
const processing: Processing = { tier: 50, granularity: 'custom', prompt_version: 'layered-extract-v1', model: 'mock/extractor' }
const body = (count: number, length = 1) => Array.from({ length: count }, (_, i) => `${i}：${'原文证据。'.repeat(length)}`).join('\n\n')
function output(input: ExtractionInput) {
  if ('new_tags' in input) return JSON.stringify({ groups: [] })
  if (input.summary_id) return modelOutput(input)
  return JSON.stringify({ tags: ['研究方法', '研究对象', '核心主题'], credibility: 'low', credibility_reason: '测试笔记', terms: [], points: input.paragraphs.slice(0, input.point_limit).map(part => ({
    paragraph_id: part.paragraph_id, text: `主张 ${part.paragraph_id}`, section: '主要发现', evidence: [{ locator: part.locator, quote: part.text }],
  })) })
}
async function saved(root: string, index = 0): Promise<Extraction> {
  const source = (await snapshotManifest(root)).sources[index]!
  return JSON.parse(await readFile(path.join(root, source.extract.path), 'utf8'))
}
// 只推进模型超时；文件 IO 继续使用真实事件循环，不等待真实的 600 秒。
async function drive<T>(work: Promise<T>): Promise<T> {
  let done = false
  const observed = work.then(value => ({ value }), error => ({ error })).finally(() => { done = true })
  while (!done) { await setImmediate(); await vi.advanceTimersByTimeAsync(600000) }
  const result = await observed
  if ('error' in result) throw result.error
  return result.value
}

it('默认请求超时按段对半重试，覆盖全部段落且最终 ID 等于未缩段', async () => {
  const f = await layeredFixture(), file = path.join(f.knowledgeRoot, 'a.md')
  await writeFile(file, body(4))
  const source = await readLocalSource(file, 'Markdown')
  // 对照与超时分支使用独立缓存，确保本项实际经过超时和缩段路径。
  const reference = await layeredFixture()
  reference.call.mockImplementation(batchModel(async (_task, _system, input) => output(JSON.parse(input))))
  const baseline = await extractSource(reference.root, 'S-0001', source, processing, reference.options, 32000)
  f.call.mockRestore()
  const groups: number[][] = []
  f.runtime.stream = async function* (options) {
    const input = JSON.parse((options.messages[0]!.content[0] as { text: string }).text) as ExtractionInput
      const support = mockSupportReview(input)
      if (support) { yield { type: 'text-delta', index: 0, text: support }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
    if (input.summary_id) { yield { type: 'text-delta', index: 0, text: modelOutput(input) }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
    groups.push(input.paragraphs.map(part => part.paragraph_id))
    if (input.paragraphs.length > 2) await new Promise<void>((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true }))
    yield { type: 'text-delta', index: 0, text: output(input) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(milliseconds => {
    const abort = new AbortController()
    setTimeout(() => abort.abort(new DOMException('模拟请求超时', 'TimeoutError')), milliseconds)
    return abort.signal
  })
  const result = await drive(extractSource(f.root, 'S-0001', source, processing, f.options, 32000))
  expect(timeout).toHaveBeenCalledWith(600000)
  expect(groups).toEqual([[0, 1, 2, 3], [0, 1], [2, 3]])
  expect(result.segments).toEqual(baseline.segments)
  expect(result.gaps).toEqual([])
  expect(result.segments.map(segment => segment.points[0]!.point_id)).toEqual(result.segments.map(segment => `S-0001:${segment.text_hash}:01`))
})

it('缩到单段失败和单篇结构失败均记缺口，其他组及来源继续发布主题', async () => {
  const f = await layeredTopicFixture(), original = f.call.getMockImplementation()!
  await Promise.all([writeFile(path.join(f.knowledgeRoot, 'a.md'), body(8, 60)), writeFile(path.join(f.knowledgeRoot, 'b.md'), '不可恢复。'), writeFile(path.join(f.knowledgeRoot, 'c.md'), '其他来源。')])
  // 保持八段故障隔离夹具的原额度，短文降额由专项测试覆盖。
  f.options.granularity = 'custom'; f.options.maxInputBytes = 6500; f.policy.pageGenerationConcurrency = 3
  const failedSizes: number[] = []
  f.call.mockImplementation(batchModel(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
    const input = JSON.parse(args[2])
    if (input.topic_id || input.summary_id) return original(...args)
    if (input.source_id === 'S-0002') return '{}'
    if (input.source_id === 'S-0001' && input.paragraphs.some((part: { paragraph_id: number }) => part.paragraph_id === 0)) {
      failedSizes.push(input.paragraphs.length); throw new DOMException('持续超时', 'TimeoutError')
    }
    return output(input)
  }))
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ version: 'v000001' })
  expect(failedSizes).toContain(1); expect(Math.max(...failedSizes)).toBeGreaterThan(1)
  const first = await saved(f.root), second = await saved(f.root, 1), third = await saved(f.root, 2)
  expect(first.segments.map(segment => segment.points.length)).toEqual([0, 1, 1, 1, 1, 1, 1, 1])
  expect(first.gaps).toMatchObject([{ kind: 'group', segment_hashes: [first.segments[0]!.text_hash] }])
  expect(second.segments.flatMap(segment => segment.points)).toEqual([]); expect(second.gaps?.[0]?.kind).toBe('group')
  expect(third.segments[0]!.points).toHaveLength(1)
  expect(await readLayeredPage(f.knowledgeRoot, 'sources/S-0002.md')).toContain('提取缺口')
  const topics = JSON.parse(await readFile(path.join(f.root, 'state/topics.json'), 'utf8'))
  expect(topics.topics.flatMap((topic: { sources: string[] }) => topic.sources)).not.toContain('S-0002')
  expect(await readFile(path.join(f.root, 'logs/build.md'), 'utf8')).toContain('提取缺口 S-0001（提取组）')
})

it.each(['输出截断', 'JSON 不完整'])('%s 按长度失败缩段，三层耗尽保留完整缺口覆盖', async kind => {
  const f = await layeredFixture(), file = path.join(f.knowledgeRoot, 'a.md')
  await writeFile(file, body(16))
  const source = await readLocalSource(file, 'Markdown'), sizes: number[] = []
  f.call.mockImplementation(batchModel(async (_task, _system, input) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(input))
    if (support) return support
    sizes.push(JSON.parse(input).paragraphs.length)
    if (kind === '输出截断') throw new ModelCallError('输出截断', 'length')
    return '{"points":['
  }))
  const result = await extractSource(f.root, 'S-0001', source, processing, f.options, 32000)
  expect(sizes).toHaveLength(15); expect(Math.min(...sizes)).toBe(2)
  expect(result.gaps).toHaveLength(8)
  expect(result.gaps!.every(gap => (gap.item as { depth: number }).depth === 3)).toBe(true)
  expect(result.gaps!.flatMap(gap => gap.segment_hashes).sort()).toEqual(source.segments.map(segment => segment.text_hash).sort())
})

it.each(['IO', '取消', '预算'])('%s 仍中止建库且不缩段、不发布', async kind => {
  const f = await layeredFixture(), abort = new AbortController()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), body(4))
  f.options.signal = abort.signal
  const error = kind === 'IO' ? Object.assign(new Error('模拟 IO 故障'), { code: 'EIO' })
    : kind === '预算' ? Object.assign(new Error('模拟预算暂停'), { budgetPause: true }) : new Error('用户取消')
  if (kind === 'IO') {
    const rename = filesystem.rename
    vi.spyOn(filesystem, 'rename').mockImplementation(async (from, to) => {
      if (String(to).includes(path.sep + 'failures' + path.sep)) throw error
      return rename(from, to)
    })
  }
  f.call.mockImplementation(batchModel(async () => { if (kind === '取消') abort.abort(error); throw kind === 'IO' ? new DOMException('先触发超时留痕', 'TimeoutError') : error }))
  await expect(buildLayeredLibrary(f.options)).rejects.toBe(error)
  expect(f.call).toHaveBeenCalledTimes(1)
  await expect(readFile(path.join(f.root, 'state/current.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  if (kind === '预算') expect(JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8')).paused.reason).toBe('budget')
})

it('单次输入按设置和上下文取小，85% 目标与 90% 上限生效且设置值不入指纹', async () => {
  const f = await layeredFixture(), file = path.join(f.knowledgeRoot, 'a.md')
  f.options.granularity = 'custom' // 固定五十点，只验输入装箱；篇幅扩额由选点专项覆盖。
  await writeFile(file, body(16, 480))
  f.runtime.resolveModelInfo = async (provider, id) => ({ provider, id, name: id, context: { contextWindow: 256000 } })
  f.call.mockImplementation(batchModel(async (_task, _system, input) => output(JSON.parse(input))))
  expect(layeredSettings().extractMaxInputBytes).toBe(98304)
  expect(() => layeredSettings({ extractMaxInputBytes: 0 })).toThrow('正整数')
  await buildLayeredLibrary(f.options)
  const initial = await saved(f.root)
  expect(initial.calls.length).toBeGreaterThan(1)
  expect(initial.calls.every(call => call.input_limit === 98304 && call.input_bytes <= 98304 * 0.9)).toBe(true)
  expect(initial.calls[0]!.input_bytes).toBeGreaterThan(98304 * 0.8)
  f.options.topics = { extractMaxInputBytes: 300000 }; f.options.embeddingClient = { identity: async () => 'fixture-weights-v1', embed: async texts => texts.map(() => [1, 0]) }
  // 此项只验证提取；空要点避免触发主题调用。
  f.call.mockImplementation(batchModel(async (_task, _system, input) => JSON.stringify(JSON.parse(input).new_tags ? { groups: [] } : { tags: ['研究方法', '研究对象', '核心主题'], credibility: 'low', credibility_reason: '测试', points: [], terms: [] })))
  f.policy.contextWindowTokens = 64000
  await buildLayeredLibrary(f.options)
  const limited = await saved(f.root)
  expect(limited.calls.every(call => call.input_limit === 63872 && call.input_bytes <= 63872 * 0.9)).toBe(true)
  expect(limited.grouping_fingerprint).not.toBe(initial.grouping_fingerprint)
  f.options.topics.extractMaxInputBytes = 400000
  f.call.mockClear()
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ unchanged: true, modelCalls: 0 })
  expect(f.call).not.toHaveBeenCalled()
})

it('纠正改变主张即丢弃，单改定位或规范化空白保持主张可通过', async () => {
  const f = await layeredFixture(), file = path.join(f.knowledgeRoot, 'a.md')
  await writeFile(file, body(3))
  const source = await readLocalSource(file, 'Markdown')
  f.call.mockImplementation(batchModel(async (_task, system, input) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(input))
    if (support) return support
    const data = JSON.parse(input)
    if (data.validationFeedback) {
      expect(system).toContain('只允许修改证据定位'); expect(system).toContain('不得改写主张')
      const item = data.validationFeedback.item, part = data.paragraphs.find((part: any) => part.paragraph_id === item.paragraph_id)
      return JSON.stringify({ ...item, text: item.paragraph_id === 0 ? '被改写的主张' : item.paragraph_id === 2 ? '  主张\n  2 ' : item.text,
        evidence: [{ locator: part.locator, quote: part.text }] })
    }
    const value = JSON.parse(output(data))
    for (const point of value.points) point.evidence[0].locator = 'L99-L99'
    return JSON.stringify(value)
  }))
  const result = await extractSource(f.root, 'S-0001', source, processing, f.options, 32000)
  expect(result.segments.map(segment => segment.points.length)).toEqual([0, 1, 1])
  expect(result.gaps).toMatchObject([{ kind: 'point', reasons: [{ rule: 'correction-claim', actual: '纠正改变主张' }] }])
  expect(f.call).toHaveBeenCalledTimes(2) // 一次首提加一批三项纠正，保留逐项主张与引文断言。
})

it('缩段中预算暂停后复用成功叶段与拆分树，恢复不重跑父组', async () => {
  const f = await layeredFixture(), file = path.join(f.knowledgeRoot, 'a.md')
  await writeFile(file, body(4))
  let pause = true
  const groups: number[][] = []
  f.call.mockImplementation(batchModel(async (_task, _system, input) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(input))
    if (support) return support
    const data = JSON.parse(input)
    if (data.new_tags) return JSON.stringify({ groups: [] })
    const ids = data.paragraphs.map((part: { paragraph_id: number }) => part.paragraph_id)
    groups.push(ids)
    if (ids.length === 4) throw new DOMException('模拟超时', 'TimeoutError')
    if (ids[0] === 2 && pause) throw Object.assign(new Error('预算暂停'), { budgetPause: true })
    return output(data)
  }))
  await expect(buildLayeredLibrary(f.options)).rejects.toThrow('预算暂停')
  pause = false
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ version: 'v000001' })
  expect(groups).toEqual([[0, 1, 2, 3], [0, 1], [2, 3], [2, 3]])
  const result = await saved(f.root)
  expect(result.segments.map(segment => segment.points.length)).toEqual([1, 1, 1, 1])
  expect(result.segments.every(segment => segment.points[0]!.point_id.endsWith(':01'))).toBe(true)
})
