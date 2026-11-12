import { expectModelCalls } from './layered-fixture.js'
import { mockSupportReview } from './layered-fixture.js'
import { versionFile } from './layered-fixture.js'
import * as filesystem from 'node:fs/promises'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary, layeredInputBudget } from '../src/layered/index.js'
import { allocatePointQuotas } from '../src/layered/budget.js'
import { planExtraction } from '../src/layered/extraction.js'
import { readLocalSource } from '../src/layered/snapshot.js'
import type { Extraction } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, layeredFixture, modelOutput, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => { vi.useRealTimers(); cleanupLayeredFixtures() })
const epoch = new Date('2026-11-08T00:00:00Z')
// 文件 IO 使用真实事件循环，只有模型等待和闸门计时由虚拟时钟推进。
async function drive<T>(work: Promise<T>, step = 10): Promise<T> {
  let done = false
  const outcome = work.then(value => ({ value }), error => ({ error })).finally(() => { done = true })
  while (!done) { await setImmediate(); await vi.advanceTimersByTimeAsync(step) }
  const result = await outcome
  if ('error' in result) throw result.error
  return result.value
}
async function extract(f: Awaited<ReturnType<typeof layeredFixture>>, index = 0): Promise<Extraction> {
  const entry = (await snapshotManifest(f.root)).sources[index]!
  return JSON.parse(await readFile(path.join(f.root, entry.extract.path), 'utf8'))
}
function delayed(f: Awaited<ReturnType<typeof layeredFixture>>, delay: (id: string) => number, ready: (id: string, input: { paragraphs: { paragraph_id: number }[] }) => Promise<void> = async () => {}) {
  let active = 0, peak = 0
  const completed: string[] = [], reviews: string[] = []
  f.runtime.stream = async function* (options) {
    const input = JSON.parse((options.messages[0]!.content[0] as { text: string }).text)
      const support = mockSupportReview(input)
      if (support) { if (input.review_stage) reviews.push(input.source_id); yield { type: 'text-delta', index: 0, text: support }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
      if (input.new_tags) { yield { type: 'text-delta', index: 0, text: JSON.stringify({ groups: [] }) }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
    if (input.summary_id) {
      yield { type: 'text-delta', index: 0, text: modelOutput(input) }; yield { type: 'finish', reason: { kind: 'stop' } }; return
    }
    active++; peak = Math.max(peak, active)
    try {
      await ready(input.source_id, input)
      await new Promise(resolve => setTimeout(resolve, delay(input.source_id)))
      options.signal?.throwIfAborted()
      const output = JSON.parse(modelOutput(input)); output.points = output.points.slice(0, 1); output.terms = []
      yield { type: 'text-delta', index: 0, text: JSON.stringify(output) }
      yield { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 5, outputTokens: 2 } }
      completed.push(input.source_id)
      yield { type: 'finish', reason: { kind: 'stop' } }
    } finally { await new Promise(resolve => setTimeout(resolve, 10)); active-- }
  }
  return { completed, reviews, get active() { return active }, get peak() { return peak } }
}

it('20 来源经供应商闸门并发 8，成果逐字节等于串行且成本无重计', async () => {
  const fixtures = [await layeredFixture(), await layeredFixture()]
  for (const f of fixtures) await Promise.all(Array.from({ length: 20 }, (_, index) => writeFile(path.join(f.knowledgeRoot, `${String(index).padStart(2, '0')}.md`), `---\ndate: 2026-11-08\n---\n\n来源 ${index} 的证据。`)))
  const bytes: string[][] = []
  const publishedAt: string[] = []
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  for (const [index, f] of fixtures.entries()) {
    vi.setSystemTime(epoch)
    f.policy.pageGenerationConcurrency = index ? 1 : 12
    f.library.models.providerProfiles.mock = { concurrency: 8, retryLimit: 0, backoffMs: 0, cacheMode: 'automatic-prefix' }
    let arrivals = 0
    const firstWave = Promise.withResolvers<void>()
    const state = delayed(f, id => (21 - Number(id.slice(2))) * 10, async () => { if (++arrivals >= (index ? 1 : 8)) firstWave.resolve(); await firstWave.promise })
    const built = await drive(buildLayeredLibrary(f.options))
    expect(state.peak).toBe(index ? 1 : 8); expect(state.active).toBe(0)
    // 章节已达底线不再补提，恢复原有的 20 次提取、20 次核对与一次标签归并。
    expect(built.modelCalls).toBe(21 + 20) // 向量模式默认关闭补标，按其余文本阶段精确计数。
    expectModelCalls(f.call, { extraction: 20, review: 20, merge: 1 })
    const manifest = await snapshotManifest(f.root)
    publishedAt.push(manifest.card!.updated_at)
    for (const entry of manifest.sources) expect(entry.created_at).toBe(manifest.card!.updated_at)
    bytes.push(await Promise.all(manifest.sources.flatMap(entry => [readFile(path.join(f.root, entry.extract.path), 'utf8'), versionFile(f.root, built.version, `sources/${entry.source_id}.md`)])))
    const costs = JSON.parse(await readFile(path.join(f.root, 'logs/costs.json'), 'utf8'))[built.version].stages['提取']
    expect(costs).toMatchObject({ logical_tasks: 20, actual_calls: 20, input_tokens: 200, cache_tokens: 100, output_tokens: 40 })
  }
  // 首次发布时间随调度完成时间变化；只对齐新增 created 字段，其余字节继续严格比较。
  expect(bytes[0]).toEqual(bytes[1]!.map(value => value.replace(/^created: .*$/m, 'created: ' + publishedAt[0])))
})

it('同篇跨组并发，取消等待在途退出后保存，续跑复用成功来源与配额', async () => {
  const f = await layeredFixture(), abort = new AbortController()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '第一篇证据。')
  // 闸门会保留槽位的可用时间；首次建库就统一时钟，避免切换后时间倒退锁住槽位。
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(epoch)
  await drive(buildLayeredLibrary(f.options)); f.client.attempts.length = 0
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), Array.from({ length: 12 }, (_, i) => `${i}：${'长文证据。'.repeat(80)}`).join('\n\n'))
  f.policy.pageGenerationConcurrency = 8; f.options.maxInputBytes = 7000
  f.library.models.providerProfiles.mock = { concurrency: 4, retryLimit: 0, backoffMs: 0, cacheMode: 'automatic-prefix' }
  const release = Promise.withResolvers<void>()
  const state = delayed(f, () => 10, async (_id, input) => { if (input.paragraphs[0]!.paragraph_id !== 0) await release.promise })
  let savedChunk = false
  const rename = filesystem.rename
  vi.spyOn(filesystem, 'rename').mockImplementation(async (from, to) => {
    const saved = String(to).includes(path.sep + 'extract' + path.sep) && Boolean(JSON.parse(await readFile(from, 'utf8')).completed_chunks?.length)
    await rename(from, to); savedChunk ||= saved
  })
  const building = buildLayeredLibrary({ ...f.options, signal: abort.signal })
  let failure: unknown
  const observed = building.catch(error => { failure = error; return error })
  try {
    while (!savedChunk || state.peak < 4) { if (failure) throw failure; await setImmediate(); await vi.advanceTimersByTimeAsync(10) }
    abort.abort(new Error('测试取消')); release.resolve()
    expect(state.active).toBeGreaterThan(0)
    expect((await drive(observed, 1000)).message).toBe('测试取消'); expect(state.active).toBe(0)
  } finally { abort.abort(); release.resolve(); await drive(observed, 1000) }
  const pending = JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8'))
  expect(pending.manifest.sources.map((entry: { source_id: string }) => entry.source_id)).toContain('S-0001')
  const finished = state.completed.length
  const resumed = await drive(buildLayeredLibrary(f.options), 1000)
  const saved = await extract(f, 1)
  expect(state.completed).not.toContain('S-0001')
  expect(state.reviews.filter(id => id === 'S-0002')).toHaveLength(1)
  expect(state.completed.length - finished).toBe(saved.calls.length - (saved.summary_calls?.length ?? 0) - 1 - 1) // 标签协议允许不足三个后示例缩短，全部要点在同一核对批内；仍扣除已完成的一组提取。
  expect(saved.segments.flatMap(segment => segment.points).length).toBeLessThanOrEqual(50)
  const costs = JSON.parse(await readFile(path.join(f.root, 'logs/costs.json'), 'utf8'))[resumed.version].stages
  expect(costs['提取'].actual_calls + costs['提取后核对'].actual_calls).toBe(f.client.attempts.length) // 向量模式默认关闭补标，按其余文本阶段精确计数。
  expect(costs['要点补标']).toBeUndefined() // 默认关闭补标，成本表中也不应出现该阶段。
  expect(costs['提取'].actual_calls).toBe(f.client.attempts.filter(call => call.structuredSchemaKind === 'extraction').length)
  expect(costs['提取后核对'].actual_calls).toBe(1)
  expect(costs['来源摘要']).toBeUndefined()
})

it('上下文按策略与模型取小：64K 分组跨 256K 沿用且零调用', async () => {
  const f = await layeredFixture()
  f.runtime.resolveModelInfo = async (provider, id) => ({ provider, id, name: id, context: { contextWindow: 512000 } })
  await writeFile(path.join(f.knowledgeRoot, 'large.md'), Array.from({ length: 10 }, (_, i) => `${i}：${'中文正文'.repeat(600)}`).join('\n\n'))
  f.runtime.stream = async function* (options) {
    const input = JSON.parse((options.messages[0]!.content[0] as { text: string }).text); f.requests.push({ system: options.system!, input })
      const support = mockSupportReview(input)
      if (support) { yield { type: 'text-delta', index: 0, text: support }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
      if (input.new_tags) { yield { type: 'text-delta', index: 0, text: JSON.stringify({ groups: [] }) }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
    yield { type: 'text-delta', index: 0, text: JSON.stringify({ tags: ['研究方法', '研究对象', '核心主题'], credibility: 'low', credibility_reason: '测试', points: [], terms: [] }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  f.policy.contextWindowTokens = 64000
  expect((await buildLayeredLibrary(f.options)).modelCalls).toBeGreaterThan(1)
  const first = await extract(f)
  expect(first.calls.every(call => call.input_bytes <= 64000 - 128)).toBe(true)
  f.policy.contextWindowTokens = 256000; f.requests.length = 0
  // 换窗口沿用能装入新预算的旧分组，不因窗口增大重提。
  expect((await buildLayeredLibrary(f.options)).modelCalls).toBe(0)
  const second = await extract(f); expect(second.grouping_fingerprint).toBe(first.grouping_fingerprint)
  expect(second.chunk_plan).toEqual(first.chunk_plan)
  f.policy.contextWindowTokens = 512000
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ unchanged: true, modelCalls: 0 })
  expect(await layeredInputBudget({ ...f.options, maxInputBytes: 9000 })).toBe(9000)
  f.policy.contextWindowTokens = 64000
  expect(await layeredInputBudget({ ...f.options, maxInputBytes: 999999 })).toBe(63872)
  f.policy.contextWindowTokens = 0
  f.runtime.resolveModelInfo = async (provider, id) => ({ provider, id, name: id })
  await expect(layeredInputBudget({ ...f.options, maxInputBytes: 9000 })).rejects.toThrow('上下文上限')
})

it('章节优先分组，图片编码剔除且参考文献致谢及逐行定位保留', async () => {
  const f = await layeredFixture(), file = path.join(f.knowledgeRoot, 'paper.md')
  const text = '# 论文\n\n![示意图](data:image/png;base64,' + 'a'.repeat(169700) + ')\n\n' + Array.from({ length: 8 }, (_, i) => `### 小标题 ${i}\n\n图 ${i} 标题\n\n${i}：${'正文证据。'.repeat(100)}\n`).join('\n') + '\n## 参考文献\n\n[1] 文献完整条目\n\n## 致谢\n\n感谢参与者。'
  await writeFile(file, text)
  f.options.maxInputBytes = 12000
  await buildLayeredLibrary(f.options)
  const source = await readLocalSource(file, 'Markdown'), plan = planExtraction('S-0001', source, { tier: 50, prompt_version: 'layered-extract-v1', model: 'mock/extractor' }, 12000)
  expect(plan.length).toBe(3)
  for (const call of (await extract(f)).calls) expect(call.input_bytes).toBeLessThanOrEqual(12000)
  const inputs = f.requests.map(request => JSON.stringify(request.input)).join('\n')
  expect(inputs).not.toContain('data:image'); expect(inputs).not.toContain('a'.repeat(200))
  expect(inputs).toContain('[图片：'); expect(inputs).toContain('文献完整条目'); expect(inputs).toContain('感谢参与者')
  // 合章只改变请求外壳；展开每章后继续逐段校验原文、行号与定位。
  for (const request of f.requests.flatMap(({ input }) => 'chapters' in input ? input.chapters as typeof input[] : [input])) for (const part of request.paragraphs as { text?: string; evidence_ref?: string; line_numbers: number[]; locator: string; paragraph_id: number }[]) {
    const start = Number(/^L(\d+)/.exec(part.locator)![1])
    const text = part.text ?? request.evidence_dictionary![part.evidence_ref!]!.quote
    expect(part.line_numbers).toEqual(text.split('\n').map((_, i) => start + i))
    expect(part).not.toHaveProperty('lines')
    expect(part.locator).toBe(source.segments[part.paragraph_id]!.locator)
  }
  expect(await readFile(path.join(f.root, (await snapshotManifest(f.root)).sources[0]!.files.source), 'utf8')).toBe(text)
  await writeFile(file, '# 第一章\n\n' + '甲'.repeat(1000) + '\n\n# 第二章\n\n' + Array.from({ length: 12 }, (_, i) => `${i}${'乙'.repeat(500)}`).join('\n\n'))
  const chapter = await readLocalSource(file, 'Markdown'), groups = planExtraction('S-0001', chapter, { tier: 50, prompt_version: 'v1', model: 'mock/extractor' }, 12000)
  expect(groups[0]!.slice(0, 2).map(part => part.paragraph_id)).toEqual([0, 1])
  expect(groups.flat().map(part => part.paragraph_id)).toEqual(chapter.segments.map((_, i) => i))
})

it('配额按长度分配，低档优先最长组，超出截断留痕并继续建库', async () => {
  expect(allocatePointQuotas([100, 300, 600], 10)).toEqual([2, 3, 5])
  expect(allocatePointQuotas([10, 90, 20, 80], 2)).toEqual([0, 1, 0, 1])
  const f = await layeredFixture(), failures: { details?: { truncated_points?: number } }[] = [], remove = filesystem.rm
  vi.spyOn(filesystem, 'rm').mockImplementation(async (file, options) => {
    if (String(file) === path.join(f.root, 'logs/failures')) {
      for (const relative of await filesystem.readdir(file, { recursive: true })) if (relative.endsWith('.json')) failures.push(JSON.parse(await readFile(path.join(String(file), relative), 'utf8')))
    }
    return remove(file, options)
  })
  f.options.tier = 5; f.options.maxInputBytes = 5000
  await writeFile(path.join(f.knowledgeRoot, 'quota.md'), Array.from({ length: 10 }, (_, i) => `${i}：${'证据'.repeat(100 + i * 15)}`).join('\n\n'))
  f.runtime.stream = async function* (options) {
    const input = JSON.parse((options.messages[0]!.content[0] as { text: string }).text)
      const support = mockSupportReview(input)
      if (support) { yield { type: 'text-delta', index: 0, text: support }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
      if (input.new_tags) { yield { type: 'text-delta', index: 0, text: JSON.stringify({ groups: [] }) }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
    if (input.summary_id) { yield { type: 'text-delta', index: 0, text: modelOutput(input) }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
    f.requests.push({ system: options.system!, input })
    yield { type: 'text-delta', index: 0, text: modelOutput({ ...input, point_limit: 4 }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  await buildLayeredLibrary(f.options)
  const quotas = f.requests.map(request => request.input.point_limit)
  expect(quotas.reduce((sum, value) => sum + value, 0)).toBe(5); expect(quotas).toContain(0)
  const lengths = f.requests.map(request => request.input.paragraphs.reduce((sum, part) => sum + Buffer.byteLength(part.text), 0))
  expect(quotas).toEqual(allocatePointQuotas(lengths, 5))
  const saved = await extract(f)
  expect(saved.segments.flatMap(segment => segment.points)).toHaveLength(5)
  const count = saved.truncations!.reduce((sum, item) => sum + item.count, 0)
  expect(count).toBe(f.requests.length * 4 - 5)
  expect(failures.reduce((sum, item) => sum + (item.details?.truncated_points ?? 0), 0)).toBe(count)
  expect(await readFile(path.join(f.root, 'logs/build.md'), 'utf8')).toContain(`截断条数：${count}`)
})

it('叶主题、父页和术语页经共享闸门并行，父页等待自己的子页完成', async () => {
  const f = await layeredFixture()
  await Promise.all(Array.from({ length: 4 }, (_, i) => writeFile(path.join(f.knowledgeRoot, `${i}.md`), `${i < 2 ? '甲' : '乙'}组证据${i}。`)))
  f.policy.pageGenerationConcurrency = 4
  f.library.models.providerProfiles.mock = { concurrency: 4, retryLimit: 0, backoffMs: 0, cacheMode: 'automatic-prefix' }
  f.options.topics = { topicMergeMinSources: 1, topicMaxSources: 1, topicMaxDepth: 1, termThreshold50: 2 }
  f.options.embeddingClient = { identity: async () => 'fixture-weights-v1', embed: async texts => texts.map(text => text.includes('甲') ? [1, 0] : [0, 1]) }
  const active = { extract: 0, topic: 0, parent: 0, term: 0 }, peak = { ...active }, extractionReady = Promise.withResolvers<void>()
  const completedTopics = new Set<string>()
  f.runtime.stream = async function* (options) {
    const input = JSON.parse((options.messages[0]!.content[0] as { text: string }).text)
      const support = mockSupportReview(input)
      if (support) { yield { type: 'text-delta', index: 0, text: support }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
      if (input.new_tags) { yield { type: 'text-delta', index: 0, text: JSON.stringify({ groups: [] }) }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
    const kind = input.source_id ? 'extract' : input.term_id ? 'term' : input.children ? 'parent' : 'topic'
    active[kind]++; peak[kind] = Math.max(peak[kind], active[kind])
    try {
      if (kind === 'extract') { if (active.extract === 4) extractionReady.resolve(); await extractionReady.promise }
      // 依赖队列允许无关叶页仍在运行；每个实际引用的子页必须已经完成。
      if (kind === 'parent') expect(input.children.map((child: { id: string }) => completedTopics.has(child.id))).toEqual(input.children.map(() => true))
      if (kind === 'term') expect(active.parent + active.topic).toBe(0)
      await new Promise(resolve => setTimeout(resolve, 100))
      let output: unknown
      if (kind === 'extract') {
        const value = JSON.parse(modelOutput(input)), group = input.paragraphs[0].text.includes('甲') ? '甲' : '乙'
        value.points = value.points.slice(0, 1); value.terms[0].name = `${group}术语`; value.terms[0].aliases = []
        output = value
      } else if (kind === 'term') output = { definition: [{ text: '术语定义。', keys: [input.contributions[0].key] }], usage: [], findings: [], differences: [] }
      else output = { aliases: ['综合主题'], title: '主题', summary: '范围', consensus: [], differences: [], conditions: [{ text: '有据结论。', ...(kind === 'parent' ? { child_ids: [input.children[0].id] } : { point_ids: [input.points[0].point_id] }) }] }
      yield { type: 'text-delta', index: 0, text: JSON.stringify(output) }; yield { type: 'finish', reason: { kind: 'stop' } }
    } finally { active[kind]--; if (kind === 'topic') completedTopics.add(input.topic_id) }
  }
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] }); vi.setSystemTime(epoch)
  await drive(buildLayeredLibrary(f.options))
  expect(peak).toEqual({ extract: 4, topic: 4, parent: 2, term: 2 })
  expect(Object.values(active)).toEqual([0, 0, 0, 0])
})
