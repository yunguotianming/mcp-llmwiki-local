import * as filesystem from 'node:fs/promises'
import type { BigIntStats } from 'node:fs'
import { closeSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, rmdirSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterAll, expect, vi } from 'vitest'
import { readCurrent, readManifest } from '../src/layered/publication.js'
import { readVersion, versionPage } from '../src/layered/objects.js'
import { hydrateVectors } from '../src/layered/vectors.js'
import * as retention from '../src/layered/retention.js'
import * as storageFiles from '../src/storage/files.js'
import { stringify } from 'yaml'
import { ModelClient } from '../src/llm/client.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { newLibrary } from '../src/domain/config.js'
import { defaultPolicy } from '../src/domain/policy.js'
import type { BuildLayeredOptions, SnapshotManifest } from '../src/layered/schema.js'
import { parseModelJson } from '../src/llm/json.js'

// 旧反例继续逐项构造错误；只把响应封装为新批协议，实际客户端调用次数仍由原 spy 统计。
export function batchModel(call: BuildLayeredOptions['client']['call']): BuildLayeredOptions['client']['call'] {
  return async (...args) => {
    const data = JSON.parse(args[2])
    if (!data.correction_stage) return call(...args)
    const items = []
    for (const item of data.items) {
      const raw = await call(args[0], args[1], JSON.stringify({ source_id: data.source_id, ...item }), args[3], args[4], args[5])
      let output: any
      try { output = parseModelJson(raw) } catch { return raw }
      output = output.validationFeedback?.item ?? output
      items.push({ ...output, id: item.id })
    }
    return JSON.stringify({ items })
  }
}

// 含补标/探针调用：文本阶段逐项精确计数，向量探针由嵌入 spy 单独核验。
export function expectModelCalls(call: { mock: { calls: Parameters<BuildLayeredOptions['client']['call']>[] } }, expected: Record<string, number>) {
  const counts: Record<string, number> = {}
  for (const args of call.mock.calls) {
    const input = JSON.parse(args[2])
    const stage = input.label_stage ? 'labels' : input.review_stage ? 'review' : input.correction_stage || input.validationFeedback ? 'correction'
      : input.summary_id ? 'summary' : input.new_tags ? 'merge' : input.topic_id ? 'topic' : input.term_id ? 'term' : 'extraction'
    counts[stage] = (counts[stage] ?? 0) + 1
  }
  expect(counts).toEqual(expected)
}

const temporaryRoots: string[] = []
const open = filesystem.open
const realpath = filesystem.realpath
const originalReadFile = filesystem.readFile
const originalWriteFile = filesystem.writeFile
const originalMkdir = filesystem.mkdir, originalReaddir = filesystem.readdir, originalRename = filesystem.rename
const originalStat = filesystem.stat, originalUnlink = filesystem.unlink
const originalLstat = filesystem.lstat, originalRm = filesystem.rm
const fixturePaths = new Set<string>()
const resolvedFixturePaths = new Map<string, string>()
const fixtureMembership = new Map<string, boolean>()
function resolvedFixturePath(file: unknown): string {
  const key = String(file)
  let resolved = resolvedFixturePaths.get(key)
  if (resolved === undefined) { resolved = path.resolve(key); resolvedFixturePaths.set(key, resolved) }
  return resolved
}
const fixtureDescriptors = new Map<string, PropertyDescriptor>()
const collectGarbage = retention.collectGarbage
const clearHiddenAttribute = storageFiles.clearHiddenAttribute
const readCache = new Map<string, { metadata: BigIntStats; bytes: Buffer; text?: string }>()
// 普通 getter 不记录调用历史；故障用例仍可在返回的函数上再次 spy。
function fixtureFunction<K extends keyof typeof filesystem>(name: K, implementation: typeof filesystem[K]): void {
  if (!fixtureDescriptors.has(name)) fixtureDescriptors.set(name, Object.getOwnPropertyDescriptor(filesystem, name)!)
  Object.defineProperty(filesystem, name, { configurable: true, enumerable: true, get: () => implementation })
}
export interface FixtureSnapshot { directories: readonly string[]; files: ReadonlyMap<string, Buffer> }
// 保存已建库文件的只读字节，复制到空目录时省去 cp 对每个路径的重复 stat/realpath。
export async function snapshotFixture(root: string): Promise<FixtureSnapshot> {
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const relative = (entry: typeof entries[number]) => path.relative(root, path.join(entry.parentPath, entry.name))
  return { directories: entries.filter(entry => entry.isDirectory()).map(relative),
    files: new Map(await Promise.all(entries.filter(entry => entry.isFile()).map(async entry => [relative(entry), await readFile(path.join(root, relative(entry)))] as const))) }
}
export async function restoreFixture(snapshot: FixtureSnapshot, root: string): Promise<void> {
  await mkdir(root, { recursive: true })
  const entries = await readdir(root, { recursive: true, withFileTypes: true })
  const existing = new Map(entries.map(entry => [path.relative(root, path.join(entry.parentPath, entry.name)), entry]))
  const directories = new Set(snapshot.directories)
  // 复用已登记的测试目录时按字节恢复，测试之间不共享可变状态。
  for (const [relative, entry] of existing) if (entry.isFile() && !snapshot.files.has(relative)) unlinkSync(path.join(root, relative))
  for (const [relative, entry] of [...existing].sort(([a], [b]) => b.length - a.length)) if (entry.isDirectory() && !directories.has(relative)) rmdirSync(path.join(root, relative))
  await Promise.all(snapshot.directories.filter(relative => !existing.has(relative)).map(relative => mkdir(path.join(root, relative), { recursive: true })))
  await Promise.all([...snapshot.files].map(async ([relative, bytes]) => {
    const file = path.join(root, relative)
    if (!existing.has(relative) || !bytes.equals(await readFile(file))) await writeFile(file, bytes)
  }))
}
afterAll(() => {
  cleanupLayeredFixtures()
  // 小文件树同步清理，避免多个 worker 的递归删除挤占异步 IO 线程池。
  const errors: unknown[] = []
  for (const root of temporaryRoots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }) } catch (error) { errors.push(error) }
  }
  if (errors.length) throw new AggregateError(errors, '临时夹具清理失败。')
})
// 模板完成建库后只用于复制；每项测试修改自己的目录，模板随文件结束清理。
export async function shareLayeredFixture(fixture: { knowledgeRoot: string }): Promise<FixtureSnapshot> {
  return snapshotFixture(fixture.knowledgeRoot)
}
export function cleanupLayeredFixtures() {
  vi.restoreAllMocks()
  for (const [name, descriptor] of fixtureDescriptors) Object.defineProperty(filesystem, name, descriptor)
  fixtureDescriptors.clear()
  fixturePaths.clear()
  resolvedFixturePaths.clear(); fixtureMembership.clear()
  readCache.clear()
}
export interface InputParagraph { paragraph_id: number; locator: string; text_hash: string; text: string; evidence_ref?: string }
export interface ExtractionInput {
  source_id: string; point_limit: number; paragraphs: InputParagraph[]
  summary_id?: string; children?: { points: { point_id: string }[] }[]; summary_point_limit?: number
  evidence_dictionary?: Record<string, { quote: string; references: { paragraph_id: number; locator: string }[] }>
}
function paragraphText(input: ExtractionInput, paragraph: InputParagraph): string {
  return paragraph.text ?? (paragraph.evidence_ref ? input.evidence_dictionary?.[paragraph.evidence_ref]?.quote : undefined) ?? ''
}
export function mockSupportReview(input: unknown): string | undefined {
  if (input && typeof input === 'object' && 'label_stage' in input) {
    const data = input as { points: { point_id: string }[] }
    return JSON.stringify({ items: data.points.map(point => ({ point_id: point.point_id, labels: ['研究方法'], keywords: ['研究对象'] })) })
  }
  const data = input as { review_stage?: string; points?: { id: string }[]; sentences?: { id: string; original_text?: string }[]; members?: { point_id: string }[] }
  if (data.review_stage === 'extraction' || data.review_stage === 'topic') return JSON.stringify({ items: (data.points ?? data.sentences ?? []).map(item => ({ id: item.id, support: '完整支撑', missing: '' })) })
  // 主题核对超出单次预算时按句组与成员分块再合并；两步同样回答完整支撑，最终句附主张保持判定。
  if (data.review_stage === 'topic-block' || data.review_stage === 'topic-merge') return JSON.stringify({ items: (data.sentences ?? []).map(item => ({ id: item.id, support: '完整支撑', missing: null,
    ...(data.review_stage === 'topic-block' ? { findings: '引文完整支撑原句。', point_ids: (data.members ?? []).map(member => member.point_id) } : {}),
    ...(item.original_text !== undefined ? { claim_preserved: true } : {}) })) })
  return undefined
}
export function modelOutput(input: ExtractionInput): string {
  if ('correction_stage' in input) {
    const data = input as unknown as { items: { id: string; validationFeedback: { item: object } }[] }
    return JSON.stringify({ items: data.items.map(item => ({ ...item.validationFeedback.item, id: item.id })) })
  }
  const review = mockSupportReview(input)
  if (review) return review
  if ('new_tags' in input) return JSON.stringify({ groups: [] })
  if (input.summary_id) return JSON.stringify({ point_ids: input.children!.flatMap(child => child.points.map(point => point.point_id)).slice(0, input.point_limit) })
  const paragraph = input.paragraphs.find(part => !/^(?:#{1,6}\s|\[图片：)/.test(paragraphText(input, part))) ?? input.paragraphs[0]!
  const text = paragraphText(input, paragraph)
  return JSON.stringify({ tags: ['研究方法', '研究对象', '核心主题'], credibility: 'low', credibility_reason: '个人笔记',
    points: ['主要发现', '对象与条件', '方法', '限制'].slice(0, input.point_limit).map(section => ({ paragraph_id: paragraph.paragraph_id,
      text: `${section}：${text}`, section, evidence: [{ locator: paragraph.locator, quote: text.replaceAll('\r\n', '\n') }] })),
    terms: [{ paragraph_id: paragraph.paragraph_id, name: '测试术语', category: '概念', aliases: ['别称'], locator: paragraph.locator, note: '资料中使用的概念' }] })
}
// 模型流程测试保留真实文件与原子替换，省去物理刷盘和小文件读取的排队等待。
export function mockFixtureSync(root: string, nativeAttributes = false) {
  fixturePaths.add(path.resolve(root))
  fixtureMembership.clear()
  // 回收用例显式压缩宽限期，不等待产品的 30 秒；租约本身仍按原协议检查。
  vi.spyOn(retention, 'collectGarbage').mockImplementation((root, graceMs = 0) => collectGarbage(root, graceMs))
  const inFixture = (file: unknown) => {
    const name = resolvedFixturePath(file), saved = fixtureMembership.get(name)
    if (saved !== undefined) return saved
    // 只缓存路径归属的纯计算；文件存在性、字节及故障注入仍由真实 IO 判定。
    const inside = [...fixturePaths].some(root => name === root || name.startsWith(root + path.sep))
    fixtureMembership.set(name, inside)
    return inside
  }
  // 普通流程夹具新建可见目录，不启动外部 attrib；属性专项显式启用真实系统调用。
  vi.spyOn(storageFiles, 'clearHiddenAttribute').mockImplementation(async (root, warn) => {
    if (nativeAttributes || !inFixture(root)) await clearHiddenAttribute(root, warn)
  })
  // 小对象布局增加元数据调用；夹具仍执行真实目录操作和原子替换，省去线程池排队。
  // 故障测试可以继续在这些 Promise 边界注入占用、等待和中断。
  fixtureFunction('mkdir', (async (file, options) => {
    if (!inFixture(file)) return originalMkdir(file, options as never)
    // 已有目录仍现场核实，省去 Windows 对每次递归 mkdir 的重复创建尝试。
    if (typeof options === 'object' && options?.recursive && statSync(file, { throwIfNoEntry: false })?.isDirectory()) return undefined
    return mkdirSync(file, options as never)
  }) as typeof filesystem.mkdir)
  fixtureFunction('readdir', (async (file, options) => inFixture(file) ? readdirSync(file, options as never) : originalReaddir(file, options as never)) as typeof filesystem.readdir)
  fixtureFunction('rename', (async (from, to) => inFixture(from) && inFixture(to) ? renameSync(from, to) : originalRename(from, to)) as typeof filesystem.rename)
  fixtureFunction('stat', (async (file, options) => inFixture(file) ? statSync(file, options as never) : originalStat(file, options as never)) as typeof filesystem.stat)
  fixtureFunction('lstat', (async (file, options) => inFixture(file) ? lstatSync(file, options as never) : originalLstat(file, options as never)) as typeof filesystem.lstat)
  fixtureFunction('rm', async (file, options) => inFixture(file) ? rmSync(file, options) : originalRm(file, options))
  fixtureFunction('unlink', (async file => inFixture(file) ? unlinkSync(file) : originalUnlink(file)) as typeof filesystem.unlink)
  fixtureFunction('writeFile', (async (file, data, options) => {
    if (typeof file !== 'string' || !inFixture(file) || typeof options === 'object' && options?.signal) return originalWriteFile(file, data, options)
    return writeFileSync(file, data as Parameters<typeof writeFileSync>[1], options)
  }) as typeof filesystem.writeFile)
  // 这些临时夹具只创建普通文件和目录，没有链接；路径映射恒等，存在性由实际 IO 验证。
  // 越出夹具的路径仍走真实解析，路径边界判断和发布/故障断言继续执行。
  fixtureFunction('realpath', (async (file, options) => {
    const name = resolvedFixturePath(file)
    if (!options && inFixture(file)) return name
    return realpath(file, options as never)
  }) as typeof filesystem.realpath)
  // 状态读取仍读真实字节，省去小文件在并发线程池中的反复排队；取消读取保持原实现。
  // getter 返回普通函数，允许用例再次 spy 并保存原函数进行故障注入。
  fixtureFunction('readFile', (async (file, options) => {
    if (typeof file !== 'string' || !inFixture(file) || typeof options === 'object' && options?.signal) return originalReadFile(file, options)
    if (!options || typeof options === 'string') {
      const metadata = statSync(file, { bigint: true })
      let saved = readCache.get(file)
      if (!saved || saved.metadata.ino !== metadata.ino || saved.metadata.size !== metadata.size || saved.metadata.mtimeNs !== metadata.mtimeNs || saved.metadata.ctimeNs !== metadata.ctimeNs) {
        saved = { metadata, bytes: readFileSync(file) }; readCache.set(file, saved)
      }
      // JSON、Markdown 与附件共用元数据校验；跨进程写入、故障注入和删除仍由实际 stat 判定。
      if (options === 'utf8' || options === 'utf-8') return saved.text ??= saved.bytes.toString('utf8')
      return typeof options === 'string' ? saved.bytes.toString(options) : Buffer.from(saved.bytes)
    }
    return readFileSync(file, options as Parameters<typeof readFileSync>[1])
  }) as typeof filesystem.readFile)
  fixtureFunction('open', (async (file, flags, mode) => {
    if (!inFixture(file)) return open(file, flags, mode)
    // 使用真实描述符验证独占创建、读取、覆盖与关闭；Promise 接口保持调用方的等待边界。
    const fd = openSync(file, flags, mode)
    return { fd, sync: async () => {}, close: async () => closeSync(fd),
      writeFile: async (data: string | Uint8Array, options: BufferEncoding) => writeFileSync(fd, data, options),
      readFile: async (options: BufferEncoding) => readFileSync(fd, options), stat: async () => fstatSync(fd),
      write: async (buffer: Uint8Array, offset: number, length: number, position: number) => ({ bytesWritten: writeSync(fd, buffer, offset, length, position), buffer }),
      truncate: async (length: number) => ftruncateSync(fd, length),
    } as Awaited<ReturnType<typeof open>>
  }) as typeof filesystem.open)
}
export async function layeredFixture(template?: FixtureSnapshot, reuseRoot?: string) {
  if (reuseRoot && !temporaryRoots.includes(reuseRoot)) throw new Error('只能复用本夹具创建的临时目录。')
  const knowledgeRoot = reuseRoot ?? await mkdtemp(path.join(tmpdir(), 'dsh-layered-'))
  mockFixtureSync(knowledgeRoot)
  if (!reuseRoot) temporaryRoots.push(knowledgeRoot)
  if (template) await restoreFixture(template, knowledgeRoot)
  const requests: { system: string; input: ExtractionInput }[] = [], library = newLibrary('layered'), policy = defaultPolicy()
  library.models.unified = { provider: 'mock', model: 'extractor' }; library.models.layeredRoutes = {}; library.models.fallbacks = []
  policy.batchDelayMs = 0; policy.pageGenerationConcurrency = 1; policy.maxTokensPerCall = 128
  const runtime: ModelRuntime = { async resolveModelInfo(provider, id) { return { provider, id, name: id, context: { contextWindow: 32768 } } },
    async *stream(options) {
      const message = options.messages[0]!.content[0]!
      if (message.type !== 'text') throw new Error('测试只接收正文。')
      const input = JSON.parse(message.text) as ExtractionInput
      if (!input.summary_id && !('new_tags' in input) && !('review_stage' in input) && !('correction_stage' in input) && !('label_stage' in input)) requests.push({ system: options.system ?? '', input })
      yield { type: 'text-delta', index: 0, text: modelOutput(input) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } }
  const client = new ModelClient(runtime, library, policy), call = vi.spyOn(client, 'call')
  const options: BuildLayeredOptions = { knowledgeRoot, client, name: '测试库', domain: '通用测试资料', topics: false }
  // 既有回归继续覆盖旧布局；新布局用例显式选择另一个模型目录。
  if (!template) {
    const root = path.join(knowledgeRoot, '.llmwiki')
    await mkdir(root, { recursive: true })
    await writeFile(path.join(root, 'library.yaml'), stringify({ name: options.name, domain: options.domain, origin_type: 'local', source_type: 'Markdown 资料', default_credibility: 'unknown', source_count: 0, updated_at: new Date().toISOString(), format_version: 2 }))
  }
  return { knowledgeRoot, root: path.join(knowledgeRoot, '.llmwiki'), requests, runtime, client, call, options, policy, library }
}
export async function snapshotManifest(root: string): Promise<SnapshotManifest> {
  return readManifest(root, await readCurrent(root))
}
export async function versionFile(root: string, version: string, file: string): Promise<string> {
  const manifest = await readVersion(root, version)
  if (file === 'manifest.json') return JSON.stringify(manifest)
  if (file === 'deps.json') return JSON.stringify(manifest.deps)
  if (file === 'aliases.json') return JSON.stringify(manifest.aliases)
  if (file === 'library.yaml') return stringify(manifest.card)
  if (file === 'log.md') return manifest.log!
  return versionPage(root, manifest, file)
}
export async function hydratedState<T>(root: string, file = 'state/topics.json'): Promise<T> {
  return hydrateVectors(root, JSON.parse(await readFile(path.join(root, file), 'utf8'))) as Promise<T>
}
export interface TopicInput {
  current_points?: { point_id: string; source_id: string; text: string; anchor: string }[]
  topic_id: string; mode: 'incremental' | 'rebuild'; current_page?: string; max_chars: number
  points: { point_id: string; source_id: string; text_hash: string; text: string; source_version: string; locator: string }[]
  children?: { id: string; title: string; summary: string }[]
}
export async function layeredTopicFixture(template?: FixtureSnapshot, reuseRoot?: string) {
  const fixture = await layeredFixture(template, reuseRoot), topicRequests: { system: string; input: TopicInput }[] = []
  const embed = vi.fn(async (texts: string[]) => texts.map(text => text.includes('甲组') ? [1, 0] : [0, 1]))
  // 既有页生成、预算与撤权场景显式允许单来源；默认三来源晋升由聚类用例验证。
  fixture.options.topics = { topicMergeMinSources: 1 }; fixture.options.embeddingClient = { embed, identity: async () => 'fixture-weights-v1' }
  fixture.call.mockImplementation(async (task, system, input, signal, images, callOptions) => {
    const request = JSON.parse(input) as TopicInput
    const review = mockSupportReview(request)
    if (review) return review
    if (!request.topic_id) {
      const output = JSON.parse(await ModelClient.prototype.call.call(fixture.client, task, system, input, signal, images, callOptions))
      // 主题夹具只提供主题要点，术语场景显式注入，避免无关综合增加测试开销。
      output.terms = []
      return JSON.stringify(output)
    }
    topicRequests.push({ system, input: request })
    if (request.children) return JSON.stringify({ aliases: ['综合主题'], title: '父主题', summary: '跨子主题范围', consensus: [], differences: [],
      conditions: [{ text: '由子主题摘要综合。', child_ids: [request.children[0]!.id] }] })
    const ids = [...new Set((request.current_points ?? []).map(point => point.point_id).concat(request.points.map(point => point.point_id)))]
    const bySource = [...new Map([...(request.current_points ?? []), ...request.points].map(point => [point.source_id, point.point_id])).values()]
    return JSON.stringify({ aliases: ['综合主题'], title: request.points[0]!.text.includes('甲组') ? '甲组主题' : '乙组主题', summary: '资料共同适用的研究范围',
      consensus: bySource.length > 1 ? [{ text: '多个来源相互支持的结论。', point_ids: bySource.slice(0, 2) }] : [], differences: [],
      conditions: [{ text: request.points[0]!.text, point_ids: [ids.at(-1)!] }] })
  })
  return { ...fixture, embed, topicRequests }
}
export async function layeredIncrementalFixture(template?: FixtureSnapshot, reuseRoot?: string) {
  const fixture = await layeredTopicFixture(template, reuseRoot), original = fixture.call.getMockImplementation()!
  fixture.call.mockImplementation(async (task, system, input, signal, images) => {
    const request = JSON.parse(input) as ExtractionInput & { topic_id?: string }
    const review = mockSupportReview(request)
    if (review) return review
    if ('new_tags' in request) return modelOutput(request)
    if (request.topic_id) return await original(task, system, input, signal, images)
    fixture.requests.push({ system, input: request })
    const textOf = (part: InputParagraph) => paragraphText(request, part)
    return JSON.stringify({ tags: ['研究方法', '研究对象', '核心主题'], credibility: 'low', credibility_reason: '测试笔记',
      points: request.paragraphs.filter(part => !/^#{1,6}\s/.test(textOf(part))).slice(0, request.point_limit).map(part => ({
        paragraph_id: part.paragraph_id, text: textOf(part), section: '主要发现', evidence: [part.evidence_ref
          ? { evidence_ref: part.evidence_ref } : { locator: part.locator, quote: textOf(part) }],
      })), terms: [] })
  })
  return fixture
}
