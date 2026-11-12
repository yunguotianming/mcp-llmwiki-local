// 独立来源使用各自标题，增量保留标题满足相似度；主题层级、预算、术语配额断言保持。
import { expectModelCalls } from './layered-fixture.js'
import { mockSupportReview } from './layered-fixture.js'
import { versionFile, hydratedState } from './layered-fixture.js'
import { readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildLayeredLibrary, readLayeredPage, revokeLayeredSources } from '../src/layered/index.js'
import { layeredSettings, newLibrary, emptyRegistry } from '../src/domain/config.js'
import { exportConfig, importConfig } from '../src/domain/config-io.js'
import { termSynthesisThreshold } from '../src/layered/terms.js'
import { mergeShrunken, newTopic, refreshTree, splitTopic } from '../src/layered/hierarchy.js'
import type { CostReport, Dependencies, TopicState } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, layeredIncrementalFixture, shareLayeredFixture } from './layered-fixture.js'
import type { FixtureSnapshot } from './layered-fixture.js'

vi.mock('../src/wiki/synthesis.js', () => { throw new Error('分层主链禁止全库身份归并和两两比较') })
vi.mock('../src/wiki/identity-search.js', () => { throw new Error('分层主链禁止旧身份归并候选召回') })
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
const json = async <T>(file: string): Promise<T> => JSON.parse(await readFile(file, 'utf8')) as T
const state = (f: { root: string }) => hydratedState<TopicState>(f.root)
const published = async <T>(f: { root: string }, file: string) => {
  const pointer = await json<{ version: string }>(path.join(f.root, 'state/current.json'))
  return JSON.parse(await versionFile(f.root, pointer.version, file)) as T
}
const files = async (f: { knowledgeRoot: string }, count: number) => Promise.all(Array.from({ length: count }, (_, i) => writeFile(path.join(f.knowledgeRoot, `${i}.md`), `# 资料${i}\n\n甲组证据${i}。`)))
const treeSettings = { topicMaxSources: 2, topicMaxDepth: 1, topicMaxChildren: 2, topicMergeMinSources: 1 }

describe('层级树', () => {
  let template: FixtureSnapshot, reuseRoot: string
  let templateRequests: Awaited<ReturnType<typeof layeredIncrementalFixture>>['topicRequests']
  beforeAll(async () => {
    const f = await layeredIncrementalFixture(); await files(f, 3)
    reuseRoot = f.knowledgeRoot
    await buildLayeredLibrary({ ...f.options, topics: { ...treeSettings, parentInputBudget: 3000 } }); template = await shareLayeredFixture(f)
    templateRequests = f.topicRequests
  })
  it('超限按向量拆分，目录和父页输入只含子摘要，每层预算独立', async () => {
    const f = await layeredIncrementalFixture(template, reuseRoot)
    const tree = await state(f), deps = await published<Dependencies>(f, 'deps.json')
    expect(tree.topics.map(topic => topic.id)).toEqual(['T-0001', 'T-0001-01', 'T-0001-02'])
    expect(tree.topics[1]!.path).toBe('topics/T-0001/T-0001-01.md')
    const parent = templateRequests.find(request => request.input.children)!
    expect(Object.keys(parent.input).sort()).toEqual(['children', 'max_chars', 'mode', 'topic_id'])
    expect(parent.input.children!.every(child => Object.keys(child).sort().join(',') === 'id,summary,title')).toBe(true)
    expect(parent.input).not.toHaveProperty('points'); expect(parent.input).not.toHaveProperty('sources')
    expect(deps.pages['topics/T-0001.md']!.points).toEqual([])
    for (const dependency of Object.values(deps.pages)) for (const call of dependency.calls ?? []) expect(call.input_bytes).toBeLessThanOrEqual(call.input_limit)
    const parentPage = await readLayeredPage(f.knowledgeRoot, 'T-0001')
    expect(parentPage).toContain('## 子主题导航'); expect(parentPage).not.toContain('## 来源导航')
    expect(await readLayeredPage(f.knowledgeRoot, tree.topics[1]!.path)).toContain('../../sources/S-0001.md')
    expect(await readLayeredPage(f.knowledgeRoot)).toContain('  - [T-0001-01')
  })
  it('到顶横向拆分，父页超扇出为零调用导航；成本满足逻辑任务上界', async () => {
    const f = await layeredIncrementalFixture(template, reuseRoot)
    const before = await published<Dependencies>(f, 'deps.json')
    await writeFile(path.join(f.knowledgeRoot, '3.md'), '甲组新增证据。')
    const result = await buildLayeredLibrary({ ...f.options, topics: treeSettings }), tree = await state(f)
    expect(tree.topics).toHaveLength(4)
    expect(tree.topics.every(topic => topic.id.split('-').length <= 3)).toBe(true)
    expect(tree.topics.filter(topic => topic.parent_id).every(topic => topic.sources.length <= 2)).toBe(true)
    expect(f.topicRequests.every(request => !request.input.children)).toBe(true)
    expect(await readLayeredPage(f.knowledgeRoot, 'T-0001')).not.toContain('## 共识')
    const costs = (await json<Record<string, CostReport>>(path.join(f.root, 'logs/costs.json')))[result.version]!
    const deps = await published<Dependencies>(f, 'deps.json')
    const affectedLeaves = [...new Set(Object.values(deps.reverse_sources!).flat())].filter(page => page.startsWith('topics/') && !deps.pages[page]!.children?.length
      && JSON.stringify(deps.pages[page]!.points) !== JSON.stringify(before.pages[page]?.points))
    const tasks = ['提取', '主题', '术语'].reduce((sum, stage) => sum + costs.stages[stage]!.logical_tasks, 0)
    expect(tasks).toBeLessThanOrEqual(costs.stages['提取']!.logical_tasks + affectedLeaves.length * (1 + treeSettings.topicMaxDepth))
    expect(f.call.mock.calls.every(call => { const input = JSON.parse(call[2]); return input.source_id || input.topic_id })).toBe(true)
  })
  it('删除及参数变化后重聚保留旧页与 ID，重建不使用旧正文', async () => {
    const f = await layeredIncrementalFixture(template, reuseRoot)
    await unlink(path.join(f.knowledgeRoot, '0.md'))
    await buildLayeredLibrary({ ...f.options, topics: { ...treeSettings, topicMergeMinSources: 2 } })
    const aliases = await published<Record<string, string>>(f, 'aliases.json')
    expect(aliases).toEqual({})
    expect((await state(f)).topics.map(topic => topic.id)).toEqual(['T-0001', 'T-0001-01', 'T-0001-02'])
    expect(await readLayeredPage(f.knowledgeRoot, 'T-0001-02')).toContain('## 适用条件')
    expect(f.topicRequests.every(request => request.input.mode === 'rebuild' && !request.input.current_page)).toBe(true)
    const leaf = f.topicRequests.find(request => !request.input.children)!
    expect(leaf.input.points.every(point => point.source_id !== 'S-0001' && /^P\d+$/.test(point.point_id))).toBe(true)
    expect(await readLayeredPage(f.knowledgeRoot, 'T-0001-01')).not.toContain('S-0001@')
  })
  it('修订到阈值局部重写，计数丢失保留正文且祖先从干净摘要更新', async () => {
    const f = await layeredIncrementalFixture(template, reuseRoot), tree = await state(f)
    for (const topic of tree.topics) topic.revisions = 1
    await writeFile(path.join(f.root, 'state/topics.json'), JSON.stringify(tree))
    await writeFile(path.join(f.knowledgeRoot, '3.md'), '甲组下一次修订。')
    await buildLayeredLibrary({ ...f.options, topics: { ...treeSettings, topicMaxSources: 5, topicRewriteAfter: 2 } })
    expect(f.topicRequests.find(request => !request.input.children)!.input).toMatchObject({ mode: 'rebuild' })
    expect(f.topicRequests.every(request => !request.input.current_page)).toBe(true)
    const page = await readLayeredPage(f.knowledgeRoot, 'T-0001'), updated = await state(f)
    for (const topic of updated.topics) delete (topic as Partial<typeof topic>).revisions
    await writeFile(path.join(f.root, 'state/topics.json'), JSON.stringify(updated)); f.call.mockClear()
    expect(await buildLayeredLibrary({ ...f.options, topics: { ...treeSettings, topicMaxSources: 5, topicRewriteAfter: 2 } })).toMatchObject({ unchanged: true })
    expect(f.call).not.toHaveBeenCalled(); expect(await readLayeredPage(f.knowledgeRoot, 'T-0001')).toBe(page)
  })
  it('撤权立即屏蔽父页，重建后恢复；丢失主题状态可恢复层级', async () => {
    const f = await layeredIncrementalFixture(template, reuseRoot)
    await revokeLayeredSources(f.knowledgeRoot, ['S-0001'], '测试撤权')
    expect(await readLayeredPage(f.knowledgeRoot, 'T-0001')).toBe('更新中')
    await unlink(path.join(f.root, 'state/topics.json'))
    await buildLayeredLibrary({ ...f.options, topics: treeSettings })
    expect(await readLayeredPage(f.knowledgeRoot, 'T-0001')).toContain('## 子主题导航')
    expect((await state(f)).next_topic_number).toBe(2)
    expect(f.topicRequests.every(request => !request.input.current_page)).toBe(true)
  })
})

interface TermRequest { term_id: string; section_id: string; max_chars: number; contributions: { key: string; note: string }[] }
async function termFixture(template?: FixtureSnapshot, reuseRoot?: string) {
  const f = await layeredIncrementalFixture(template, reuseRoot), original = f.call.getMockImplementation()!, termRequests: TermRequest[] = []
  f.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
    const input = JSON.parse(args[2])
    if (input.term_id) {
      termRequests.push(input)
      return JSON.stringify({ definition: [{ text: '共同术语定义。', keys: input.contributions.map((item: { key: string }) => item.key) }], usage: [], findings: [], differences: [] })
    }
    const output = JSON.parse(await original(...args))
    if (!input.topic_id && !input.new_tags) output.terms = input.paragraphs.filter((part: { text: string }) => !part.text.startsWith('#')).map((part: { paragraph_id: number; locator: string; text: string }) => ({
      paragraph_id: part.paragraph_id, name: '共同术语', referent: '同一方法的稳定定义', category: '方法', aliases: ['共同别称'], locator: part.locator, note: `一句话：${part.text}`,
    }))
    return JSON.stringify(output)
  })
  return { ...f, termRequests }
}
const termSettings = { ...treeSettings, termMaxSources: 2, termThreshold50: 2 }
describe('术语分节', () => {
  let template: FixtureSnapshot, reuseRoot: string
  beforeAll(async () => {
    const f = await termFixture(); await files(f, 3)
    reuseRoot = f.knowledgeRoot
    await buildLayeredLibrary({ ...f.options, topics: termSettings }); template = await shareLayeredFixture(f)
  })
  it('按主题分节只送一句话，新增只重写受影响节，来源不足删综合页', async () => {
    const f = await termFixture(template, reuseRoot), old = await published<Dependencies>(f, 'deps.json')
    const record = Object.values(old.pages).flatMap(page => page.terms ?? [])[0]!
    expect(record.sections).toHaveLength(2)
    await writeFile(path.join(f.knowledgeRoot, '3.md'), '甲组新术语来源。')
    const result = await buildLayeredLibrary({ ...f.options, topics: { ...termSettings, topicMaxSources: 5 } })
    expect(f.termRequests).toHaveLength(1)
    expect(f.termRequests[0]!.contributions.every(item => Object.keys(item).sort().join(',') === 'key,note')).toBe(true)
    expect(f.termRequests[0]!.contributions).toHaveLength(1)
    const next = Object.values((await published<Dependencies>(f, 'deps.json')).pages).flatMap(page => page.terms ?? [])[0]!
    for (const section of record.sections) expect(next.sections.find(item => item.id === section.id)!.content).toBe(section.content)
    const depsAfter = await published<Dependencies>(f, 'deps.json'), costs = (await json<Record<string, CostReport>>(path.join(f.root, 'logs/costs.json')))[result.version]!
    const changedPages = Object.keys(depsAfter.pages).filter(page => JSON.stringify(depsAfter.pages[page]!.points) !== JSON.stringify(old.pages[page]?.points))
    const leaves = changedPages.filter(page => page.startsWith('topics/') && !depsAfter.pages[page]!.children?.length).length
    const sections = changedPages.filter(page => page.startsWith('terms/TM-') && page.includes('#')).length
    expect(costs.stages['提取']!.logical_tasks + costs.stages['主题']!.logical_tasks + costs.stages['术语']!.logical_tasks)
      .toBeLessThanOrEqual(costs.stages['提取']!.logical_tasks + leaves * (1 + termSettings.topicMaxDepth) + sections)
    f.termRequests.length = 0
    await Promise.all(['0.md', '1.md', '2.md'].map(file => unlink(path.join(f.knowledgeRoot, file))))
    await buildLayeredLibrary({ ...f.options, topics: { ...termSettings, topicMaxSources: 5 } })
    const deps = await published<Dependencies>(f, 'deps.json')
    expect(deps.pages['terms/TM-0001.md']).toBeUndefined(); expect(deps.pages['terms/index-01.md']).toBeDefined()
    expect(f.termRequests).toHaveLength(0)
  })
  it('跨节配额排队并在后续运行接续，撤权屏蔽术语节和父页', async () => {
    const f = await termFixture(template, reuseRoot)
    await writeFile(path.join(f.knowledgeRoot, '0.md'), '# 资料0\n\n甲组第一处修改。')
    await writeFile(path.join(f.knowledgeRoot, '2.md'), '# 资料2\n\n甲组第二处修改。')
    await buildLayeredLibrary({ ...f.options, topics: { ...termSettings, termSectionQuota: 1 } })
    expect(f.termRequests).toHaveLength(1)
    expect(await readLayeredPage(f.knowledgeRoot, 'terms/TM-0001.md')).toContain('已排队')
    f.termRequests.length = 0
    await buildLayeredLibrary({ ...f.options, topics: { ...termSettings, termSectionQuota: 1 } })
    expect(f.termRequests).toHaveLength(1)
    expect(await readLayeredPage(f.knowledgeRoot, 'terms/TM-0001.md')).not.toContain('已排队')
    const deps = await published<Dependencies>(f, 'deps.json'), section = deps.reverse_sources!['S-0001']!.find(page => page.startsWith('terms/TM-') && page.includes('#'))!
    await revokeLayeredSources(f.knowledgeRoot, ['S-0001'], '撤权分节')
    expect(await readLayeredPage(f.knowledgeRoot, section)).toBe('更新中')
    expect(await readLayeredPage(f.knowledgeRoot, 'T-0001')).toBe('更新中')
    await buildLayeredLibrary({ ...f.options, topics: termSettings })
    expect(await readLayeredPage(f.knowledgeRoot, 'terms/TM-0001.md')).not.toContain('S-0001@')
    expect(await readLayeredPage(f.knowledgeRoot, 'T-0001')).not.toBe('更新中')
  })
  it('门槛按档位，低档只生成程序索引，无来源后删除条目', async () => {
    const f = await termFixture(); await files(f, 2)
    const result = await buildLayeredLibrary({ ...f.options, tier: 25 })
    expect(f.termRequests).toHaveLength(0)
    expect(await readLayeredPage(f.knowledgeRoot, 'terms/index-01.md')).toContain('共同别称')
    expect((await published<Dependencies>(f, 'deps.json')).pages['terms/TM-0001.md']).toBeUndefined()
    expect((await json<Record<string, CostReport>>(path.join(f.root, 'logs/costs.json')))[result.version]!.stages['术语']!.logical_tasks).toBe(0)
    await Promise.all(['0.md', '1.md'].map(file => unlink(path.join(f.knowledgeRoot, file))))
    await buildLayeredLibrary({ ...f.options, tier: 25 })
    expect(Object.keys((await published<Dependencies>(f, 'deps.json')).pages).filter(page => page.startsWith('terms/'))).toEqual([])
  })
  it('原文别称直接合并，相似向量合并，阈值以下保持独立', async () => {
    const f = await termFixture(), original = f.call.getMockImplementation()!
    await files(f, 4)
    f.embed.mockImplementation(async texts => texts.map(text => text.includes('远义词') ? [-1, 0]
      : text.includes('别词') ? [0.6, 0.8] : text.includes('近义词') ? [Math.sqrt(0.8), Math.sqrt(0.2)] : [1, 0]))
    f.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
      const input = JSON.parse(args[2]), output = JSON.parse(await original(...args))
      if (input.source_id) {
        const index = Number(input.source_id.slice(2)) - 1
        output.terms[0].name = ['原词', '别词', '近义词', '远义词'][index]
        output.terms[0].aliases = index < 2 ? ['原文共同别称'] : []
      }
      return JSON.stringify(output)
    })
    await buildLayeredLibrary(f.options)
    const records = Object.values((await published<Dependencies>(f, 'deps.json')).pages).flatMap(page => page.terms ?? [])
    expect(records.map(record => record.contributions.length).sort()).toEqual([1, 3])
    expect(f.termRequests).toHaveLength(0)
    // 四篇各首提和核对一次，主题综合及核对后归并标签。
    expect(f.call.mock.calls.filter(call => !JSON.parse(call[2]).label_stage).map(call => { const input = JSON.parse(call[2]); return ['source_id', 'topic_id', 'term_id', 'new_tags'].find(key => input[key]) })).toEqual([...Array(8).fill('source_id'), 'topic_id', 'topic_id', 'new_tags']) // 含补标/探针调用；原有阶段的顺序仍精确匹配。
    expectModelCalls(f.call, { extraction: 4, review: 5, topic: 1, merge: 1 })
  })
  it('分层设置可导入导出，默认门槛与架构一致且旧库无分层默认改动', () => {
    const settings = layeredSettings()
    expect([settings.termThreshold50, settings.termThreshold75, settings.termThreshold100]).toEqual([5, 3, 2])
    expect([5, 25, 50, 75, 100, 30].map(tier => termSynthesisThreshold(tier, settings))).toEqual([Infinity, Infinity, 5, 3, 2, 5])
    expect(() => layeredSettings({ topicMaxChildren: 1 })).toThrow()
    const registry = emptyRegistry(), library = newLibrary('设置')
    library.id = 'config'; library.wikiPath = 'E:/test/wiki'; library.layered = { ...settings, topicMaxDepth: 2, termSectionQuota: 3 }
    registry.libraries.push(library)
    expect(importConfig(exportConfig(registry), emptyRegistry(), 'replace').libraries[0]!.layered).toEqual(library.layered)
    expect(newLibrary('legacy').layered).toBeUndefined()
  })
})

describe('预算与恢复边界', () => {
  it('输入预算触发内部拆分，模型从不接收超限输入', async () => {
    const f = await layeredIncrementalFixture(); await files(f, 2)
    // 短编号节省了输入空间，扩充事实使夹具仍实际触及同一个预算边界。
    for (let index = 0; index < 2; index++) await writeFile(path.join(f.knowledgeRoot, `${index}.md`), `# 资料${index}\n\n` + '甲组完整研究结论。'.repeat(5))
    const options = { ...f.options, topics: { topicMergeMinSources: 1, leafInputBudget: 1400, topicMaxSources: 20 } }
    await buildLayeredLibrary(options)
    expect((await state(f)).topics.length).toBeGreaterThan(1)
    for (const request of f.topicRequests.filter(request => !request.input.children)) expect(Buffer.byteLength(request.system + JSON.stringify(request.input))).toBeLessThanOrEqual(1400)
  })
  it('输出页长超限拆为子主题，叶页正文最终在上限内', async () => {
    const f = await layeredIncrementalFixture(), original = f.call.getMockImplementation()!
    await files(f, 2)
    f.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
      const input = JSON.parse(args[2]), output = JSON.parse(await original(...args))
      if (input.points?.length > 1) output.conditions[0].text = '充分说明'.repeat(300)
      return JSON.stringify(output)
    })
    await buildLayeredLibrary({ ...f.options, topics: { topicMergeMinSources: 1, topicMaxChars: 700 } })
    const tree = await state(f)
    expect(tree.topics).toHaveLength(3)
    for (const topic of tree.topics.filter(topic => topic.parent_id)) {
      const page = await readLayeredPage(f.knowledgeRoot, topic.path)
      expect(page.slice(page.indexOf('\n---\n') + 5).length).toBeLessThanOrEqual(700)
    }
  })
  it('术语正文超长按主题继续分节，失败尝试不增加逻辑任务数', async () => {
    const f = await termFixture(), original = f.call.getMockImplementation()!
    await files(f, 2)
    f.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
      const input = JSON.parse(args[2]), output = JSON.parse(await original(...args))
      if (input.term_id && input.contributions.length > 1) output.definition[0].text = '超长定义'.repeat(300)
      return JSON.stringify(output)
    })
    const result = await buildLayeredLibrary({ ...f.options, topics: { termMaxChars: 600, termThreshold50: 2 } })
    const record = Object.values((await published<Dependencies>(f, 'deps.json')).pages).flatMap(page => page.terms ?? [])[0]!
    expect(record.sections).toHaveLength(2); expect(record.sections.every(section => section.content.length <= 600)).toBe(true)
    const costs = (await json<Record<string, CostReport>>(path.join(f.root, 'logs/costs.json')))[result.version]!
    expect(costs.stages['术语']).toMatchObject({ logical_tasks: 2, actual_calls: 3 })
    f.call.mockClear()
    expect(await buildLayeredLibrary({ ...f.options, topics: { termMaxChars: 600, termThreshold50: 2 } })).toMatchObject({ unchanged: true })
    expect(f.call).not.toHaveBeenCalled()
  })
  it('术语分节中断后复用完成节，下一节不读取旧正文', async () => {
    const f = await termFixture(), original = f.call.getMockImplementation()!
    await files(f, 3)
    f.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
      if (JSON.parse(args[2]).term_id && f.termRequests.length === 1) throw Object.assign(new Error('模拟第二节中断'), { name: 'AbortError' })
      return original(...args)
    })
    await expect(buildLayeredLibrary({ ...f.options, topics: termSettings })).rejects.toThrow('模拟第二节中断')
    const first = f.termRequests[0]!.section_id
    f.call.mockImplementation(original); f.termRequests.length = 0
    await buildLayeredLibrary({ ...f.options, topics: termSettings })
    expect(f.termRequests).toHaveLength(1); expect(f.termRequests[0]!.section_id).not.toBe(first)
    expect(f.termRequests[0]).not.toHaveProperty('current_page')
  })
})

describe('层级结构约束', () => {
  it('收缩只选最近兄弟且保留来源较多的 ID，深层目录和编号单调', () => {
    const tree: TopicState = { format_version: 1, version: null, next_topic_number: 1, topics: [], vectors: {}, embedding: { url: 'mock', model: 'mock' } }
    const reserved = new Set<string>(), parent = newTopic(tree, undefined, reserved)
    const small = newTopic(tree, parent, reserved), nearest = newTopic(tree, parent, reserved), distant = newTopic(tree, parent, reserved)
    const fill = (topic: typeof parent, ids: string[], vector: number[]) => {
      topic.point_ids = ids.map(id => `${id}:hash:01`)
      for (const id of topic.point_ids) tree.vectors[id] = { input_hash: id, vector }
    }
    fill(small, ['S-0001', 'S-0002'], [1, 0]); fill(nearest, ['S-0003', 'S-0004'], [1, 0]); fill(distant, ['S-0005', 'S-0006', 'S-0007'], [0, 1])
    refreshTree(tree)
    const previous = structuredClone(tree); small.point_ids.pop(); refreshTree(tree)
    const aliases: Record<string, string> = {}
    expect([...mergeShrunken(tree, previous, 2, aliases)]).toEqual([nearest.path])
    expect(aliases).toEqual({ [small.id]: nearest.id }); expect(nearest.sources).toHaveLength(3)
    const leaves = splitTopic(tree, nearest, layeredSettings({ topicMaxDepth: 2, topicMergeMinSources: 1 }), reserved)
    expect(leaves[0]!.path).toBe('topics/T-0001/T-0001-02/T-0001-02-01.md')
    expect(leaves[1]!.id).toBe('T-0001-02-02')
    const next = newTopic(tree, parent, reserved)
    expect(next.id).toBe('T-0001-04')
  })
})
