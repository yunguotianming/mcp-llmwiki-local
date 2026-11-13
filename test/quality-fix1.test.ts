// 同路径修改保留稳定标题满足新身份规则，原质量、排除成员及纠正断言保持。
import { expectModelCalls } from './layered-fixture.js'
import { mockSupportReview } from './layered-fixture.js'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { parseModelJson } from '../src/llm/json.js'
import { buildLayeredLibrary, readLayeredPage } from '../src/layered/index.js'
import { memberContentHash } from '../src/layered/membership.js'
import { pageRelevance, searchConfidence } from '../src/wiki/relevance.js'
import { layeredSettings } from '../src/domain/config.js'
import { browsePages } from '../src/wiki/browse.js'
import { stripBlockIds } from '../src/wiki/page-search.js'
import type { LayeredReadView } from '../src/layered/revocations.js'
import { cleanupLayeredFixtures, layeredFixture, layeredIncrementalFixture, layeredTopicFixture, snapshotManifest } from './layered-fixture.js'
import { fixture as queryFixture } from './query-pages-audit-fixture.js'
import { existsSync } from 'node:fs'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('JSON 只清理包装和尾括号；非法结构纠正两次后才记缺口且不能改主张', async () => {
  expect(parseModelJson('{"text":"括号 } [ 与转义 \\"","items":[]} }]}')).toEqual({ text: '括号 } [ 与转义 "', items: [] })
  expect(parseModelJson('```json\n{"items":[]}\n```')).toEqual({ items: [] })
  expect(() => parseModelJson('{"a":1} {"b":2}')).toThrow()
  const f = await layeredTopicFixture(), original = f.call.getMockImplementation()!
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 资料a\n\n甲组真实证据。')
  let attempts = 0, fail = false, originalText = ''
  f.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
    const input = JSON.parse(args[2]), raw = await original(...args)
    if (!input.topic_id) return raw
    attempts++
    if (input.validationFeedback) {
      const output = input.validationFeedback.original
      output.conditions[0].point_ids = fail ? ['错误编号'] : [input.points[0].point_id]
      return JSON.stringify(output)
    }
    const output = JSON.parse(raw); originalText = output.conditions[0].text
    output.conditions[0].point_ids = '错误结构'
    return JSON.stringify(output) + '}]'
  })
  await buildLayeredLibrary(f.options)
  expect(attempts).toBe(2)
  expect(await readLayeredPage(f.knowledgeRoot, 'T-0001')).toContain(originalText)
  fail = true; attempts = 0
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 资料a\n\n甲组变化后的真实证据。')
  await buildLayeredLibrary(f.options)
  expect(attempts).toBe(3)
  expect((await snapshotManifest(f.root)).topic_gaps).toHaveLength(1)
  expect(await readLayeredPage(f.knowledgeRoot, 'sources/S-0001.md')).toContain('甲组变化后的真实证据。')
})

it('移出成员保留原主张和状态，增量排除直到内容变化，来源不足记缺口', async () => {
  const f = await layeredIncrementalFixture(), original = f.call.getMockImplementation()!
  f.options.topics = { topicMergeMinSources: 2 }
  for (const [name, text] of [['a', '甲组护士团队冲突。'], ['b', '甲组护士协作冲突。'], ['c', '甲组研究者背景偏倚。']]) await writeFile(path.join(f.knowledgeRoot, name + '.md'), '# 资料' + name + '\n\n' + text!)
  f.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
    const input = JSON.parse(args[2])
    if (!input.topic_id) return original(...args)
    const members = [...input.points, ...input.current_points ?? []], removed = members.filter(item => item.text.includes('背景偏倚'))
    const kept = members.filter(item => !removed.includes(item))
    return JSON.stringify({ title: '团队冲突', aliases: [], summary: '护士团队冲突', consensus: [], differences: [],
      conditions: kept.map(item => ({ text: item.text, point_ids: [item.point_id] })), removed_members: removed.map(item => ({ point_id: item.point_id, reason: '研究者偏倚与团队冲突不是同一问题' })) })
  })
  await buildLayeredLibrary(f.options)
  const first = await snapshotManifest(f.root), topic = first.topics!.topics[0]!
  const rejected = Object.keys(first.topics!.excluded_members![topic.id]!)[0]!
  const extraction = JSON.parse(await readFile(path.join(f.root, first.sources[2]!.extract.path), 'utf8'))
  const point = extraction.segments.flatMap((item: any) => item.points).find((item: any) => item.point_id === rejected)
  expect(first.topics!.excluded_members![topic.id]![rejected]).toEqual({ content_hash: memberContentHash(point), reason: '研究者偏倚与团队冲突不是同一问题' })
  expect(topic.point_ids).not.toContain(rejected)
  expect(await readLayeredPage(f.knowledgeRoot, topic.path)).not.toContain('背景偏倚')
  expect(await readLayeredPage(f.knowledgeRoot, 'sources/S-0003.md')).toContain(point.text)
  await writeFile(path.join(f.knowledgeRoot, 'd.md'), '甲组护士处理冲突。')
  await buildLayeredLibrary(f.options)
  expect((await snapshotManifest(f.root)).topics!.topics.find(item => item.id === topic.id)!.point_ids).not.toContain(rejected)
  await writeFile(path.join(f.knowledgeRoot, 'c.md'), '# 资料c\n\n甲组护士团队冲突得到化解。')
  await buildLayeredLibrary(f.options)
  const changed = await snapshotManifest(f.root)
  expect(changed.topics!.topics.find(item => item.id === topic.id)!.sources).toContain('S-0003')
  expect(changed.topics!.excluded_members![topic.id]![rejected]).toBeUndefined()
  f.options.topics = { topicMergeMinSources: 4 }
  await writeFile(path.join(f.knowledgeRoot, 'c.md'), '# 资料c\n\n甲组研究者背景偏倚。')
  await buildLayeredLibrary(f.options)
  expect((await snapshotManifest(f.root)).topic_gaps?.some(gap => gap.message.includes('来源数不足'))).toBe(true)
})

it.skipIf(!(existsSync(new URL('./fixtures/quality-fix1-dev.json', import.meta.url))))('置信度使用高级设置的绝对门槛；开发集固定夹具与空结果回归（夹具含第三方论文原文，未随公开仓库发布）', async () => {
  const regression = JSON.parse(await readFile(new URL('./fixtures/quality-fix1-dev.json', import.meta.url), 'utf8'))
  const threshold = layeredSettings().searchRelevanceThreshold
  expect(threshold).toBe(0.2)
  expect(regression.split).toBe('开发')
  const hits = regression.hits.map(hit => ({ ...hit, relevance: pageRelevance(regression.query, hit) }))
  expect(hits.map(hit => hit.relevance)).toEqual(regression.expected)
  expect(searchConfidence(hits, threshold).confidence).toBe('high')
  expect(searchConfidence(hits, layeredSettings({ searchRelevanceThreshold: 1 }).searchRelevanceThreshold)).toEqual({ confidence: 'low', message: '未找到可信匹配；候选页仅供继续检索，请勿据此断言库中有答案。' })
  expect(searchConfidence([], threshold).confidence).toBe('none')
  expect(() => layeredSettings({ searchRelevanceThreshold: 1.1 })).toThrow('查询可信匹配')
  expect(pageRelevance('量子引力', { title: '护士', aliases: [], snippet: '护士研究' })).toBe(0)
  const f = await queryFixture()
  try {
    const high = await f.query.search('审查证据', f.library.name)
    expect(high.confidence).toBe('high')
    expect(high.results.every(hit => typeof hit.relevance === 'number' && hit.relevance >= 0 && hit.relevance <= 1)).toBe(true)
    f.library.layered = { searchRelevanceThreshold: 1 }
    const low = await f.query.search('审查证据之外的量子理论', f.library.name)
    expect(low.results.length).toBe(high.results.length)
    expect(low.confidence).toBe('low'); expect(low.message).toContain('未找到可信匹配')
    expect(low.groups[0]!.confidence).toBe('low')
    const empty = await f.query.search('审查证据', f.library.name, ['不存在的类型'])
    expect(empty.confidence).toBe('none'); expect(empty.results).toEqual([])
  } finally { f.cleanup() }
})

it('标签同义归并落盘、增量只判断新标签、成本记录且手改页保留；单标签不调用', async () => {
  const f = await layeredFixture()
  // 保存原型调用，避免 spy 自调用；新阶段仍使用同一个提取路由。
  const { ModelClient } = await import('../src/llm/client.js')
  const requests: any[] = []
  f.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
    const input = JSON.parse(args[2])
    if (input.new_tags) {
      requests.push(input); expect(args[5]?.operation).toBe('extract')
      args[5]?.beforeAttempt?.()
      args[5]?.onAttempt?.({ route: { provider: 'mock', model: 'extractor' }, startedAt: new Date().toISOString(), durationMs: 1, finish: 'stop', usage: { inputTokens: 7, cacheReadTokens: 3, outputTokens: 2 } })
      return JSON.stringify({ groups: [{ canonical: '半结构化访谈', tags: input.new_tags.includes('半结构式访谈') ? ['半结构化访谈', '半结构式访谈'] : ['半结构化访谈', '半结构访谈'] }] })
    }
    const output = JSON.parse(await ModelClient.prototype.call.call(f.client, ...args))
    output.tags = input.source_id === 'S-0001' ? ['半结构化访谈', '半结构式访谈', '定性研究'] : ['半结构访谈', '定性研究', '访谈']; return JSON.stringify(output)
  })
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '可核验的研究证据。')
  const first = await buildLayeredLibrary(f.options)
  const page = await readLayeredPage(f.knowledgeRoot, 'sources/S-0001.md')
  expect(parse(page.split('---')[1]!).tags).toEqual(['半结构化访谈', '定性研究'])
  const manifest = await snapshotManifest(f.root)
  expect(manifest.tag_merges!.groups[0]!.tags).toContain('半结构式访谈')
  expect(requests[0]).toEqual({ new_tags: ['半结构化访谈', '半结构式访谈', '定性研究'].sort(), canonical_tags: [], vocabulary: { tags: [], terms: [] } })
  const costs = JSON.parse(await readFile(path.join(f.root, 'logs/costs.json'), 'utf8'))
  expect(costs[first.version].stages['标签归并'].actual_calls).toBe(1)
  expect(costs[first.version].stages['标签归并']).toMatchObject({ input_tokens: 7, cache_tokens: 3, output_tokens: 2 })
  await writeFile(path.join(f.root, 'wiki/sources/S-0001.md'), page + '\n人工补充。')
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '另一个研究证据。')
  await buildLayeredLibrary(f.options)
  expect(requests[1].new_tags).toEqual(['半结构访谈', '访谈'].sort())
  expect(requests[1].canonical_tags).toContain('半结构化访谈')
  expect(parse((await readLayeredPage(f.knowledgeRoot, 'sources/S-0002.md')).split('---')[1]!).tags).toEqual(['半结构化访谈', '定性研究', '访谈'])
  expect(await readFile(path.join(f.root, 'wiki/sources/S-0001.md'), 'utf8')).toBe(page + '\n人工补充。')
  await buildLayeredLibrary(f.options); expect(requests).toHaveLength(2)
  const one = await layeredFixture()
  one.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
    expect(JSON.parse(args[2]).new_tags).toBeUndefined()
    const output = JSON.parse(await ModelClient.prototype.call.call(one.client, ...args)); output.tags = ['唯一标签', '#唯一标签', ' 唯一标签 ']; return JSON.stringify(output)
  })
  await writeFile(path.join(one.knowledgeRoot, 'a.md'), '单标签证据。')
  await buildLayeredLibrary(one.options); expect(one.call).toHaveBeenCalledTimes(1 + 1) // 向量模式默认关闭补标，按其余文本阶段精确计数。
  expectModelCalls(one.call, { extraction: 1, review: 1 })
})

it('浏览摘要保持原文连续片段，只移除 YAML 与块 ID', async () => {
  const raw = '---\ntitle: 页面\npage_type: topic\n---\n# **页面** ^title\n\n[链接](目标)  保留双空格\r\n下一行 ^block-id\n'
  const view = { manifest: { sources: [], card: { name: '库', domain: '不能作为摘要的卡片' } }, deps: { pages: { 'index.md': { sources: [] }, 'topics/T-0001.md': { sources: [] } } }, version: 'v1', generation: 0,
    document: async () => ({ status: 'ok', content: raw }) } as unknown as LayeredReadView
  const result = await browsePages(view, '库', 'root', {})
  const original = stripBlockIds(raw.replace(/^---\n[\s\S]*?\n---\n/, ''))
  for (const node of [result.node, ...result.children]) { expect(node.summary).toBe(original); expect(original.includes(node.summary)).toBe(true) }
})
