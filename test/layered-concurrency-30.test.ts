import { z } from 'zod'
import { schemaExample } from '../src/llm/protocol.js'
import { fork } from 'node:child_process'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { setImmediate } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { ModelClient, ModelCallError } from '../src/llm/client.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { newLibrary } from '../src/domain/config.js'
import { defaultPolicy, validatePolicy } from '../src/domain/policy.js'
import { policySchema } from '../src/domain/policy-schema.js'
import { extractSource } from '../src/layered/extraction.js'
import { readLocalSource } from '../src/layered/snapshot.js'
import { withBuildLock, writeJson } from '../src/layered/files.js'
import { buildLayeredLibrary } from '../src/layered/index.js'
import * as retention from '../src/layered/retention.js'
import { versionPage } from '../src/layered/objects.js'
import { cleanupLayeredFixtures, layeredFixture, modelOutput, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
// 本组验证并发产物和进程写锁；设备登记由设备专项覆盖，避免负载下启动 reg.exe 与重复登记 IO。
// withBuildLock 仍走真实跨进程锁，20 篇、纠正次数和逐字节断言均保持。
vi.mock('../src/layered/devices.js', async original => ({ ...await original<typeof import('../src/layered/devices.js')>(),
  checkWriter: async () => {}, claimWriter: async () => {} }))
// 本文件比较知识产物与真实并发闸门；成本不在比较对象内，其持久化由成本专项覆盖。
vi.mock('../src/layered/costs.js', async original => ({ ...await original<typeof import('../src/layered/costs.js')>(),
  meteredOptions: (_root: string, _pending: unknown, options: unknown) => options }))
afterEach(() => { vi.useRealTimers(); cleanupLayeredFixtures() })
const processing = { tier: 50, prompt_version: '并发回归', model: 'mock/extractor' }

it('30路状态与检查点原子写入不丢更新，独立进程写者被拒', async () => {
  const f = await layeredFixture(), state: { values: number[] } = { values: [] }
  const cache = path.join(f.knowledgeRoot, 'compile'); await fs.mkdir(cache)
  const child = fork(fileURLToPath(new URL('./layered-storage-audit-worker.mjs', import.meta.url)), [cache], { execArgv: [], windowsHide: true, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
  const ready = new Promise<void>((resolve, reject) => { child.once('error', reject); child.once('message', () => resolve()) })
  try {
    await ready
    await withBuildLock(f.knowledgeRoot, async () => {
      const denied = new Promise<any>(resolve => child.once('message', resolve)); child.send({ id: 1, action: 'lock', root: f.knowledgeRoot })
      expect((await denied).error).toContain('已有分层建库正在运行')
      const writes = Array.from({ length: 30 }, async (_, i) => {
        await setImmediate(); state.values.push(i)
        await Promise.all([writeJson(f.root, 'state/stress.json', state), writeJson(f.root, 'work/pending.json', state)])
        for (const file of ['state/stress.json', 'work/pending.json']) expect(JSON.parse(await fs.readFile(path.join(f.root, file), 'utf8')).values.length).toBeGreaterThanOrEqual(i + 1)
      })
      await Promise.all(writes)
      for (const file of ['state/stress.json', 'work/pending.json']) expect(JSON.parse(await fs.readFile(path.join(f.root, file), 'utf8')).values).toEqual(Array.from({ length: 30 }, (_, i) => i))
      expect((await fs.readdir(f.root, { recursive: true })).some(file => file.endsWith('.tmp'))).toBe(false)
    })
  } finally { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited }
})

it('30个同键提取合并一次且返回独立对象，章节包乱序完成与顺序合并字节相同', async () => {
  const f = await layeredFixture(), file = path.join(f.knowledgeRoot, 'a.md')
  await fs.writeFile(file, '第一段研究结果。\n\n第二段研究结果。')
  const source = await readLocalSource(file, 'Markdown')
  const plan = source.segments.map((segment, paragraph_id) => [{ ...segment, paragraph_id, text: source.text.slice(segment.start, segment.end) }])
  const outputs: string[] = []
  for (const cap of [1, 30]) {
    // 两轮从相同的冷回执状态开始，避免第二轮只检验磁盘复用。
    await fs.rm(path.join(f.root, 'cache/tasks'), { recursive: true, force: true })
    f.policy.pageGenerationConcurrency = cap
    f.call.mockImplementation(async (_task, _system, input) => {
      const data = JSON.parse(input)
      for (let n = 0; n < (data.paragraphs?.[0]?.paragraph_id ? 1 : 5); n++) await setImmediate()
      return modelOutput(data)
    })
    const results = await Promise.all(Array.from({ length: 30 }, () => extractSource(f.root, 'S-0001', source, processing, f.options, 64000, undefined, [], undefined, plan)))
    expect(f.call).toHaveBeenCalledTimes(2) // 两包提取，短文不做全书摘要；30 个订阅者共用。
    outputs.push(JSON.stringify(results[0])); expect(results.every(item => JSON.stringify(item) === outputs.at(-1))).toBe(true)
    results[0]!.segments[0]!.points[0]!.text = '修改订阅副本'
    expect(results[1]!.segments[0]!.points[0]!.text).not.toBe('修改订阅副本')
    f.call.mockClear()
  }
  expect(outputs[0]).toBe(outputs[1])
})

it('高级设置默认3且受并发上限约束，全部任务跨供应商共用同一个30路上限', async () => {
  expect(defaultPolicy().pageGenerationConcurrency).toBe(3)
  for (const cap of [1, 3, 30, 50]) {
    const policy = { ...defaultPolicy(), pageGenerationConcurrency: cap }
    expect(validatePolicy(policy)).toEqual([]); expect(policySchema.safeParse(policy).success).toBe(true)
  }
  for (const cap of [0, 51, 1.5]) expect(validatePolicy({ ...defaultPolicy(), pageGenerationConcurrency: cap })).toContain(cap === 51 ? 'pageGenerationConcurrency 不能超过并发上限 50。' : 'pageGenerationConcurrency 应为 1～1000 的整数。')
  const library = newLibrary('闸门'), policy = { ...defaultPolicy(), pageGenerationConcurrency: 30, batchDelayMs: 0 }
  library.models.unified = { provider: 'a', model: 'mock' }; library.models.fallbacks = []
  library.models.layeredRoutes = { topic: { route: { provider: 'b', model: 'mock' } }, term: { route: { provider: 'c', model: 'mock' } } }
  let active = 0, peak = 0
  const gate = Promise.withResolvers<void>()
  const runtime: ModelRuntime = { async resolveModelInfo(provider, id) { return { provider, id, name: id } }, async *stream() {
    peak = Math.max(peak, ++active); if (active === 30) gate.resolve()
    await gate.promise; await setImmediate(); active--
    yield { type: 'text-delta', index: 0, text: '{}' }; yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const client = new ModelClient(runtime, library, policy)
  await Promise.all(Array.from({ length: 90 }, (_, index) => client.call('ingest', '规则', '{}', undefined, [], { operation: (['extract', 'topic', 'term'] as const)[index % 3]! })))
  expect(peak).toBe(30); expect(active).toBe(0); expect(client.attempts).toHaveLength(90)
})

it('429及5xx指数退避不占调用槽位，重试成功不产生提取失败', async () => {
  vi.useFakeTimers()
  const library = newLibrary('退避'), policy = { ...defaultPolicy(), pageGenerationConcurrency: 1, batchDelayMs: 0 }
  library.models.unified = { provider: 'mock', model: 'mock' }; library.models.fallbacks = []
  library.models.layeredRoutes = {}
  library.models.providerProfiles.mock = { concurrency: 50, retryLimit: 2, backoffMs: 100, cacheMode: 'automatic-prefix' }
  const starts: { input: string; at: number }[] = []; let failures = 0
  const runtime: ModelRuntime = { async resolveModelInfo(provider, id) { return { provider, id, name: id } }, async *stream(options) {
    const input = (options.messages[0]!.content[0] as { text: string }).text
    starts.push({ input, at: Date.now() })
    if (input === '重试' && failures++ < 2) throw new ModelCallError('暂时不可用', 'http', failures === 1 ? 429 : 503)
    yield { type: 'text-delta', index: 0, text: '{}' }; yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const client = new ModelClient(runtime, library, policy), begun = Date.now()
  const retry = client.call('ingest', '规则', '重试', undefined, [], { operation: 'extract' })
  await vi.advanceTimersByTimeAsync(0)
  expect(await client.call('ingest', '规则', '插入', undefined, [], { operation: 'term' })).toBe('{}')
  expect(starts.at(-1)).toEqual({ input: '插入', at: begun })
  await vi.advanceTimersByTimeAsync(100); await vi.advanceTimersByTimeAsync(199)
  expect(starts.filter(item => item.input === '重试')).toHaveLength(2)
  await vi.advanceTimersByTimeAsync(1); expect(await retry).toBe('{}')
  expect(starts.filter(item => item.input === '重试').map(item => item.at - begun)).toEqual([0, 100, 300])
})

const validators = new Map<string, z.ZodType>()
it('20篇固定种子乱序完成，30、3、1路来源主题术语标签逐字节一致', async () => {
  const products: string[] = []
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-09T00:00:00Z'))
  for (const concurrency of [30, 3, 1]) {
    const f = await layeredFixture(); f.policy.pageGenerationConcurrency = concurrency; f.policy.contextWindowTokens = 256000; f.options.granularity = 'custom'
    // 本组比较发布产物；回收扫描由存储专项覆盖，夹具退出时仍删除全部实际文件。
    vi.spyOn(retention, 'collectGarbage').mockResolvedValue(undefined)
    f.options.topics = { topicMergeMinSources: 3, extractionReview: 'all', sourceChapterMinPoints: 0, sourcePackRatio: 0, termThreshold50: 3 }
    f.options.embeddingClient = { identity: async () => '固定向量', embed: async texts => texts.map(text => text.includes('甲组') ? [1, 0] : [0, 1]) }
    await Promise.all(Array.from({ length: 20 }, (_, i) => fs.writeFile(path.join(f.knowledgeRoot, String(i).padStart(2, '0') + '.md'), '2026-11-09 ' + (i < 10 ? '甲组' : '乙组') + '研究发现结果改善' + i + '。')))
    let corrections = 0, active = 0, peak = 0
    f.runtime.stream = async function* (options) {
      const data = JSON.parse((options.messages[0]!.content[0] as { text: string }).text)
      peak = Math.max(peak, ++active)
      const seed = String(data.source_id ?? data.topic_id ?? data.term_id ?? '').split('').reduce((a, b) => (a * 1664525 + b.charCodeAt(0) + 1013904223) >>> 0, 42)
      for (let turn = 0; turn < 1 + seed % 5; turn++) await setImmediate()
      let output: any
      if (data.label_stage) output = { items: data.points.map((point: any) => ({ point_id: point.point_id, labels: ['研究方法'], keywords: ['研究对象'] })) }
      else if (data.review_stage) output = { items: (data.points ?? data.sentences).map((point: any) => ({ id: point.id, support: '完整支撑', missing: '' })) }
      else if (data.correction_stage) { corrections++; output = { items: data.items.map((item: any) => ({ id: item.id, paragraph_id: 0, section: '主要发现', evidence: item.validationFeedback.item.evidence })) } }
      else if (data.new_tags) output = { groups: [] }
      else if (data.term_id) output = { definition: [{ text: '原文定义', keys: data.contributions.map((item: any) => item.key) }], usage: [], findings: [], differences: [] }
      else if (data.topic_id) output = data.children
        ? { title: '父主题', summary: '研究范围', aliases: [], consensus: [], differences: [], conditions: [{ text: '子主题范围', child_ids: [data.children[0].id] }] }
        : { title: data.points[0].text.includes('甲组') ? '甲组主题' : '乙组主题', summary: '研究范围', aliases: [], removed_members: [], consensus: [], differences: [], conditions: [{ text: data.points[0].text, point_ids: [data.points[0].point_id] }] }
      else {
        const part = data.paragraphs[0], group = part.text.includes('甲组') ? '甲组' : '乙组'
        output = { tags: ['研究方法', '结果改善', '研究对象'], credibility: 'low', credibility_reason: '固定资料',
          points: Array.from({ length: 3 }, (_, i) => ({ text: group + '研究发现' + i, evidence: [{ locator: part.locator, quote: part.text }] })),
          terms: [{ paragraph_id: 0, name: group + '概念', referent: group + '固定指称', category: '概念', aliases: [], locator: part.locator, note: group + '固定定义' }] }
      }
      active--
      yield { type: 'text-delta', index: 0, text: JSON.stringify(output) }; yield { type: 'finish', reason: { kind: 'stop' } }
    }
    const built = await buildLayeredLibrary(f.options), manifest = await snapshotManifest(f.root)
    expect(manifest.version).toBe(built.version)
    const contracts = new Map(f.call.mock.calls.filter(args => args[5]?.structuredSchema).map(args => [JSON.stringify(args[5]!.structuredSchema!.schema), args] as const))
    for (const [key, args] of contracts) {
      const schema = args[5]!.structuredSchema!.schema as any
      if (!validators.has(key)) validators.set(key, z.fromJSONSchema(schema))
      const validator = validators.get(key)!
      expect(validator.safeParse(schemaExample(schema)).success, args[5]!.structuredSchema!.name + ' 生成示例').toBe(true)
      expect(validator.safeParse(JSON.parse(args[1].split('合法JSON示例：\n').at(-1)!)).success, args[5]!.structuredSchema!.name + ' 提示词示例').toBe(true)
    }
    expect(corrections).toBe(20); expect(peak).toBeLessThanOrEqual(concurrency); expect(manifest.sources).toHaveLength(20)
    expect(Object.keys(manifest.pages!).some(page => page.startsWith('topics/'))).toBe(true)
    expect(Object.keys(manifest.pages!).filter(page => page.startsWith('terms/') && !page.startsWith('terms/index-'))).toHaveLength(2)
    const pages = await Promise.all(Object.keys(manifest.pages!).sort().map(async page => [page, await versionPage(f.root, manifest, page)]))
    const extractions = await Promise.all(manifest.sources.map(async entry => [entry.source_id, await fs.readFile(path.join(f.root, entry.extract.path), 'utf8')]))
    products.push(JSON.stringify({ pages, extractions, tags: manifest.tag_merges, deps: manifest.deps, aliases: manifest.aliases, pageObjects: manifest.pages }))
    expect(extractions.map(([, bytes]) => JSON.parse(bytes!).segments.flatMap((segment: any) => segment.points).length)).toEqual(Array(20).fill(3))
    expect(products.at(-1)).toBe(products[0])
  }
  expect(products).toHaveLength(3); expect(products[0]).toBe(products[1]); expect(products[1]).toBe(products[2])
}, 60000)
