import { mockSupportReview } from './layered-fixture.js'
import { pinVersion } from '../src/layered/retention.js'
import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { extractSource } from '../src/layered/extraction.js'
import { validatePublication } from '../src/layered/publication.js'
import type { Extraction } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, layeredFixture, modelOutput, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
beforeEach(() => vi.stubGlobal('fetch', () => { throw new Error('离线回归禁止网络请求') }))
afterEach(() => { cleanupLayeredFixtures(); vi.unstubAllGlobals() })

const baseline = JSON.parse(await readFile(new URL('./baselines/layered-longdoc-2c87b84.json', import.meta.url), 'utf8'))
const points = (result: Extraction) => result.segments.flatMap(segment => segment.points)
const book = (count: number) => '# 合成长书\n\n' + Array.from({ length: count }, (_, index) =>
  `## 第${index + 1}章\n\n第${index + 1}章结论成立。\n${'正文事实与条件。'.repeat(88)}\n`).join('\n')
async function extraction(root: string) {
  const manifest = await snapshotManifest(root), entry = manifest.sources[0]!
  const bytes = await readFile(path.join(root, entry.extract.path), 'utf8')
  return { manifest, entry, bytes, result: JSON.parse(bytes) as Extraction }
}
async function fixture() {
  const f = await layeredFixture(), requests: any[] = []
  f.options.maxInputBytes = 6500
  f.call.mockImplementation(async (_task, _system, input) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(input))
    if (support) return support
    const request = JSON.parse(input)
    if (request.new_tags) return JSON.stringify({ groups: [] })
    requests.push(request)
    if (request.summary_id) return JSON.stringify({ point_ids: request.children.flatMap((child: any) => child.points.map((point: any) => point.point_id)).slice(0, request.point_limit) })
    const parts = request.paragraphs.filter((part: any) => !/^#{1,6}\s/.test(part.text ?? request.evidence_dictionary[part.evidence_ref].quote))
    const points = Array.from({ length: parts.length ? request.point_limit : 0 }, (_, index) => {
      const part = parts[index % parts.length], quote = (part.text ?? request.evidence_dictionary[part.evidence_ref].quote).split('\n')[0]
      const line = part.locator.split('-')[0]
      return { paragraph_id: part.paragraph_id, text: quote + index, section: '主要发现', evidence: [{ locator: `${line}-${line}`, quote }] }
    })
    return JSON.stringify({ tags: ['研究方法', '研究对象', '核心主题'], credibility: 'low', credibility_reason: '离线回归', points, terms: [], summary_point_indices: points.slice(0, request.summary_point_limit ?? 8).map((_, index) => index) })
  })
  await writeFile(path.join(f.knowledgeRoot, 'book.md'), book(9), 'utf8')
  return { ...f, requests }
}

it('升级1：2c87b84 旧格式夹具明确要求重建且保留全部原字节', async () => {
  expect(baseline.commit).toBe('2c87b84')
  const f = await layeredFixture()
  for (const [name, text] of Object.entries(baseline.files)) {
    const file = path.join(f.knowledgeRoot, name)
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text as string, 'utf8')
  }
  await expect(buildLayeredLibrary(f.options)).rejects.toThrow('请重建')
  expect(f.call).not.toHaveBeenCalled()
  for (const [name, text] of Object.entries(baseline.files)) expect(await readFile(path.join(f.knowledgeRoot, name), 'utf8')).toBe(text)
})

it('升级2：短文请求提示、输入和结构化 Schema 与新协议固定夹具字节一致', async () => {
  // 输出协议有意升级；历史迁移夹具不变，新协议继续逐字节比较提示、输入与 Schema。
  const f = await layeredFixture(), expected = { ...baseline.request, ...JSON.parse(await readFile(new URL('./baselines/layered-protocol-v3.json', import.meta.url), 'utf8')) }
  f.call.mockImplementation(async (_task, system, input, _signal, _images, options) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(input))
    if (support) return support
    expect(system).toBe(expected.system); expect(input).toBe(expected.input)
    expect(options?.structuredSchema).toEqual(expected.schema)
    return modelOutput(JSON.parse(input))
  })
  await extractSource(f.root, 'S-0001', { ...expected.source, bytes: Buffer.from(expected.source.text) },
    { tier: 50, prompt_version: 'layered-extract-v3', model: 'mock/extractor' }, f.options, 98304)
  expect(f.call).toHaveBeenCalledTimes(1)
})

it('发布1：章节底线超额仍保留五条已发布要点并登记缺口', async () => {
  const f = await fixture(); f.options.tier = 5
  // 极简默认无底线；本用例显式覆盖以继续验证底线冲突的既有行为。
  f.options.topics = { sourceChapterMinPoints: 1 }; f.options.embeddingClient = { identity: async () => 'fixture', embed: async texts => texts.map(() => [1, 0]) }
  await writeFile(path.join(f.knowledgeRoot, 'book.md'), book(5), 'utf8')
  await buildLayeredLibrary(f.options); const before = await extraction(f.root)
  await writeFile(path.join(f.knowledgeRoot, 'book.md'), book(6), 'utf8')
  await buildLayeredLibrary(f.options); const after = await extraction(f.root)
  expect(points(after.result).map(point => point.point_id)).toEqual(points(before.result).map(point => point.point_id))
  expect(after.result.gaps?.some(gap => gap.reasons.some(reason => reason.rule === 'chapter-quota'))).toBe(true)
  await validatePublication(f.root, after.manifest.version!)
})

it.each(['group', 'summary'] as const)('重试：已发布的 %s 失败可恢复，旧版成果字节不变', async kind => {
  const f = await fixture(), original = f.call.getMockImplementation()!
  let round = 0
  f.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
    const request = JSON.parse(args[2])
    if (round < 2 && (kind === 'summary' ? request.summary_id : request.paragraphs?.some((part: any) =>
      part.text?.includes('第3章结论') || round === 0 && part.text?.includes('第2章结论')))) throw new Error('临时失败')
    return original(...args)
  })
  await buildLayeredLibrary(f.options); const before = await extraction(f.root), pinned = await pinVersion(f.root)
  expect(before.result.summary?.missing.length).toBeGreaterThan(0)
  if (kind === 'group') {
    // 已发布缺口不再自动重做；用户显式重试缺口后才重新提取。
    round = 1; await buildLayeredLibrary({ ...f.options, retryGaps: true })
    const middle = await extraction(f.root)
    expect(middle.result.summary!.missing.length).toBeGreaterThan(0)
    expect(points(middle.result).some(point => point.text.includes('第2章'))).toBe(true)
  }
  round = 2; f.requests.length = 0
  await buildLayeredLibrary({ ...f.options, retryGaps: true }); const after = await extraction(f.root)
  expect(after.result.gaps).toEqual([]); expect(after.result.summary?.missing).toEqual([])
  expect(points(after.result)).toHaveLength(50)
  expect(f.requests.filter(request => request.paragraphs)).toHaveLength(kind === 'group' ? 1 : 0)
  expect(f.requests.some(request => request.summary_id)).toBe(true)
  expect(await readFile(path.join(f.root, before.entry.extract.path), 'utf8')).toBe(before.bytes)
  await validatePublication(f.root, before.manifest.version!); await validatePublication(f.root, after.manifest.version!); pinned.release()
  f.requests.length = 0
  expect((await buildLayeredLibrary(f.options)).unchanged).toBe(true); expect(f.requests).toEqual([])
})

it('已发布 group 缺口在普通生成、其他来源增量中原样保留且不重提；来源内容变化照常重提', async () => {
  const f = await fixture(), original = f.call.getMockImplementation()!
  let failing = true
  f.call.mockImplementation(async (...args) => {
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
    if (failing && JSON.parse(args[2]).paragraphs?.some((part: any) => part.text?.includes('第3章结论'))) throw new Error('临时失败')
    return original(...args)
  })
  await buildLayeredLibrary(f.options); const before = await extraction(f.root)
  expect(before.result.gaps?.some(gap => gap.kind === 'group')).toBe(true)
  // 重新生成：带缺口的来源沿用已发布成果，零提取调用，缺口仍公开。
  f.requests.length = 0
  await buildLayeredLibrary(f.options); const again = await extraction(f.root)
  expect(f.requests.filter(request => request.paragraphs)).toHaveLength(0)
  expect(again.entry.extract.path).toBe(before.entry.extract.path)
  expect(again.result.gaps?.some(gap => gap.kind === 'group')).toBe(true)
  // 只新增另一篇来源：带缺口来源仍零提取调用。
  await writeFile(path.join(f.knowledgeRoot, 'other.md'), '# 另一篇\n\n另一篇的结论成立。\n', 'utf8')
  f.requests.length = 0
  await buildLayeredLibrary(f.options)
  const extracted = f.requests.filter(request => request.paragraphs)
  expect(extracted.length).toBeGreaterThan(0)
  expect(extracted.every(request => request.source_id !== before.entry.source_id)).toBe(true)
  // 来源内容变化：照常重提（未变章节可复用组缓存），缺口随之重做。
  failing = false
  await writeFile(path.join(f.knowledgeRoot, 'book.md'), book(5), 'utf8')
  f.requests.length = 0
  await buildLayeredLibrary(f.options); const changed = await extraction(f.root)
  expect(changed.entry.extract.path).not.toBe(before.entry.extract.path)
  expect(changed.result.gaps?.some(gap => gap.kind === 'group')).toBe(false)
})

it('重试缺口中途中断后，不带重试参数继续仍按重试处理，完成后缺口消失', async () => {
  const f = await fixture(), original = f.call.getMockImplementation()!
  let failing = true, interrupt: AbortController | undefined
  f.call.mockImplementation(async (...args) => {
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
    const request = JSON.parse(args[2])
    // 模拟用户在重试缺口的提取调用进行中取消。
    if (interrupt && request.paragraphs) { const controller = interrupt; interrupt = undefined; controller.abort(new Error('用户取消')); controller.signal.throwIfAborted() }
    if (failing && request.paragraphs?.some((part: any) => part.text?.includes('第3章结论'))) throw new Error('临时失败')
    return original(...args)
  })
  await buildLayeredLibrary(f.options); const before = await extraction(f.root)
  expect(before.result.gaps?.some(gap => gap.kind === 'group')).toBe(true)
  failing = false; interrupt = new AbortController()
  await expect(buildLayeredLibrary({ ...f.options, retryGaps: true, signal: interrupt.signal })).rejects.toThrow('用户取消')
  // 继续时不再传 retryGaps：意图来自未完成作业。
  f.requests.length = 0
  await buildLayeredLibrary(f.options); const after = await extraction(f.root)
  expect(f.requests.some(request => request.paragraphs)).toBe(true)
  expect(after.result.gaps?.some(gap => gap.kind === 'group')).toBe(false)
  // 发布后意图随作业结束；再次普通生成零提取。
  f.requests.length = 0
  await buildLayeredLibrary(f.options)
  expect(f.requests.filter(request => request.paragraphs)).toHaveLength(0)
})
