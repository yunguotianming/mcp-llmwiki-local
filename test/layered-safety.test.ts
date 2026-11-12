import { expectModelCalls, batchModel } from './layered-fixture.js'
import { pinVersion } from '../src/layered/retention.js'
import { versionFile } from './layered-fixture.js'
import { readLayeredDocument } from '../src/layered/revocations.js'
import type { Extraction } from '../src/layered/schema.js'
import * as filesystem from 'node:fs/promises'
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ModelCallError, ModelClient } from '../src/llm/client.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { compareWikiFlows } from '../src/layered/comparison.js'
import { groupingResponse } from './synthesis-fixture.js'
import { buildLayeredLibrary, readLayeredPage } from '../src/layered/index.js'
import { cleanupLayeredFixtures, layeredFixture, layeredTopicFixture, mockFixtureSync, mockSupportReview, modelOutput, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
describe('分层 Wiki 恢复与校验', () => {
  it('档位与提示词版本变化整篇重提，旧提取和旧快照不覆盖', async () => {
    const fixture = await layeredFixture()
    await writeFile(path.join(fixture.knowledgeRoot, 'source.md'), '# 文档\n\n原文证据。')
    await buildLayeredLibrary(fixture.options)
    const pinned = await pinVersion(fixture.root)
    const original = (await snapshotManifest(fixture.root)).sources[0]!, originalExtract = await readFile(path.join(fixture.root, original.extract.path), 'utf8')
    await buildLayeredLibrary({ ...fixture.options, tier: 25 })
    const second = (await snapshotManifest(fixture.root)).sources[0]!
    expect(second.extract.path).not.toBe(original.extract.path)
    expect(second.files.source).toBe(original.files.source)
    await buildLayeredLibrary({ ...fixture.options, tier: 25, promptVersion: 'extract-v2' })
    expect((await snapshotManifest(fixture.root)).sources[0]!.extract.path).not.toBe(second.extract.path)
    expect(await readFile(path.join(fixture.root, original.extract.path), 'utf8')).toBe(originalExtract)
    // 含标签归并调用：三轮各提取一次，三个去重标签仅首轮归并 1 次。
    expect(fixture.call).toHaveBeenCalledTimes(4 + 1) // 向量模式默认关闭补标，按其余文本阶段精确计数。
    expectModelCalls(fixture.call, { extraction: 3, review: 1, merge: 1 }); pinned.release()
  })
  it('提取阶段中断后复用已提取来源并保持编号，发布前不暴露页面', async () => {
    const fixture = await layeredFixture()
    await writeFile(path.join(fixture.knowledgeRoot, 'a.md'), '# 甲\n\n甲的证据。')
    await writeFile(path.join(fixture.knowledgeRoot, 'b.md'), '# 乙\n\n乙的证据。')
    fixture.call.mockImplementation((...args) => {
      const input = JSON.parse(args[2])
      if (input.source_id === 'S-0002' && input.paragraphs && !input.coverage) throw new DOMException('模拟提取中断', 'AbortError')
      return ModelClient.prototype.call.apply(fixture.client, args)
    })
    await expect(buildLayeredLibrary(fixture.options)).rejects.toThrow('模拟提取中断')
    const pending = JSON.parse(await readFile(path.join(fixture.root, 'work/pending.json'), 'utf8'))
    expect(pending.manifest.sources.map((entry: { source_id: string }) => entry.source_id)).toEqual(['S-0001'])
    await expect(readLayeredPage(fixture.knowledgeRoot)).rejects.toThrow('尚无已发布版本')
    fixture.call.mockImplementation((...args) => ModelClient.prototype.call.apply(fixture.client, args)).mockClear()
    // 含标签归并调用：补提剩余来源后，三个去重标签首次归并 1 次。
    expect(await buildLayeredLibrary(fixture.options)).toMatchObject({ modelCalls: 2 + 1, added: ['S-0001', 'S-0002'] })
    // 含标签归并调用：mock 总次数与返回计数一致。
    expect(fixture.call).toHaveBeenCalledTimes(2 + 1)
    expectModelCalls(fixture.call, { extraction: 1, review: 1, merge: 1 })
  })
  it('指针切换后摘要刷新失败可补齐，历史记录不重复追加', async () => {
    const fixture = await layeredFixture()
    await writeFile(path.join(fixture.knowledgeRoot, 'source.md'), '# 资料\n\n资料证据。')
    const rename = filesystem.rename
    const started = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
    const fault = vi.spyOn(filesystem, 'rename').mockImplementation(async (from, to) => {
      if (String(to) === path.join(fixture.root, 'library.yaml') && await stat(path.join(fixture.root, 'state/current.json')).then(() => true, () => false)) throw new Error('模拟卡片刷新失败')
      if (String(to) === path.join(fixture.root, 'logs/build.md')) { started.resolve(); await release.promise }
      return await rename(from, to)
    })
    let settled = false
    const building = buildLayeredLibrary(fixture.options).finally(() => { settled = true })
    const failed = expect(building).rejects.toThrow('模拟卡片刷新失败')
    try {
      await started.promise; await setImmediate()
      expect(settled).toBe(false)
      await expect(stat(path.join(fixture.root, 'work/pending.json'))).resolves.toBeDefined()
    } finally { release.resolve(); await failed }
    expect(await readLayeredPage(fixture.knowledgeRoot)).toContain('S-0001')
    fault.mockRestore(); const calls = fixture.call.mockClear()
    expect(await buildLayeredLibrary(fixture.options)).toMatchObject({ unchanged: true, modelCalls: 0 })
    expect(calls).not.toHaveBeenCalled()
    expect((await readFile(path.join(fixture.root, 'logs/build.md'), 'utf8')).match(/## \[/g)).toHaveLength(1)
    await expect(stat(path.join(fixture.root, 'work/pending.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('正文修改按增量发布，快照污染保持旧指针与旧页面且禁止越权路径', async () => {
    const fixture = await layeredFixture(), sourceFile = path.join(fixture.knowledgeRoot, 'a.md'), content = '# 文档\n\n原始证据。'
    await writeFile(sourceFile, content); await buildLayeredLibrary(fixture.options)
    fixture.call.mockClear(); await writeFile(sourceFile, content + '\n正文修改')
    expect(await buildLayeredLibrary(fixture.options)).toMatchObject({ modelCalls: 1 + 1, unchanged: false })
    expect(fixture.call).toHaveBeenCalledTimes(1 + 1)
    expectModelCalls(fixture.call, { extraction: 1, review: 1 })
    const pointer = await readFile(path.join(fixture.root, 'state/current.json'), 'utf8'), oldPage = await readLayeredPage(fixture.knowledgeRoot, 'sources/S-0001.md')
    expect(oldPage).toContain('正文修改')
    const entry = (await snapshotManifest(fixture.root)).sources[0]!
    await writeFile(path.join(fixture.root, entry.files.source), '损坏内容')
    await expect(buildLayeredLibrary(fixture.options)).rejects.toThrow('不可变文件校验失败')
    expect(await readFile(path.join(fixture.root, 'state/current.json'), 'utf8')).toBe(pointer)
    expect(await readLayeredPage(fixture.knowledgeRoot, 'sources/S-0001.md')).toBe(await versionFile(fixture.root, 'v000001', 'sources/S-0001.md'))
    expect((await readLayeredDocument(fixture.knowledgeRoot, 'S-0001')).warning).toContain('更新未完整')
    await expect(readLayeredPage(fixture.knowledgeRoot, '.publish/v000001/sources/S-0001.md')).rejects.toThrow('只能读取当前版本')
  })
  it('超长单段遵守上下文和整篇配额，虚假证据拒绝写入提取真值', async () => {
    const fixture = await layeredFixture()
    await writeFile(path.join(fixture.knowledgeRoot, 'long.md'), '# 超长段\n\n' + '连续中文证据'.repeat(160))
    const result = await buildLayeredLibrary({ ...fixture.options, tier: 5, maxInputBytes: 3000 })
    expect(result.modelCalls).toBeGreaterThan(1)
    expect(fixture.requests.reduce((total, request) => total + request.input.point_limit, 0)).toBe(5)
    for (const request of fixture.requests) expect(Buffer.byteLength(request.system + JSON.stringify(request.input))).toBeLessThanOrEqual(3000)
    const invalid = await layeredFixture()
    await writeFile(path.join(invalid.knowledgeRoot, 'source.md'), '# 原文\n\n真实证据。')
    invalid.call.mockImplementation(batchModel(async (_task, _system, input) => JSON.stringify(JSON.parse(input).new_tags ? { groups: [] } : { tags: ['研究方法', '研究对象', '核心主题'], credibility: 'high', credibility_reason: '无依据的判断', points: [{ paragraph_id: 1, text: '虚假主张', section: '主要发现', evidence: [{ locator: 'L3-L3', quote: '原文不存在的引文' }] }], terms: [] })))
    expect(await buildLayeredLibrary(invalid.options)).toMatchObject({ version: 'v000001' })
    expect(await readLayeredPage(invalid.knowledgeRoot, 'sources/S-0001.md')).toContain('提取缺口')
  })
})
it('同一资料 mock 跑真实新旧入口生成成本对照，保留原有 Wiki', async () => {
  const f = await layeredFixture()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '青松流程需要先确认输入。')
  await mkdir(f.root, { recursive: true }); await writeFile(path.join(f.root, 'precious.md'), '现有成果不得修改')
  // 初始化发生在 createClient 之前，提前登记对照临时目录，避免真实刷盘挤占线程池。
  const mkdtemp = filesystem.mkdtemp
  vi.spyOn(filesystem, 'mkdtemp').mockImplementation(async (...args) => {
    const directory = await mkdtemp(...args)
    if (String(args[0]).includes('dsh-wiki-comparison-')) mockFixtureSync(directory)
    return directory
  })
  const calls: string[] = []
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('测试禁止联网'))
  const runtime: ModelRuntime = {
    async resolveModelInfo(provider, id) { return { provider, id, name: id } },
    async *stream(options) {
      const data = JSON.parse((options.messages[0]!.content[0] as { text: string }).text)
      const support = mockSupportReview(data)
      if (support) { yield { type: 'text-delta', index: 0, text: support }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
      let output: unknown
      if (mockSupportReview(data)) output = JSON.parse(mockSupportReview(data)!)
      else if (data.new_tags) output = { groups: [] }
      else if (data.paragraphs) { calls.push('新提取'); output = JSON.parse(modelOutput(data)) }
      else if (data.topic_id) {
        calls.push('新主题')
        output = { aliases: ['综合主题'], title: '青松流程', summary: '输入确认', consensus: [], differences: [], conditions: [{ text: '先确认输入。', point_ids: [data.points[0].point_id] }] }
      } else if (data.claims) { calls.push('旧冲突'); output = { conflicts: [] } }
      else if (data.candidates) {
        calls.push('旧综合')
        output = JSON.parse(groupingResponse(options.system ?? '', [{ type: 'concept', title: '青松流程', identity: '青松流程', aliases: [], tags: [], members: data.candidates.map((candidate: { id: string }) => candidate.id), conflicts: [] }]))
      } else {
        calls.push('旧提取')
        output = { candidates: [{ type: 'concept', title: '青松流程', identity: '青松流程', aliases: [], tags: [], mentionOnly: false, claims: [{ text: data.text, quote: data.text }] }], images: [] }
      }
      yield { type: 'text-delta', index: 0, text: JSON.stringify(output) }
      yield { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 2, outputTokens: 5 } }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  }
  const createClient = vi.fn((runtime, library, policy) => {
    mockFixtureSync(path.dirname(library.wikiPath))
    return new ModelClient(runtime, { ...library, models: { ...library.models, layeredRoutes: {} } }, policy)
  })
  const result = await compareWikiFlows({ knowledgeRoot: f.knowledgeRoot, runtime, createClient, model: { provider: 'mock', model: 'both' }, policy: { batchDelayMs: 0, contextWindowTokens: 64000 },
    layered: { topics: { topicMergeMinSources: 1 }, maxInputBytes: 32768, embeddingClient: { identity: async () => 'fixture-weights-v1', embed: vi.fn(async texts => texts.map(() => [1, 0])) } } })
  try {
    const report = await readFile(result.reportPath, 'utf8')
    expect(report).toContain('旧流程'); expect(report).toContain('分层流程'); expect(report).toContain('逻辑任务数'); expect(report).toContain('mock/both')
    expect(report).toContain('"maxInputBytes":32768')
    expect(calls).toContain('旧提取'); expect(calls).toContain('新提取'); expect(calls).toContain('新主题')
    expect(createClient).toHaveBeenCalledTimes(2)
    expect(result.legacy.stages['提取']!.actual_calls).toBeGreaterThan(0)
    expect(result.layered.stages['提取']).toMatchObject({ logical_tasks: 1, actual_calls: 1, input_tokens: 10, cache_tokens: 2, output_tokens: 5 })
    expect(await readFile(path.join(f.root, 'precious.md'), 'utf8')).toBe('现有成果不得修改')
    expect(await readFile(path.join(f.knowledgeRoot, 'a.md'), 'utf8')).toBe('青松流程需要先确认输入。')
    expect(await readFile(path.join(result.directory, 'legacy/index.md'), 'utf8')).toContain('青松流程')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  } finally { await rm(result.directory, { recursive: true, force: true }) }
})

async function extraction(root: string, index = 0): Promise<Extraction> {
  const entry = (await snapshotManifest(root)).sources[index]!
  return JSON.parse(await readFile(path.join(root, entry.extract.path), 'utf8'))
}
function captureFailures(root: string) {
  const records: any[] = [], remove = filesystem.rm
  vi.spyOn(filesystem, 'rm').mockImplementation(async (file, options) => {
    if (String(file) === path.join(root, 'logs/failures')) {
      expect(await readFile(path.join(root, 'logs/costs.json'), 'utf8')).toContain('actual_calls')
      const files = await readdir(file, { recursive: true }).catch(() => [])
      for (const name of files.filter(name => name.endsWith('.json'))) records.push(JSON.parse(await readFile(path.join(String(file), name), 'utf8')))
    }
    return remove(file, options)
  })
  return records
}

it('单个要点纠正一次通过，留存完整拒绝输出至成本汇总并复用检查点', async () => {
  const f = await layeredFixture(), records = captureFailures(f.root)
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '真实证据。')
  let raw = '', corrections = 0
  f.call.mockImplementation(batchModel(async (_task, _system, input) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(input))
    if (support) return support
    const data = JSON.parse(input)
    if (data.new_tags) return JSON.stringify({ groups: [] })
    if (data.validationFeedback) {
      corrections++
      expect(data.validationFeedback.reasons).toEqual([{ rule: 'verbatim-quote', expected: expect.any(String), actual: '错误引文' }])
      return JSON.stringify({ ...data.validationFeedback.item, evidence: [{ locator: 'L1-L1', quote: '真实证据。' }] })
    }
    const output = JSON.parse(modelOutput(data)); output.points[0].evidence[0].quote = '错误引文'
    raw = JSON.stringify(output); return raw
  }))
  const result = await buildLayeredLibrary(f.options), saved = await extraction(f.root)
  // 含标签归并调用：一次提取、一次纠正后，三个去重标签归并 1 次。
  expect(result).toMatchObject({ version: 'v000001', modelCalls: 3 + 1 }); expect(corrections).toBe(1) // 向量模式默认关闭补标，按其余文本阶段精确计数。
  expectModelCalls(f.call, { extraction: 1, correction: 1, review: 1, merge: 1 })
  expect(saved.segments.flatMap(segment => segment.points)).toHaveLength(4); expect(saved.gaps).toEqual([])
  expect(records).toHaveLength(1); expect(records[0].raw_output).toBe(raw)
  expect(records[0].request).toEqual({ hash: expect.stringMatching(/^sha256:/), length: expect.any(Number) })
  expect(records[0].rejections[0].reasons[0].rule).toBe('verbatim-quote')
  expect((await readdir(f.knowledgeRoot)).sort()).toEqual(['.llmwiki', 'a.md'])
  await expect(stat(path.join(f.root, 'logs/failures'))).rejects.toMatchObject({ code: 'ENOENT' })
  const costs = JSON.parse(await readFile(path.join(f.root, 'logs/costs.json'), 'utf8'))
  expect(costs[result.version].stages['提取'].actual_calls).toBe(2)
  f.call.mockClear(); expect(await buildLayeredLibrary(f.options)).toMatchObject({ unchanged: true }); expect(f.call).not.toHaveBeenCalled()
})

it('要点与术语纠正仍失败时只丢弃该条，其他段落来源发布且缺口按指纹复用', async () => {
  const f = await layeredTopicFixture(), original = f.call.getMockImplementation()!, records = captureFailures(f.root)
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组真实证据。\n\n甲组其他段落。')
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '甲组第二来源。')
  f.call.mockImplementation(batchModel(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
    const data = JSON.parse(args[2])
    if (data.validationFeedback) return JSON.stringify(data.validationFeedback.item)
    const raw = await original(...args)
    if (data.topic_id || data.source_id !== 'S-0001') return raw
    const output = JSON.parse(raw); output.points[0].evidence[0].quote = '不存在的证据'
    output.points[1].paragraph_id = 1; output.points[1].evidence = [{ locator: 'L3-L3', quote: '甲组其他段落。' }]
    output.terms = [{ paragraph_id: 0, name: '错误术语', category: '概念', aliases: [], locator: 'L99-L99', note: '待纠正' }]
    return JSON.stringify(output)
  }))
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ version: 'v000001' })
  const saved = await extraction(f.root)
  expect(saved.gaps?.map(gap => gap.kind)).toEqual(['point', 'term'])
  expect(saved.segments.map(segment => segment.points.length)).toEqual([2, 1])
  expect((await extraction(f.root, 1)).segments.flatMap(segment => segment.points)).toHaveLength(4)
  expect(records).toHaveLength(2) // 两项合批：首提拒绝与批纠正拒绝各一份，保留全部条目理由。
  expect(records.map(record => record.rejections.length)).toEqual([2, 2])
  expect(await readFile(path.join(f.root, 'logs/build.md'), 'utf8')).toContain('提取缺口 S-0001')
  const topics = JSON.parse(await readFile(path.join(f.root, 'state/topics.json'), 'utf8'))
  expect(topics.topics[0].sources).toEqual(['S-0001', 'S-0002'])
  f.call.mockClear(); expect(await buildLayeredLibrary(f.options)).toMatchObject({ unchanged: true }); expect(f.call).not.toHaveBeenCalled()
  expect((await extraction(f.root)).gaps).toEqual(saved.gaps)
})

it('整篇要点均拒绝仍发布带缺口的来源页，不进入主题或嵌入', async () => {
  const f = await layeredTopicFixture()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组真实证据。')
  f.call.mockImplementation(batchModel(async (_task, _system, input) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(input))
    if (support) return support
    const data = JSON.parse(input)
    if (data.new_tags) return JSON.stringify({ groups: [] })
    if (data.validationFeedback) return JSON.stringify(data.validationFeedback.item)
    const output = JSON.parse(modelOutput(data)); output.points = output.points.slice(0, 1); output.terms = []
    output.points[0].paragraph_id = 99; return JSON.stringify(output)
  }))
  // 含标签归并调用：要点被拒绝仍保留三个标签，提取与纠正后归并 1 次。
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ version: 'v000001', modelCalls: 3 })
  expect(await readLayeredPage(f.knowledgeRoot, 'sources/S-0001.md')).toContain('提取缺口')
  expect((await extraction(f.root)).segments.flatMap(segment => segment.points)).toEqual([])
  expect(JSON.parse(await readFile(path.join(f.root, 'state/topics.json'), 'utf8')).topics).toEqual([])
  // 含标签归并调用：mock 总次数增加 1，嵌入仍为零调用。
  expect(f.embed).not.toHaveBeenCalled(); expect(f.call).toHaveBeenCalledTimes(3)
})

it('模型调用失败保留完整原输出、请求摘要与原因，发布缺口且成本已记账', async () => {
  const f = await layeredFixture(), raw = '不完整模型输出'.repeat(800), records = captureFailures(f.root)
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '真实证据。')
  f.call.mockRejectedValue(new ModelCallError('连接失败', 'codex-cli', undefined, { rawOutput: raw }))
  const built = await buildLayeredLibrary(f.options)
  const record = records[0]
  expect(record.raw_output).toBe(raw); expect(record.rejections[0]).toMatchObject({ rule: 'model-call', actual: '连接失败' })
  expect(record.request.length).toBeGreaterThan(0)
  expect(JSON.parse(await readFile(path.join(f.root, 'logs/costs.json'), 'utf8'))[built.version].stages['提取'].actual_calls).toBe(1)
  expect(await readLayeredPage(f.knowledgeRoot, 'sources/S-0001.md')).toContain('连接失败')
  expect((await readdir(f.knowledgeRoot)).sort()).toEqual(['.llmwiki', 'a.md'])
})

it('codex-cli 自动且无窗口时提示上下文上限，选择档位后显式输入预算取小', async () => {
  const f = await layeredFixture()
  f.runtime.resolveModelInfo = async () => ({ provider: 'codex-cli', id: 'gpt-6.1-terra', name: '测试模型' })
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '真实证据。')
  await expect(buildLayeredLibrary(f.options)).rejects.toThrow('上下文上限')
  expect(f.call).not.toHaveBeenCalled()
  f.policy.contextWindowTokens = 64000
  expect(await buildLayeredLibrary({ ...f.options, maxInputBytes: 8000 })).toMatchObject({ version: 'v000001' })
  expect((await extraction(f.root)).calls[0]!.input_limit).toBe(8000)
})
