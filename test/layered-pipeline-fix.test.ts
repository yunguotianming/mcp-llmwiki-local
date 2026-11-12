import { mockSupportReview } from './layered-fixture.js'
import { readFile, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { emptyRegistry, layeredSettings, newLibrary } from '../src/domain/config.js'
import { exportConfig, importConfig } from '../src/domain/config-io.js'
import { buildLayeredLibrary, layeredInputBudget, readLayeredPage } from '../src/layered/index.js'
import { prepareTopics } from '../src/layered/topics.js'
import { extractSource, planExtraction } from '../src/layered/extraction.js'
import { readLocalSource } from '../src/layered/snapshot.js'
import { sourceQuotas } from '../src/layered/longdoc.js'
import type { Extraction, PendingBuild, SnapshotManifest } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, hydratedState, layeredTopicFixture, mockFixtureSync, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('续做丢弃失效成员并重算，内容改变指纹，新点增量处理且未变主题身份和页面保持', async () => {
  const f = await layeredTopicFixture(), original = f.call.getMockImplementation()!
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 资料甲\n\n甲组证据。')
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '# 资料乙\n\n乙组证据。')
  const options = { ...f.options, client: { info: f.client.info.bind(f.client), call: f.call, concurrency: () => 1 } }
  f.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
    if (JSON.parse(args[2]).topic_id === 'T-0001') throw Object.assign(new Error('模拟中断'), { name: 'AbortError' })
    return original(...args)
  })
  await expect(buildLayeredLibrary(options)).rejects.toThrow('模拟中断')
  const pending = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
  const committed: SnapshotManifest = { format_version: pending.manifest.format_version, version: null, next_source_number: 1, revocation_generation: 0, sources: [] }
  f.call.mockImplementation(original)
  await prepareTopics(f.root, pending, committed, options, undefined)
  const fingerprint = pending.topics!.fingerprint, stable = structuredClone(pending.topics!.state.topics.find(topic => topic.id === 'T-0002')!)
  const page = pending.topics!.pages[stable.path]!.content, entry = pending.manifest.sources[0]!
  const extraction = JSON.parse(await readFile(path.join(f.root, entry.extract.path), 'utf8')) as Extraction
  const segment = extraction.segments.find(segment => segment.points.length)!, removed = segment.points.shift()!
  segment.points[0]!.text += ' 补充条件。'
  const added = { ...structuredClone(removed), point_id: removed.point_id.replace(/:[^:]+$/, ':900'), text: '甲组新增证据。' }
  segment.points.push(added)
  entry.extract.path = entry.extract.path.replace('.json', '-retry.json')
  await writeFile(path.join(f.root, entry.extract.path), JSON.stringify(extraction))
  f.topicRequests.splice(0)
  await prepareTopics(f.root, pending, committed, options, undefined)
  expect(pending.topics!.fingerprint).not.toBe(fingerprint)
  expect(pending.topics!.state.topics.flatMap(topic => topic.point_ids)).not.toContain(removed.point_id)
  expect(pending.topics!.state.topics.flatMap(topic => topic.point_ids)).toContain(added.point_id)
  expect(f.topicRequests.map(request => request.input.topic_id)).toEqual(['T-0001'])
  expect(pending.topics!.state.topics.find(topic => topic.id === stable.id)).toEqual(stable)
  expect(pending.topics!.pages[stable.path]!.content).toBe(page)
  const changed = pending.topics!.fingerprint
  segment.points[0]!.text += ' 再补条件。'
  entry.extract.path = entry.extract.path.replace('.json', '-content.json')
  await writeFile(path.join(f.root, entry.extract.path), JSON.stringify(extraction))
  await prepareTopics(f.root, pending, committed, options, undefined)
  expect(pending.topics!.fingerprint).not.toBe(changed)
})

it('主题来源前缀错绑只纠正编号，成功发布且原主张逐字不变', async () => {
  const f = await layeredTopicFixture(), original = f.call.getMockImplementation()!, inputs: any[] = []
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 资料\n\n甲组证据。')
  let initial: any
  f.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
    const request = JSON.parse(args[2])
    if (!request.topic_id) return original(...args)
    inputs.push(request)
    if (request.validationFeedback) {
      const corrected = structuredClone(request.validationFeedback.original)
      corrected.conditions[0].point_ids = [request.points[0].point_id]
      return JSON.stringify(corrected)
    }
    initial = JSON.parse(await original(...args))
    initial.conditions[0].point_ids = ['S-0015:' + initial.conditions[0].point_ids[0]]
    return JSON.stringify(initial)
  })
  await buildLayeredLibrary(f.options)
  expect(inputs).toHaveLength(2)
  expect(inputs[1].validationFeedback.error).toContain('S-0015:')
  expect(inputs[1].validationFeedback.original).toEqual(initial)
  expect(await readLayeredPage(f.knowledgeRoot, 'topics/T-0001.md')).toContain(initial.conditions[0].text)
  expect((await snapshotManifest(f.root)).topic_gaps).toEqual([])
})

it('主题两次纠正改主张仍失败则记缺口，其他主题发布且失败成员完整留源', async () => {
  const f = await layeredTopicFixture(), original = f.call.getMockImplementation()!, attempts: any[] = []
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 甲资料\n\n甲组证据。')
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '# 乙资料\n\n乙组证据。')
  f.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
    const request = JSON.parse(args[2])
    if (request.topic_id !== 'T-0001') return original(...args)
    attempts.push(request)
    const output = request.validationFeedback ? structuredClone(request.validationFeedback.original) : JSON.parse(await original(...args))
    output.conditions[0].point_ids = [request.validationFeedback ? request.points[0].point_id : 'S-0015:不存在']
    if (request.validationFeedback) output.conditions[0].text = '擅自改变主张。'
    return JSON.stringify(output)
  })
  await buildLayeredLibrary(f.options)
  const manifest = await snapshotManifest(f.root)
  expect(attempts).toHaveLength(3)
  expect(attempts[2].validationFeedback.error).toContain('不得改变')
  expect(manifest.topic_gaps).toHaveLength(1)
  expect(manifest.topic_gaps![0]).toMatchObject({ topic_id: 'T-0001', message: expect.stringContaining('不得改变') })
  expect(manifest.pages).not.toHaveProperty('topics/T-0001.md')
  expect(manifest.pages).toHaveProperty('topics/T-0002.md')
  expect(await readLayeredPage(f.knowledgeRoot)).toContain('主题缺口 T-0001')
  const extraction = JSON.parse(await readFile(path.join(f.root, manifest.sources[0]!.extract.path), 'utf8')) as Extraction
  const points = extraction.segments.flatMap(segment => segment.points)
  expect(manifest.topic_gaps![0]!.point_ids).toEqual(points.map(point => point.point_id).sort())
  const sourcePage = await readLayeredPage(f.knowledgeRoot, 'sources/S-0001.md')
  for (const point of points) expect(sourcePage).toContain(point.text)
})

it('整篇用足上限，超限章节顺序打包且保留正文、短章、章节归属与摘要规则', async () => {
  const f = await layeredTopicFixture(), file = path.join(f.knowledgeRoot, 'paper.md')
  const text = '# 论文\n\n' + Array.from({ length: 30 }, (_, i) => `## 章节${i}\n\n${i}：研究结论成立。${String(i).repeat(210)}\n\n`).join('') + '## Funding\n\n' + '资助研究的方法信息完整保留。'.repeat(50)
  await writeFile(file, text)
  const source = await readLocalSource(file, '论文'), processing = { tier: 50 as const, granularity: 'custom' as const, prompt_version: '测试', model: 'mock' }
  const requests: { system: string; input: any }[] = []
  // 原整篇预算和31点夹具显式保留额度，主动分包/短文降额另验。
  const packing = layeredSettings({ sourcePackRatio: 0 })
  const options = { ...f.options, topics: { sourcePackRatio: 0 }, client: { info: f.client.info.bind(f.client), concurrency: () => 1,
    call: async (_task: any, system: string, input: string) => {
      const request = JSON.parse(input); requests.push({ system, input: request })
      if (request.summary_id) return JSON.stringify({ point_ids: request.children.flatMap((child: any) => child.points.map((point: any) => point.point_id)).slice(0, request.point_limit) })
      if (request.chapters) return JSON.stringify({ chapters: request.chapters.map((chapter: any) => ({ chapter_id: chapter.chapter_id, points: [] })) })
      if (request.coverage) return JSON.stringify({ tags: [], credibility: 'low', credibility_reason: '测试', points: [], terms: [] })
      const points = request.paragraphs.filter((part: any) => !part.text.startsWith('#')).map((part: any) => ({ paragraph_id: part.paragraph_id, section: '主要发现', text: part.text,
        evidence: [{ locator: part.locator, quote: part.text }] }))
      return JSON.stringify({ tags: ['研究方法', '研究对象', '核心主题'], credibility: 'low', credibility_reason: '测试', points, terms: [], summary_point_indices: points.map((_: any, i: number) => i).slice(0, 8) })
    } } }
  let low = 4000, high = 98304
  while (low < high) { const mid = Math.floor((low + high) / 2); if (planExtraction('S-0001', source, processing, mid, packing).length === 1) high = mid; else low = mid + 1 }
  const whole = await extractSource(f.root, 'S-0001', source, processing, options, high)
  expect(requests).toHaveLength(1)
  expect(Buffer.byteLength(requests[0]!.system + JSON.stringify(requests[0]!.input))).toBeGreaterThan(high * 0.9)
  expect(whole.segments.flatMap(segment => segment.points)).toHaveLength(31)
  requests.splice(0)
  const plan = planExtraction('S-0001', source, processing, 6500, packing), allocation = sourceQuotas(source, plan, 50, layeredSettings())
  expect(plan.length).toBeGreaterThan(1); expect(plan.length).toBeLessThan(15)
  expect(plan.flat().map(part => part.paragraph_id)).toEqual(source.segments.map((_, i) => i))
  expect(plan.flat().map(part => part.text).join('')).toBe(source.segments.map(segment => text.slice(segment.start, segment.end)).join(''))
  // 新规则允许资助声明零配额，研究章节仍全部保留原正配额断言。
  expect(allocation.chapters.filter(chapter => !['论文', 'Funding'].includes(chapter.title)).every(chapter => chapter.quota > 0)).toBe(true)
  expect(allocation.chapters.find(chapter => chapter.title === 'Funding')!.quota).toBeGreaterThanOrEqual(0)
  for (const parts of plan.slice(0, -1)) expect(parts.filter(part => !part.text.startsWith('#')).length).toBeGreaterThan(1)
  const split = await extractSource(f.root, 'S-0001', source, processing, options, 6500)
  expect(split.gaps).toEqual([])
  expect(split.segments.flatMap(segment => segment.points)).toHaveLength(31)
  for (const chapter of split.chapters!.filter(chapter => chapter.title !== '论文')) expect(chapter.paragraph_ids.flatMap(id => split.segments[id]!.points)).toHaveLength(1)
  expect(split.summary!.point_ids.length).toBeGreaterThan(0)
  for (const request of requests) expect(Buffer.byteLength(request.system + JSON.stringify(request.input))).toBeLessThanOrEqual(6500)
  expect(await layeredInputBudget({ client: { ...options.client, inputBudget: async () => 12000 }, maxInputBytes: 98304 })).toBe(12000)
})

it('默认并入0.60而显式0.55保留，Windows建库清除已有Hidden且重复建库保持可见', async () => {
  expect(layeredSettings().topicAttachThreshold).toBe(0.60)
  const registry = emptyRegistry(), library = newLibrary('explicit')
  library.wikiPath = path.join(process.env.TEMP!, 'explicit-policy'); library.layered = { topicAttachThreshold: 0.55 }; registry.libraries.push(library)
  const imported = importConfig(exportConfig(registry), emptyRegistry(), 'replace')
  expect(layeredSettings(imported.libraries[0]!.layered).topicAttachThreshold).toBe(0.55)
  const f = await layeredTopicFixture()
  mockFixtureSync(f.knowledgeRoot, true)
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 资料\n\n甲组证据。')
  await buildLayeredLibrary(f.options)
  // Hidden 是 Windows 文件属性；其他平台仍验证建库和设置，只不执行属性专属断言。
  if (process.platform === 'win32') {
    const attrs = async () => (await promisify(execFile)('attrib.exe', [f.root], { windowsHide: true })).stdout.match(/^([A-Z ]+)(?:[A-Za-z]:\\|\\\\)/)![1]!
    expect(await attrs()).not.toContain('H')
    await promisify(execFile)('attrib.exe', ['+H', f.root], { windowsHide: true })
    expect(await attrs()).toContain('H')
    await buildLayeredLibrary(f.options)
    expect(await attrs()).not.toContain('H')
  }
})
