import { mockSupportReview, modelOutput } from './layered-fixture.js'
import { versionFile } from './layered-fixture.js'
import { snapshotManifest } from './layered-fixture.js'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { evidenceDictionary, expandEvidenceReferences } from '../src/layered/evidence.js'
import { estimateLayeredBuild, logFairTruncation, truncateFairly } from '../src/layered/budget.js'
import { costReport, meteredOptions } from '../src/layered/costs.js'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { ModelClient } from '../src/llm/client.js'
import { newLibrary } from '../src/domain/config.js'
import { defaultPolicy } from '../src/domain/policy.js'
import type { PendingBuild } from '../src/layered/schema.js'
import type { ExtractionInput } from './layered-fixture.js'
import { cleanupLayeredFixtures, layeredFixture } from './layered-fixture.js'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

describe('P2 分层输入预算与恢复', () => {
  it('重复原文只保留一个稳定证据编号，验证时还原定位与引文', () => {
    const value = evidenceDictionary([
      { paragraph_id: 1, locator: 'L4-L4', text_hash: 'h1', text: '共同引文。' },
      { paragraph_id: 2, locator: 'L9-L9', text_hash: 'h2', text: '共同引文。' },
    ])
    expect(Object.values(value.dictionary)).toHaveLength(1)
    expect(value.paragraphs[0]).not.toHaveProperty('text')
    expect(value.paragraphs[1]).not.toHaveProperty('text')
    expect(JSON.stringify(value)).toContain('共同引文。')
    expect(JSON.stringify(value).match(/共同引文。/g)).toHaveLength(1)
    const ref = Object.keys(value.dictionary)[0]!
    const restored = JSON.parse(expandEvidenceReferences(JSON.stringify({ points: [{ paragraph_id: 2, evidence: [{ evidence_ref: ref }] }] }), value.dictionary))
    expect(restored.points[0].evidence[0]).toEqual({ locator: 'L9-L9', quote: '共同引文。' })
    expect(() => expandEvidenceReferences(JSON.stringify({ points: [{ paragraph_id: 9, evidence: [{ evidence_ref: ref }] }] }), value.dictionary)).toThrow('不属于本次请求')
  })

  it('同批提取一次发送多个短段，单条引文失败只纠正该条并保留其他条', async () => {
    const f = await layeredFixture(), seen: { system: string; input: Record<string, unknown>; userMessage: string }[] = []
    await writeFile(path.join(f.knowledgeRoot, 'batch.md'), '# 甲\n\n甲段证据。\n\n## 乙\n\n乙段证据。')
    f.runtime.stream = async function* (options) {
      const message = options.messages[0]!.content[0]!, input = JSON.parse(message.type === 'text' ? message.text : '') as Record<string, unknown>
      const support = mockSupportReview(input)
      if (support) { yield { type: 'text-delta', index: 0, text: support }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
      if (input.new_tags) { yield { type: 'text-delta', index: 0, text: JSON.stringify({ groups: [] }) }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
      seen.push({ system: options.system ?? '', input, userMessage: message.type === 'text' ? message.text : '' })
      if (input.correction_stage) {
        // 同批修复每项，保留既有逐字引文与调用次数断言。
        const items = (input.items as any[]).map(entry => {
          const item = entry.validationFeedback.item
          const paragraph = entry.paragraphs.find((value: any) => value.paragraph_id === item.paragraph_id)!
          return { id: entry.id, ...item, evidence: [{ locator: paragraph.locator, quote: paragraph.text }] }
        })
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ items }) }; yield { type: 'finish', reason: { kind: 'stop' } }; return
      }
      const request = input as unknown as ExtractionInput
      const eligible = request.paragraphs.filter(part => !/^#{1,6}\s/.test(part.text))
      const result = { tags: ['研究方法', '研究对象', '核心主题'], credibility: 'low', credibility_reason: '测试笔记', terms: [], points: eligible.map((part, index) => ({ paragraph_id: part.paragraph_id,
        text: part.text, section: '主要发现', evidence: [{ locator: part.locator, quote: index === 0 ? '错误引文' : part.text }] })) }
      yield { type: 'text-delta', index: 0, text: JSON.stringify(result) }; yield { type: 'finish', reason: { kind: 'stop' } }
    }
    try {
      await buildLayeredLibrary(f.options)
      expect(seen).toHaveLength(2)
      expect((seen[0]!.input.paragraphs as unknown[]).length).toBeGreaterThan(1)
      expect(seen[0]!.system.startsWith('你是资料提取器。')).toBe(true)
      expect(seen[0]!.userMessage).toContain('甲段证据。')
      expect(seen[0]!.input).toHaveProperty('evidence_dictionary')
      const costs = JSON.parse(await readFile(path.join(f.root, 'logs/costs.json'), 'utf8'))['v000001'].stages['提取']
      expect(costs.logical_tasks).toBe((seen[0]!.input.paragraphs as unknown[]).length)
      expect(costs.actual_calls).toBe(2)
      const estimates = estimateLayeredBuild({ sources: 1, leafSegments: costs.logical_tasks, tier: 50, topicLeaves: 0, topicParents: 0, termSections: 0 })
      expect(estimates['提取'].calls).toBe(costs.logical_tasks)
      const allocation = truncateFairly([{ source_id: 'S-1', text: '甲'.repeat(80) }, { source_id: 'S-2', text: '乙'.repeat(80) }], 40)
      expect(allocation.truncated).toEqual(['S-1', 'S-2'])
      expect(Buffer.byteLength(allocation.items[0]!.text)).toBe(Buffer.byteLength(allocation.items[1]!.text))
      await logFairTruncation(f.root, 'terms/TM-0001#T-0001', allocation.truncated, 'termInputBudget')
      const log = await readFile(path.join(f.root, 'logs/build.md'), 'utf8')
      expect(log).toContain('### 输入预算截断'); expect(log).toContain('S-1、S-2'); expect(log).toContain('termInputBudget')
      const extractionPath = (await readdir(path.join(f.root, 'objects/snapshots/S-0001'), { recursive: true })).find(item => item.endsWith('.json') && item.includes('extract'))!
      const extraction = JSON.parse(await readFile(path.join(f.root, 'objects/snapshots/S-0001', extractionPath), 'utf8'))
      expect(extraction.segments.flatMap((segment: { points: unknown[] }) => segment.points)).toHaveLength(2)
    } finally { cleanupLayeredFixtures() }
  })

  it('到调用预算后持久化部分提取，再次运行跳过已完成请求', async () => {
    const f = await layeredFixture(), seen: string[] = []
    await writeFile(path.join(f.knowledgeRoot, 'resume.md'), '# 一\n\n' + [1, 2, 3].map(value => `## ${value}\n\n${String(value).repeat(500)}\n`).join('\n'))
    f.options.tier = 25
    f.options.topics = { maxBuildCalls: 1 }
    f.options.maxInputBytes = 3000
    f.options.embeddingClient = { identity: async () => 'fixture-weights-v1', embed: async input => input.map(() => [1, 0]) }
    f.runtime.stream = async function* (options) {
      const message = options.messages[0]!.content[0]!, text = message.type === 'text' ? message.text : ''
      const request = JSON.parse(text) as Record<string, unknown>
      const support = mockSupportReview(request)
      if (support) { yield { type: 'text-delta', index: 0, text: support }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
      if (request.new_tags) { yield { type: 'text-delta', index: 0, text: JSON.stringify({ groups: [] }) }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
      if (request.summary_id) {
        yield { type: 'text-delta', index: 0, text: modelOutput(request as unknown as ExtractionInput) }; yield { type: 'finish', reason: { kind: 'stop' } }; return
      }
      if (!request.topic_id) {
        seen.push(text)
        const paragraphs = request.paragraphs as ExtractionInput['paragraphs']
        const paragraph = paragraphs.find(item => !/^#{1,6}\s/.test(item.text))
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ tags: ['研究方法', '研究对象', '核心主题'], credibility: 'low', credibility_reason: '测试', points: paragraph ? [{ paragraph_id: paragraph.paragraph_id,
          text: paragraph.text, section: '主要发现', evidence: [{ locator: paragraph.locator, quote: paragraph.text }] }] : [], terms: [] }) }
      } else if (request.children) {
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ aliases: ['综合主题'], title: '父主题', summary: '范围', consensus: [], differences: [],
          conditions: [{ text: '适用', child_ids: [(request.children as { id: string }[])[0]!.id] }] }) }
      } else {
        const pointId = (request.points as { point_id: string }[])[0]!.point_id
        yield { type: 'text-delta', index: 0, text: JSON.stringify({ aliases: ['综合主题'], title: '主题', summary: '范围', consensus: [], differences: [], conditions: [{ text: '适用', point_ids: [pointId] }] }) }
      }
      yield { type: 'finish', reason: { kind: 'stop' } }
    }
    try {
      await expect(buildLayeredLibrary(f.options)).rejects.toThrow('调用次数已达上限')
      const folder = path.join(f.root, 'work/extractions/S-0001')
      const relative = (await readdir(folder, { recursive: true })).find(item => item.includes('extract') && item.endsWith('.json'))!
      const progress = JSON.parse(await readFile(path.join(folder, relative), 'utf8'))
      expect(progress.in_progress).toBe(true); expect(progress.completed_chunks).toHaveLength(1)
      const finishedFirst = seen[0]!
      // 第二轮真发 39 次调用：18 次提取 + 16 次提取后核对 + 4 次来源摘要 + 1 次标签归并。
      // maxBuildCalls 按实际尝试计（含核对、摘要、标签）；适中档启用关键核对且短文分包后提取增至 18 次。
      f.options.topics = { maxBuildCalls: 39 }
      await buildLayeredLibrary(f.options)
      expect(seen.slice(1)).not.toContain(finishedFirst)
      expect(seen.length).toBeGreaterThan(1)
    } finally { cleanupLayeredFixtures() }
  })

  it('Token 上限暂停前不调用模型，持久化后调高预算可继续', async () => {
    const f = await layeredFixture()
    const attempts: { route: { provider: string; model: string }; startedAt: string; durationMs: number; finish: string; estimatedInputTokens: number }[] = []
    let calls = 0
    const pending = { format_version: 1, base_version: null, version: null, manifest: {}, card: {}, added: [], model_calls: 0,
      started_at: new Date().toISOString(), costs: costReport() } as unknown as PendingBuild
    const client = { info: async () => ({ provider: 'mock', id: 'model', name: 'model' }), attempts,
      call: async (_task: string, system: string, input: string, _signal?: AbortSignal, _images?: never[], options?: { beforeAttempt?: () => void }) => {
        options?.beforeAttempt?.(); calls++
        attempts.push({ route: { provider: 'mock', model: 'model' }, startedAt: new Date().toISOString(), durationMs: 0, finish: 'stop',
          estimatedInputTokens: Math.ceil(Buffer.byteLength(system + input) / 4) })
        return '{}'
      } }
    try {
      await mkdir(f.root, { recursive: true })
      const options = { ...f.options, client, topics: { maxBuildTokens: 1 } }
      await expect(meteredOptions(f.root, pending, options).client.call('ingest', '固定', '{}')).rejects.toThrow('Token 预算')
      expect(calls).toBe(0)
      expect(JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8')).paused.reason).toBe('budget')
      options.topics.maxBuildTokens = 100
      await expect(meteredOptions(f.root, pending, options).client.call('ingest', '固定', '{}')).resolves.toBe('{}')
      expect(calls).toBe(1)
      expect(pending.costs!.stages['提取']!.actual_calls).toBe(1)
    } finally { cleanupLayeredFixtures() }
  })

  it('纠正前预算暂停保留同批有效条目，续跑只纠正失败条目', async () => {
    const f = await layeredFixture(), seen: Record<string, any>[] = []
    await writeFile(path.join(f.knowledgeRoot, 'batch.md'), '第一段证据。\n\n第二段证据。')
    f.options.topics = { maxBuildCalls: 1 }
    f.options.embeddingClient = { identity: async () => 'fixture-weights-v1', embed: async values => values.map(() => [1, 0]) }
    f.runtime.stream = async function* (options) {
      const input = JSON.parse((options.messages[0]!.content[0] as { text: string }).text); seen.push(input)
      const support = mockSupportReview(input)
      if (support) { yield { type: 'text-delta', index: 0, text: support }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
      if (input.new_tags) { yield { type: 'text-delta', index: 0, text: JSON.stringify({ groups: [] }) }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
      let output: unknown
      if (input.correction_stage) output = { items: input.items.map((entry: any) => ({ id: entry.id, ...entry.validationFeedback.item, evidence: [{ locator: entry.paragraphs[0].locator, quote: entry.paragraphs[0].text }] })) }
      else if (input.topic_id) output = { aliases: ['综合主题'], title: '主题', summary: '范围', consensus: [], differences: [], conditions: [{ text: '第一段证据。', point_ids: [input.points[0].point_id] }] }
      else output = { tags: ['研究方法', '研究对象', '核心主题'], credibility: 'low', credibility_reason: '测试', terms: [], points: input.paragraphs.map((part: any, index: number) => ({
        paragraph_id: part.paragraph_id, text: part.text, section: '主要发现', evidence: [{ locator: part.locator, quote: index ? part.text : '错误引文' }],
      })) }
      yield { type: 'text-delta', index: 0, text: JSON.stringify(output) }; yield { type: 'finish', reason: { kind: 'stop' } }
    }
    await expect(buildLayeredLibrary(f.options)).rejects.toThrow('调用次数已达上限')
    const folder = path.join(f.root, 'work/extractions/S-0001'), relative = (await readdir(folder, { recursive: true })).find(item => item.includes('extract') && item.endsWith('.json'))!
    const saved = JSON.parse(await readFile(path.join(folder, relative), 'utf8'))
    expect(saved.segments.flatMap((segment: any) => segment.points).map((point: any) => point.text)).toEqual(['第二段证据。'])
    expect(Object.values(saved.chunk_results)).toHaveLength(1)
    expect(await readFile(path.join(f.root, 'logs/cost-report.md'), 'utf8')).toContain('提取')
    f.options.topics.maxBuildCalls = 10
    await buildLayeredLibrary(f.options)
    expect(seen.filter(input => input.paragraphs && !input.correction_stage)).toHaveLength(1)
    expect(seen.filter(input => input.correction_stage)).toHaveLength(1)
    const manifest = await snapshotManifest(f.root)
    const completed = JSON.parse(await readFile(path.join(f.root, manifest.sources[0].extract.path), 'utf8'))
    expect(completed.segments.flatMap((segment: any) => segment.points)).toHaveLength(2)
  })

  it('调高预算继续复用已完成主题，批大小有界且成本含失败重试', async () => {
    const f = await layeredFixture(), seen: Record<string, any>[] = []
    await writeFile(path.join(f.knowledgeRoot, 'source.md'), '甲段证据。'.repeat(240) + '\n\n' + '乙段证据。'.repeat(240))
    f.options.maxInputBytes = 8000
    f.options.topics = { topicMergeMinSources: 1, maxBuildCalls: 4, maxBatchItems: 1, topicMaxSources: 1, extractionReview: 'off', topicReview: false }
    f.options.embeddingClient = { identity: async () => 'fixture-weights-v1', embed: async values => values.map(value => value.includes('甲') ? [1, 0] : [0, 1]) }
    const library = newLibrary('p2'), policy = defaultPolicy()
    library.models.unified = { provider: 'mock', model: 'extractor' }; library.models.layeredRoutes = {}
    library.models.providerProfiles.mock = { concurrency: 1, retryLimit: 1, backoffMs: 0, cacheMode: 'automatic-prefix' }
    policy.batchDelayMs = 0
    let failed = false
    f.runtime.stream = async function* (options) {
      const input = JSON.parse((options.messages[0]!.content[0] as { text: string }).text); seen.push(input)
      const support = mockSupportReview(input)
      if (support) { yield { type: 'text-delta', index: 0, text: support }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
      if (input.new_tags) { yield { type: 'text-delta', index: 0, text: JSON.stringify({ groups: [] }) }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
      yield { type: 'usage', usage: { inputTokens: 10, cacheReadTokens: 5, outputTokens: 2, totalTokens: 17 } }
      if (!failed) { failed = true; yield { type: 'finish', reason: { kind: 'error', failure: { code: 'overload', message: '测试繁忙', status: 503 } } }; return }
      const paragraph = input.paragraphs?.[0]
      const output = input.summary_id ? { point_ids: input.children.flatMap((child: any) => child.points.map((point: any) => point.point_id)).slice(0, input.point_limit) }
        : input.topic_id ? { aliases: ['综合主题'], title: '主题', summary: '范围', consensus: [], differences: [], conditions: [{ text: '有依据的条件', point_ids: [input.points[0].point_id] }] }
        : { tags: ['研究方法', '研究对象', '核心主题'], credibility: 'low', credibility_reason: '测试', terms: [], points: [{ paragraph_id: paragraph.paragraph_id, text: paragraph.text, section: '主要发现', evidence: [{ locator: paragraph.locator, quote: paragraph.text }] }] }
      yield { type: 'text-delta', index: 0, text: JSON.stringify(output) }; yield { type: 'finish', reason: { kind: 'stop' } }
    }
    f.options.client = new ModelClient(f.runtime, library, policy)
    await expect(buildLayeredLibrary(f.options)).rejects.toThrow('调用次数已达上限')
    const saved = JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8'))
    expect(Object.keys(saved.topics.pages)).toHaveLength(1)
    expect(seen.filter(input => input.paragraphs).every(input => input.paragraphs.length <= 1)).toBe(true)
    const completedTopic = seen.find(input => input.topic_id)!.topic_id
    f.options.topics.maxBuildCalls = 10
    await buildLayeredLibrary(f.options)
    expect(seen.filter(input => input.topic_id === completedTopic)).toHaveLength(1)
    const costs = JSON.parse(await readFile(path.join(f.root, 'logs/costs.json'), 'utf8')).v000001.stages
    expect(costs['提取']).toMatchObject({ logical_tasks: 2, actual_calls: 3, input_tokens: 30, cache_tokens: 15, output_tokens: 6 })
  })

  it('首次发布保留真实截断日志，估算按术语门槛和层级分项', async () => {
    const f = await layeredFixture()
    await writeFile(path.join(f.knowledgeRoot, 'long.md'), '原始依据。')
    f.options.topics = { topicMergeMinSources: 1, leafInputBudget: 1800, termInputBudget: 900, termThreshold50: 1 }
    f.options.embeddingClient = { identity: async () => 'fixture-weights-v1', embed: async values => values.map(() => [1, 0]) }
    f.runtime.stream = async function* (options) {
      const input = JSON.parse((options.messages[0]!.content[0] as { text: string }).text)
      const support = mockSupportReview(input)
      if (support) { yield { type: 'text-delta', index: 0, text: support }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
      if (input.new_tags) { yield { type: 'text-delta', index: 0, text: JSON.stringify({ groups: [] }) }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
      let output: unknown
      if (input.topic_id) {
        expect(Buffer.byteLength((options.system ?? '') + (options.messages[0]!.content[0] as { text: string }).text)).toBeLessThanOrEqual(1800)
        output = { aliases: ['综合主题'], title: '主题', summary: '范围', consensus: [], differences: [], conditions: [{ text: '有依据的条件', point_ids: [input.points[0].point_id] }] }
      } else if (input.term_id) {
        expect(Buffer.byteLength((options.system ?? '') + (options.messages[0]!.content[0] as { text: string }).text)).toBeLessThanOrEqual(900)
        output = { definition: [{ text: '原始依据', keys: [input.contributions[0].key] }], usage: [], findings: [], differences: [] }
      } else {
        const part = input.paragraphs[0]
        output = { tags: ['研究方法', '研究对象', '核心主题'], credibility: 'low', credibility_reason: '测试', points: [{ paragraph_id: part.paragraph_id, text: '原始依据。"\\\n'.repeat(500), section: '主要发现', evidence: [{ locator: part.locator, quote: part.text }] }],
          terms: [{ paragraph_id: part.paragraph_id, name: '术语', category: '概念', aliases: [], locator: part.locator, note: '原始依据。"\\\n'.repeat(500) }] }
      }
      yield { type: 'text-delta', index: 0, text: JSON.stringify(output) }; yield { type: 'finish', reason: { kind: 'stop' } }
    }
    await buildLayeredLibrary(f.options)
    for (const relative of ['logs/build.md', '.publish/v000001/log.md']) {
      const log = relative.startsWith('.publish/') ? await versionFile(f.root, 'v000001', 'log.md') : await readFile(path.join(f.root, relative), 'utf8')
      expect(log).toContain('输入预算截断'); expect(log).toContain('S-0001'); expect(log).toContain('topics/T-0001.md')
      expect(log).toContain('leafInputBudget'); expect(log).toContain('termInputBudget')
    }
    const base = { sources: 20, leafSegments: 40, tier: 50, topicLeaves: 4, topicParents: 1, termSourceCounts: [3, 5, 20], termMaxSources: 10, reclusterCalls: 99 }
    const estimates = estimateLayeredBuild(base)
    expect(estimates['术语'].calls).toBe(3); expect(estimates['父页'].calls).toBe(1)
    expect(estimates.total.calls).toBe(48); expect(estimates['全量重聚类'].calls).toBe(99)
    expect(estimateLayeredBuild({ ...base, tier: 25 })['术语'].calls).toBe(0)
    expect(estimateLayeredBuild({ ...base, termThreshold: 10 })['术语'].calls).toBe(2)
  })

  it('备用模型提取后预算暂停，续跑保留实际模型且不重做已完成段', async () => {
    const f = await layeredFixture(), completed: number[] = [], library = newLibrary('fallback'), policy = defaultPolicy()
    await writeFile(path.join(f.knowledgeRoot, 'source.md'), '第一段证据。'.repeat(200) + '\n\n' + '第二段证据。'.repeat(200))
    f.options.maxInputBytes = 8000
    library.models.unified = { provider: 'mock', model: 'primary' }; library.models.layeredRoutes = {}; library.models.fallbacks = [{ provider: 'mock', model: 'backup' }]
    library.models.providerProfiles.mock = { concurrency: 1, retryLimit: 0, backoffMs: 0, cacheMode: 'automatic-prefix' }
    policy.batchDelayMs = 0
    f.options.client = new ModelClient(f.runtime, library, policy)
    f.options.topics = { topicMergeMinSources: 1, maxBuildCalls: 3, maxBatchItems: 1 }; f.options.embeddingClient = { identity: async () => 'fixture-weights-v1', embed: async values => values.map(() => [1, 0]) }
    f.runtime.stream = async function* (options) {
      if (options.model === 'primary') { yield { type: 'finish', reason: { kind: 'error', failure: { code: 'overload', message: '测试繁忙', status: 503 } } }; return }
      const input = JSON.parse((options.messages[0]!.content[0] as { text: string }).text), part = input.paragraphs?.[0]
      const support = mockSupportReview(input)
      if (support) { yield { type: 'text-delta', index: 0, text: support }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
      if (input.new_tags) { yield { type: 'text-delta', index: 0, text: JSON.stringify({ groups: [] }) }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
      if (part) completed.push(part.paragraph_id)
      const output = part ? { tags: ['研究方法', '研究对象', '核心主题'], credibility: 'low', credibility_reason: '测试', terms: [], points: [{ paragraph_id: part.paragraph_id, text: part.text.slice(0, 60), section: '主要发现', evidence: [{ locator: part.locator, quote: part.text }] }] }
        : { aliases: ['综合主题'], title: '主题', summary: '范围', consensus: [], differences: [], conditions: [{ text: '有依据的条件', point_ids: [input.points[0].point_id] }] }
      yield { type: 'text-delta', index: 0, text: JSON.stringify(output) }; yield { type: 'finish', reason: { kind: 'stop' } }
    }
    await expect(buildLayeredLibrary(f.options)).rejects.toThrow('调用次数已达上限')
    expect(completed).toEqual([0])
    f.options.topics.maxBuildCalls = 10
    await buildLayeredLibrary(f.options)
    expect(completed).toEqual([0, 1])
    const manifest = await snapshotManifest(f.root)
    const extraction = JSON.parse(await readFile(path.join(f.root, manifest.sources[0].extract.path), 'utf8'))
    expect(extraction.processing.model).toBe('mock/backup'); expect(extraction.metadata.credibility).toBe('low')
    expect(extraction.segments.flatMap((segment: any) => segment.points)).toHaveLength(2)
  })
})
