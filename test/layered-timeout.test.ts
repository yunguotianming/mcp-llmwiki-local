import { batchModel } from './layered-fixture.js'
import { mockSupportReview } from './layered-fixture.js'
import * as filesystem from 'node:fs/promises'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { defaultProviderProfile, layeredSettings } from '../src/domain/config.js'
import { isModelTransportError, ModelCallError, ModelOutputValidationError, ModelTransportError } from '../src/llm/client.js'
import { buildLayeredLibrary, readLayeredPage } from '../src/layered/index.js'
import { extractSource, retryableExtractionGap } from '../src/layered/extraction.js'
import { pinVersion } from '../src/layered/retention.js'
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

it('传输缺口：连接、429、503、超时和上游流中断用尽重试仍发布，非法内容记永久缺口', async () => {
  const f = await layeredFixture()
  f.library.models.providerProfiles.mock = { ...defaultProviderProfile, backoffMs: 0 }
  const failures = [new Error('Connection error.'), new ModelCallError('限流', 'http', 429),
    new ModelCallError('服务暂不可用', 'http', 503), new ModelCallError('Request timed out.', 'TIMEOUT'),
    new Error('Upstream response stream was interrupted')]
  await Promise.all(Array.from({ length: 6 }, (_, index) => writeFile(path.join(f.knowledgeRoot, `${index}.md`), `第${index}篇原文证据。`)))
  const counts = new Map<string, number>()
  f.runtime.stream = async function* (options) {
    const input = JSON.parse((options.messages[0]!.content[0] as { text: string }).text) as ExtractionInput
    if (input.paragraphs) {
      counts.set(input.source_id, (counts.get(input.source_id) ?? 0) + 1)
      const failure = failures[Number(input.source_id.slice(2)) - 1]
      if (failure) throw failure
      // 模型正常结束但输出包含连接错误字样，仍是内容解析失败。
      yield { type: 'text-delta', index: 0, text: 'Connection error.' }
    } else yield { type: 'text-delta', index: 0, text: modelOutput(input) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ version: 'v000001' })
  const manifest = await snapshotManifest(f.root)
  expect(manifest.sources).toHaveLength(6)
  const results = await Promise.all(manifest.sources.map(entry => readFile(path.join(f.root, entry.extract.path), 'utf8').then(text => JSON.parse(text) as Extraction)))
  expect(results.map(result => result.gaps?.filter(gap => gap.kind === 'group').map(gap => gap.retryable)))
    .toEqual([[true], [true], [true], [true], [true], [false]])
  expect(manifest.sources.map(entry => counts.get(entry.source_id))).toEqual([
    defaultProviderProfile.retryLimit + 1, defaultProviderProfile.retryLimit + 1,
    defaultProviderProfile.retryLimit + 1, defaultProviderProfile.retryLimit + 1, defaultProviderProfile.retryLimit + 1, 1,
  ])
  expect(await readLayeredPage(f.knowledgeRoot, 'sources/S-0001.md')).toContain('可重试，下次建库自动重提')
  expect(await readLayeredPage(f.knowledgeRoot, 'sources/S-0005.md')).toContain('可重试，下次建库自动重提')
  expect(await readLayeredPage(f.knowledgeRoot, 'sources/S-0006.md')).not.toContain('可重试，下次建库自动重提')
})

it('分类回归：含 timeout 的 400 不重试或切备用，记永久缺口并计入协议失败', async () => {
  const f = await layeredFixture(), message = 'Invalid request: timeout must be a positive integer'
  f.library.models.providerProfiles.mock = { ...defaultProviderProfile, backoffMs: 0 }
  f.library.models.fallbacks = [{ provider: 'mock', model: 'backup' }]
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '请求被拒绝的原文证据。')
  const routes: string[] = []
  f.runtime.stream = async function* (options) {
    const input = JSON.parse((options.messages[0]!.content[0] as { text: string }).text) as ExtractionInput
    if (input.paragraphs) {
      routes.push(options.model)
      if (options.model === 'extractor') throw new ModelCallError(message, 'TIMEOUT', 400)
    }
    yield { type: 'text-delta', index: 0, text: modelOutput(input) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  await expect(buildLayeredLibrary(f.options)).rejects.toThrow(
    `提取调用因结构化输出协议或服务端拒绝而中止（失败 1，成功 0）。首个服务端错误：${message}`)
  expect(routes).toEqual(['extractor'])
  expect(f.client.attempts.filter(attempt => attempt.structuredSchemaKind === 'extraction'))
    .toMatchObject([{ status: 400, error: message, route: { provider: 'mock', model: 'extractor' } }])
  const pending = JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8')) as {
    manifest: { sources: { extract: { path: string } }[] }
  }
  const extraction: Extraction = JSON.parse(await readFile(path.join(f.root, pending.manifest.sources[0]!.extract.path), 'utf8'))
  expect(extraction.gaps?.filter(gap => gap.kind === 'group'))
    .toMatchObject([{ retryable: false, reasons: [{ rule: 'extract-group', actual: message }] }])
  expect(extraction.gaps?.some(retryableExtractionGap)).toBe(false)
})

async function transportGapFixture(fail: (chapters: number[]) => void) {
  const f = await layeredFixture(), requests: number[][] = []
  f.options.maxInputBytes = 6500
  await writeFile(path.join(f.knowledgeRoot, 'book.md'), '# 合成长书\n\n' + Array.from({ length: 9 }, (_, index) =>
    `## 第${index + 1}章\n\n第${index + 1}章结论成立。\n${'正文事实与条件。'.repeat(88)}\n`).join('\n'))
  f.call.mockImplementation(async (_task, _system, raw) => {
    const input = JSON.parse(raw) as ExtractionInput
    const support = mockSupportReview(input)
    if (support) return support
    if ('new_tags' in input || input.summary_id) return modelOutput(input)
    const text = (part: ExtractionInput['paragraphs'][number]) => part.text ?? input.evidence_dictionary![part.evidence_ref!]!.quote
    const parts = input.paragraphs.filter(part => !/^#{1,6}\s/.test(text(part)))
    const chapters = parts.flatMap(part => [...text(part).matchAll(/第(\d+)章结论/g)].map(match => Number(match[1])))
    requests.push(chapters); fail(chapters)
    const points = Array.from({ length: parts.length ? input.point_limit : 0 }, (_, index) => {
      const part = parts[index % parts.length]!, quote = text(part).split('\n')[0]!, line = part.locator.split('-')[0]!
      return { paragraph_id: part.paragraph_id, text: quote + index, section: '主要发现', evidence: [{ locator: `${line}-${line}`, quote }] }
    })
    return JSON.stringify({ tags: ['研究方法', '研究对象', '核心主题'], credibility: 'low', credibility_reason: '离线夹具', points, terms: [],
      summary_point_indices: points.slice(0, input.summary_point_limit ?? 8).map((_, index) => index) })
  })
  return { ...f, requests }
}

it('传输缺口：普通建库只重提传输组并重算点缺口，显式重试可恢复永久组', async () => {
  let failing = true
  const f = await transportGapFixture(chapters => {
    if (failing && chapters.includes(2)) throw new Error('Connection error.')
    if (failing && chapters.includes(3)) throw new ModelOutputValidationError(new Error('提取结构校验失败'))
  })
  await buildLayeredLibrary(f.options)
  const before = await saved(f.root), entry = (await snapshotManifest(f.root)).sources[0]!
  const oldBytes = await readFile(path.join(f.root, entry.extract.path), 'utf8'), pinned = await pinVersion(f.root)
  const chapter2 = before.chapters!.find(chapter => chapter.title === '第2章')!
  const gapInChapter = (result: Extraction) => result.gaps?.some(gap => (gap.item as { chapter_id?: string } | null)?.chapter_id === chapter2.id)
  expect(before.gaps?.filter(gap => gap.kind === 'group').map(gap => gap.retryable).sort()).toEqual([false, true])
  expect(gapInChapter(before)).toBe(true)
  // 模拟提取结束、核对检查点已写出后中断；旧核对结果不得覆盖新提取。
  const reviewPath = path.join(f.root, entry.extract.path.replace('objects/snapshots/', 'work/extractions/').replace(/-quality-[^.]+\.json$/, '-review.json'))
  await filesystem.mkdir(path.dirname(reviewPath), { recursive: true })
  await writeFile(reviewPath, oldBytes)
  try {
    failing = false; f.requests.length = 0
    await buildLayeredLibrary(f.options)
    const retried = await saved(f.root)
    expect(f.requests).toEqual([[2]])
    expect(retried.gaps?.filter(gap => gap.kind === 'group')).toMatchObject([{ retryable: false }])
    expect(gapInChapter(retried)).toBe(false)
    expect(retried.segments.flatMap(segment => segment.points).some(point => point.text.includes('第2章'))).toBe(true)
    expect(await readFile(path.join(f.root, entry.extract.path), 'utf8')).toBe(oldBytes)
    f.requests.length = 0
    expect(await buildLayeredLibrary(f.options)).toMatchObject({ unchanged: true, modelCalls: 0 })
    expect(f.requests).toEqual([])
    await writeFile(reviewPath, JSON.stringify(retried))
    await buildLayeredLibrary({ ...f.options, retryGaps: true })
    expect(f.requests).toEqual([[3]])
    expect((await saved(f.root)).gaps).toEqual([])
  } finally { pinned.release() }
})

it('传输缺口：中断检查点续跑重提传输组，永久组和成功组不重提', async () => {
  let interrupted = true
  const abort = new AbortController()
  const f = await transportGapFixture(chapters => {
    if (!interrupted) return
    if (chapters.includes(2)) throw new Error('Connection error.')
    if (chapters.includes(3)) throw new ModelOutputValidationError(new Error('提取结构校验失败'))
    if (chapters.includes(4)) { abort.abort(new Error('用户取消')); abort.signal.throwIfAborted() }
  })
  await expect(buildLayeredLibrary({ ...f.options, signal: abort.signal })).rejects.toThrow('用户取消')
  const files = await filesystem.readdir(path.join(f.root, 'work/extractions'), { recursive: true })
  const progress = JSON.parse(await readFile(path.join(f.root, 'work/extractions', files.find(file => file.endsWith('-progress.json'))!), 'utf8')) as Extraction
  expect(progress.in_progress).toBe(true)
  expect(progress.gaps?.filter(gap => gap.kind === 'group').map(gap => gap.retryable).sort()).toEqual([false, true])
  interrupted = false; f.requests.length = 0
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ version: 'v000001' })
  expect(f.requests.flat()).toContain(2)
  expect(f.requests.flat()).not.toContain(1)
  expect(f.requests.flat()).not.toContain(3)
  const result = await saved(f.root)
  expect(result.gaps?.filter(gap => gap.kind === 'group')).toMatchObject([{ retryable: false }])
  expect(result.segments.flatMap(segment => segment.points).some(point => point.text.includes('第2章'))).toBe(true)
})

it('传输缺口：未标记的旧连接、超时和上游流中断缺口自动恢复，旧版本字节不变', async () => {
  const f = await layeredFixture()
  const reasons = ['Connection error.', 'Request timed out.', 'Upstream response stream was interrupted']
  await Promise.all(reasons.map((_, index) => writeFile(path.join(f.knowledgeRoot, `${index}.md`), `第${index}篇旧库原文证据。`)))
  f.call.mockImplementation(async (_task, _system, raw) => {
    const input = JSON.parse(raw) as ExtractionInput
    if (input.paragraphs) throw new Error(reasons[Number(input.source_id.slice(2)) - 1]!)
    return modelOutput(input)
  })
  await buildLayeredLibrary(f.options)
  const entries = (await snapshotManifest(f.root)).sources
  expect(entries).toHaveLength(3)
  const legacy = await Promise.all(entries.map(async entry => {
    const file = path.join(f.root, entry.extract.path), extraction: Extraction = JSON.parse(await readFile(file, 'utf8'))
    for (const gap of extraction.gaps ?? []) {
      delete gap.retryable
      if (gap.kind === 'group') delete (gap.item as { chunk_key?: string }).chunk_key
    }
    // 仅在临时夹具中还原升级前的数据；产品读取旧库不迁移文件。
    const oldBytes = JSON.stringify(extraction)
    await writeFile(file, oldBytes)
    return { entry, file, extraction, oldBytes }
  }))
  const pinned = await pinVersion(f.root)
  try {
    expect(legacy.map(item => item.extraction.gaps?.some(retryableExtractionGap))).toEqual([true, true, true])
    f.call.mockImplementation(async (_task, _system, input) => modelOutput(JSON.parse(input)))
    f.call.mockClear()
    await buildLayeredLibrary(f.options)
    expect(f.call.mock.calls.filter(args => args[5]?.structuredSchemaKind === 'extraction')).toHaveLength(3)
    const current = await snapshotManifest(f.root)
    for (const [index, item] of legacy.entries()) {
      expect((await saved(f.root, index)).gaps).toEqual([])
      expect(await readFile(item.file, 'utf8')).toBe(item.oldBytes)
      expect(current.sources[index]!.extract.path).not.toBe(item.entry.extract.path)
    }
    expect(await buildLayeredLibrary(f.options)).toMatchObject({ unchanged: true, modelCalls: 0 })
  } finally { pinned.release() }
})

it('传输缺口：同段切片按组重试，内容诊断和显式永久标记优先', async () => {
  expect(['Connection error.', 'fetch failed', 'ECONNRESET', 'ETIMEDOUT', 'socket hang up', 'HTTP 429', 'HTTP 503', '请求超时'].every(isModelTransportError)).toBe(true)
  expect(isModelTransportError(new DOMException('请求超时', 'TimeoutError'))).toBe(true)
  expect(isModelTransportError(new SyntaxError('Connection error.'))).toBe(false)
  expect(isModelTransportError(new ModelOutputValidationError(new Error('HTTP 503')))).toBe(false)
  expect(isModelTransportError('Unexpected token C, "Connection error." is not valid JSON')).toBe(false)
  expect(isModelTransportError(new ModelCallError('请求结构错误', 'http', 400))).toBe(false)
  expect(isModelTransportError('Invalid request: timeout must be a positive integer')).toBe(false)
  expect(isModelTransportError(new ModelCallError('Request timed out.', 'TIMEOUT', 400))).toBe(false)
  expect(isModelTransportError(new ModelTransportError('Connection error.', 'TRANSPORT', 400))).toBe(false)
  expect(isModelTransportError(Object.assign(new Error('Request timed out.'), { name: 'TimeoutError', status: 408 }))).toBe(false)
  expect(isModelTransportError(new ModelCallError('Upstream response stream was interrupted', 'NETWORK_ERROR', 403))).toBe(false)
  const gap = { kind: 'group' as const, segment_hashes: ['旧段落'], item: null,
    reasons: [{ rule: 'extract-group', expected: '该组完成提取', actual: 'Connection error.' }] }
  expect(retryableExtractionGap(gap)).toBe(true)
  expect(retryableExtractionGap({ ...gap, retryable: false })).toBe(false)
  expect(retryableExtractionGap({ ...gap, kind: 'point' })).toBe(false)
  const f = await layeredFixture(), file = path.join(f.knowledgeRoot, 'a.md')
  const fragments = ['永久内容。', '传输内容。']
  await writeFile(file, fragments.join(''))
  const source = await readLocalSource(file, 'Markdown')
  expect(source.segments).toHaveLength(1)
  const segment = source.segments[0]!
  const plan = fragments.map(text => [{ paragraph_id: 0, locator: segment.locator, text_hash: segment.text_hash, text }])
  let failing = true
  f.call.mockImplementation(async (_task, _system, input) => {
    const data = JSON.parse(input) as ExtractionInput
    if (failing) {
      if (data.paragraphs[0]!.text === fragments[0]) throw new ModelOutputValidationError(new Error('校验未通过'))
      throw new Error('Connection error.')
    }
    return output(data)
  })
  const before = await extractSource(f.root, 'S-0001', source, processing, f.options, 32000, undefined, [], undefined, plan)
  expect(before.gaps?.filter(gap => gap.kind === 'group')).toHaveLength(2)
  failing = false; f.call.mockClear()
  const result = await extractSource(f.root, 'S-0001', source, processing, f.options, 32000, before, [], undefined, plan)
  expect(f.call).toHaveBeenCalledTimes(1)
  expect(JSON.parse(f.call.mock.calls[0]![2]).paragraphs[0].text).toBe(fragments[1])
  expect(result.gaps?.filter(gap => gap.kind === 'group')).toMatchObject([{ retryable: false }])
  expect(result.segments[0]!.points).toHaveLength(1)
})
