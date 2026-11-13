import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import * as filesystem from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary, layeredInputBudget } from '../src/layered/index.js'
import * as files from '../src/layered/files.js'
import * as publication from '../src/layered/publication.js'
import * as retention from '../src/layered/retention.js'
import { reviewExtraction } from '../src/layered/review.js'
import { readLocalSource } from '../src/layered/snapshot.js'
import type { Extraction, PendingBuild } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, layeredFixture, modelOutput, restoreFixture, snapshotFixture, snapshotManifest, versionFile } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-13T00:00:00Z')) })
afterEach(() => { vi.useRealTimers(); cleanupLayeredFixtures() })

const bytes = (value: Extraction) => Buffer.from(JSON.stringify(value, null, 2) + '\n')
function respond(f: Awaited<ReturnType<typeof layeredFixture>>, text?: string) {
  f.call.mockImplementation(async (_task, _system, raw) => {
    const output = JSON.parse(modelOutput(JSON.parse(raw)))
    if (output.terms) {
      output.terms = []
      if (text) output.points[0].text = text
    }
    return JSON.stringify(output)
  })
}
async function built(review = false) {
  const f = await layeredFixture()
  // 保留原始提取对象，以便同时核对旧路径与新路径的字节。
  vi.spyOn(retention, 'collectGarbage').mockResolvedValue(undefined)
  f.options.topics = { extractionReview: review ? 'all' : 'off', topicMergeMinSources: 100 }
  f.options.embeddingClient = { identity: async () => '分址回归向量', embed: async texts => texts.map(() => [1, 0]) }
  // 固定初建和重提的输入词表，避免调用输入字节随已发布标签变化。
  f.options.tagVocabulary = ['研究方法', '研究对象', '核心主题']
  respond(f)
  const sourceFile = path.join(f.knowledgeRoot, '资料.md')
  await writeFile(sourceFile, '---\ndate: 2026-11-13\n---\n\n原文说明研究方法及适用条件。')
  const initial = await buildLayeredLibrary(f.options), manifest = await snapshotManifest(f.root)
  const entry = manifest.sources[0]!, basePath = entry.extract.path.replace(/-quality-[^.]+\.json$/, '.json')
  const original = await readFile(path.join(f.root, basePath))
  const reviewedBytes = await readFile(path.join(f.root, entry.extract.path))
  const raw: Extraction = JSON.parse(original.toString()), reviewed: Extraction = JSON.parse(reviewedBytes.toString())
  const reviewPath = basePath.replace('objects/snapshots/', 'work/extractions/').replace(/\.json$/, '-review.json')
  f.call.mockClear()
  return { ...f, sourceFile, initial, manifest, entry, basePath, original, reviewedBytes, raw, reviewed, reviewPath }
}

async function queueFailure(f: Awaited<ReturnType<typeof built>>) {
  // 同身份的旧失败优先进入重提，基础路径上仍留有无缺口的完整对象。
  const failed = structuredClone(f.raw)
  // 失败组没有可复用的成功响应，否则真实提取会直接命中组缓存。
  failed.group_cache = {}
  failed.gaps = [{ kind: 'group', retryable: true, segment_hashes: failed.segments.map(segment => segment.text_hash), item: null,
    reasons: [{ rule: 'extract-group', expected: '完成提取', actual: 'Connection error.' }] }]
  const failurePath = f.basePath.replace(/\.json$/, '-failed.json')
  await writeFile(path.join(f.root, failurePath), bytes(failed))
  const pending: PendingBuild = { format_version: 2, base_version: f.initial.version, version: null,
    manifest: structuredClone(f.manifest), card: f.manifest.card!, added: [], model_calls: 0, started_at: new Date().toISOString() }
  pending.manifest.sources[0]!.extract.path = failurePath
  await writeFile(path.join(f.root, 'work/pending.json'), JSON.stringify(pending))
}

async function extractionFiles(f: Awaited<ReturnType<typeof built>>) {
  return (await readdir(path.dirname(path.join(f.root, f.basePath)))).sort()
}

async function products(f: Awaited<ReturnType<typeof built>>) {
  const manifest = await snapshotManifest(f.root)
  return {
    extractions: await Promise.all(manifest.sources.map(async entry => [entry.extract.path, await readFile(path.join(f.root, entry.extract.path))])),
    pages: await Promise.all(Object.keys(manifest.pages ?? {}).sort().map(async page => [page, await versionFile(f.root, manifest.version!, page)])),
    pageObjects: manifest.pages, tags: manifest.tag_merges, deps: manifest.deps, aliases: manifest.aliases,
  }
}

it('同键完整对象与不同重提成果分址，发布中断后续跑正确且旧字节不变', async () => {
  const f = await built(), text = '重新提取的研究方法与适用条件。'
  await queueFailure(f)
  const queued = await snapshotFixture(f.knowledgeRoot)
  // 无绑定的旧格式和绑定旧成果的检查点都不能覆盖不同字节的重提结果。
  for (const checkpoint of [f.reviewed, { input_hash: files.hash(f.original), extraction: f.reviewed }]) {
    await restoreFixture(queued, f.knowledgeRoot)
    f.call.mockClear(); respond(f, text)
    await mkdir(path.dirname(path.join(f.root, f.reviewPath)), { recursive: true })
    await writeFile(path.join(f.root, f.reviewPath), JSON.stringify(checkpoint))
    const publish = vi.spyOn(publication, 'publishLibrary').mockRejectedValueOnce(new Error('模拟发布中断'))
    await expect(buildLayeredLibrary(f.options)).rejects.toThrow('模拟发布中断')
    expect(f.call.mock.calls.filter(args => JSON.parse(args[2]).paragraphs)).toHaveLength(1)
    const pending: PendingBuild = JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8'))
    const next: Extraction = JSON.parse(await readFile(path.join(f.root, pending.manifest.sources[0]!.extract.path), 'utf8'))
    // 核对关闭时只增加核对策略字段；分址对象本身来自真实提取回执。
    const receipts = await Promise.all((await readdir(path.join(f.root, 'cache/tasks'))).map(async file => JSON.parse(await readFile(path.join(f.root, 'cache/tasks', file), 'utf8'))))
    const raw: Extraction = receipts.find(item => item.value?.segments?.some((segment: Extraction['segments'][number]) => segment.points.some(point => point.text === text))).value
    const newBytes = bytes(raw), suffixPath = f.basePath.replace(/\.json$/, '-' + files.hashName(files.hash(newBytes)) + '.json')
    expect(await readFile(path.join(f.root, suffixPath))).toEqual(newBytes)
    expect(await readFile(path.join(f.root, f.basePath))).toEqual(f.original)
    expect(await readFile(path.join(f.root, f.entry.extract.path))).toEqual(f.reviewedBytes)
    expect((await snapshotManifest(f.root)).version).toBe(f.initial.version)
    publish.mockRestore(); f.call.mockClear()
    f.call.mockRejectedValue(new Error('续跑不应调用模型'))
    const resumed = await buildLayeredLibrary(f.options)
    expect(resumed.modelCalls).toBe(0)
    expect(f.call).not.toHaveBeenCalled()
    const entry = (await snapshotManifest(f.root)).sources[0]!
    expect(await readFile(path.join(f.root, entry.extract.path))).toEqual(bytes(next))
    expect(await versionFile(f.root, resumed.version, 'sources/' + entry.source_id + '.md')).toContain(text)
    await publication.validatePublication(f.root, resumed.version)
  }
})

it('重提得到相同字节时复用基础路径，不新增提取对象', async () => {
  const f = await built(), before = await extractionFiles(f)
  const result = await buildLayeredLibrary({ ...f.options, reextract: 'all' })
  expect(f.call.mock.calls.filter(args => JSON.parse(args[2]).paragraphs)).toHaveLength(1)
  expect(result.modelCalls).toBe(f.call.mock.calls.length)
  expect(await extractionFiles(f)).toEqual(before)
  expect(await readFile(path.join(f.root, f.basePath))).toEqual(f.original)
  const entry = (await snapshotManifest(f.root)).sources[0]!
  expect(entry.extract.path).toBe(f.entry.extract.path)
  expect(await readFile(path.join(f.root, entry.extract.path))).toEqual(f.reviewedBytes)
})

it('真实重提分址并保存核对检查点后中断，路径恢复与真实回执恢复均零调用且产物一致', async () => {
  const f = await built(true), text = '重新提取的研究方法与适用条件。'
  const initial = await snapshotFixture(f.knowledgeRoot)
  respond(f, text)
  await buildLayeredLibrary({ ...f.options, reextract: 'all' })
  const expected = await products(f)
  await restoreFixture(initial, f.knowledgeRoot)
  f.call.mockClear()
  const write = files.writeJson
  const interrupted = vi.spyOn(files, 'writeJson').mockImplementation(async (root, relative, value) => {
    await write(root, relative, value)
    if (relative === f.reviewPath && value && typeof value === 'object' && 'extraction' in value) throw new Error('模拟核对检查点中断')
  })
  await expect(buildLayeredLibrary({ ...f.options, reextract: 'all' })).rejects.toThrow('模拟核对检查点中断')
  expect(f.call.mock.calls.filter(args => JSON.parse(args[2]).paragraphs)).toHaveLength(1)
  const reviews = f.call.mock.calls.map(args => JSON.parse(args[2])).filter(input => input.review_stage === 'extraction')
  expect(reviews).toHaveLength(1)
  expect(reviews[0].points.some((item: { text: string }) => item.text === text)).toBe(true)
  const checkpoint = JSON.parse(await readFile(path.join(f.root, f.reviewPath), 'utf8'))
  const sealed = await readFile(path.join(f.root, checkpoint.input_path))
  expect(checkpoint.input_path).toBe(f.basePath.replace(/\.json$/, '-' + files.hashName(files.hash(sealed)) + '.json'))
  expect(checkpoint.input_hash).toBe(files.hash(sealed))
  expect(JSON.parse(sealed.toString()).calls.length).toBeGreaterThan(0)
  expect(checkpoint.extraction.segments.flatMap((segment: Extraction['segments'][number]) => segment.points)[0].text).toBe(text)
  const receipts = await Promise.all((await readdir(path.join(f.root, 'cache/tasks'))).map(async file => JSON.parse(await readFile(path.join(f.root, 'cache/tasks', file), 'utf8'))))
  expect(receipts.some(receipt => receipt.value?.segments && bytes(receipt.value).equals(sealed))).toBe(true)
  interrupted.mockRestore()
  const stopped = await snapshotFixture(f.knowledgeRoot)
  for (const keepPath of [true, false]) {
    await restoreFixture(stopped, f.knowledgeRoot)
    if (!keepPath) {
      // 兼容未记录路径的旧检查点，强制恢复真实提取回执，核验其完整字节。
      const { input_path, ...legacy } = checkpoint
      await writeFile(path.join(f.root, f.reviewPath), JSON.stringify(legacy))
    }
    f.call.mockClear(); f.call.mockRejectedValue(new Error('恢复不应调用模型'))
    const resumed = await buildLayeredLibrary(f.options)
    expect(resumed.modelCalls).toBe(0)
    expect(f.call).not.toHaveBeenCalled()
    expect(await readFile(path.join(f.root, checkpoint.input_path))).toEqual(sealed)
    expect(await readFile(path.join(f.root, f.basePath))).toEqual(f.original)
    expect(await readFile(path.join(f.root, f.entry.extract.path))).toEqual(f.reviewedBytes)
    expect(await products(f)).toEqual(expected)
    await publication.validatePublication(f.root, resumed.version)
  }
})

it.each(['缺哈希', '坏哈希', '目标缺失'] as const)('分址绑定%s时恢复不抛错，回退后重新核对且产物正确', async invalid => {
  const f = await built(true), text = '重新提取的研究方法与适用条件。'
  const initial = await snapshotFixture(f.knowledgeRoot)
  respond(f, text)
  await buildLayeredLibrary({ ...f.options, reextract: 'all' })
  const expected = await products(f)
  await restoreFixture(initial, f.knowledgeRoot)
  const write = files.writeJson
  const interrupted = vi.spyOn(files, 'writeJson').mockImplementation(async (root, relative, value) => {
    await write(root, relative, value)
    if (relative === f.reviewPath && value && typeof value === 'object' && 'extraction' in value) throw new Error('模拟核对检查点中断')
  })
  await expect(buildLayeredLibrary({ ...f.options, reextract: 'all' })).rejects.toThrow('模拟核对检查点中断')
  interrupted.mockRestore()
  const checkpoint = JSON.parse(await readFile(path.join(f.root, f.reviewPath), 'utf8'))
  const sealed = await readFile(path.join(f.root, checkpoint.input_path))
  expect(checkpoint.input_path).not.toBe(f.basePath)
  expect(checkpoint.input_hash).toBe(files.hash(sealed))
  // 保留真实提取回执，恢复时只能从中取回本次成果，不能误用基础路径上的旧对象。
  const receipts = await Promise.all((await readdir(path.join(f.root, 'cache/tasks'))).map(async file => JSON.parse(await readFile(path.join(f.root, 'cache/tasks', file), 'utf8'))))
  expect(receipts.some(receipt => receipt.value?.segments && bytes(receipt.value).equals(sealed))).toBe(true)
  if (invalid === '缺哈希') delete checkpoint.input_hash
  else if (invalid === '坏哈希') {
    checkpoint.input_hash = files.hash(f.original)
    expect(checkpoint.input_hash).not.toBe(files.hash(sealed))
  } else await unlink(path.join(f.root, checkpoint.input_path))
  // 无效绑定中的已核对成果不可回填；即使其哈希仍匹配恢复出的原始字节。
  checkpoint.extraction.metadata.title = '无效绑定中的错误成果'
  await writeFile(path.join(f.root, f.reviewPath), JSON.stringify(checkpoint))
  f.call.mockClear()
  const resumed = buildLayeredLibrary(f.options)
  await expect(resumed).resolves.toBeDefined()
  const result = await resumed
  const reviews = f.call.mock.calls.map(args => JSON.parse(args[2])).filter(input => input.review_stage === 'extraction')
  expect(reviews).toHaveLength(1)
  expect(reviews[0].points.some((point: { text: string }) => point.text === text)).toBe(true)
  expect(f.call.mock.calls.filter(args => JSON.parse(args[2]).paragraphs)).toHaveLength(0)
  expect(result.modelCalls).toBe(f.call.mock.calls.length)
  expect(await products(f)).toEqual(expected)
  expect(await readFile(path.join(f.root, f.basePath))).toEqual(f.original)
  expect(await readFile(path.join(f.root, checkpoint.input_path))).toEqual(sealed)
  await publication.validatePublication(f.root, result.version)
})

it('内容不变的普通续跑离线零调用，复用旧路径且产物逐字节不变', async () => {
  const f = await built(true), before = await extractionFiles(f)
  const page = await versionFile(f.root, f.initial.version, 'sources/' + f.entry.source_id + '.md')
  await mkdir(path.dirname(path.join(f.root, f.reviewPath)), { recursive: true })
  await writeFile(path.join(f.root, f.reviewPath), f.reviewedBytes)
  const reads = vi.spyOn(filesystem, 'readFile')
  f.call.mockRejectedValue(new Error('离线续跑禁止模型调用'))
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ unchanged: true, modelCalls: 0, version: f.initial.version })
  expect(f.call).not.toHaveBeenCalled()
  expect((await snapshotManifest(f.root)).sources[0]!.extract.path).toBe(f.entry.extract.path)
  expect(await extractionFiles(f)).toEqual(before)
  expect(await readFile(path.join(f.root, f.basePath))).toEqual(f.original)
  expect(await readFile(path.join(f.root, f.entry.extract.path))).toEqual(f.reviewedBytes)
  expect(await versionFile(f.root, f.initial.version, 'sources/' + f.entry.source_id + '.md')).toBe(page)
  expect(reads.mock.calls.some(([file]) => path.resolve(String(file)) === path.resolve(f.root, f.reviewPath))).toBe(false)
})

it('核对任务回执绑定完整成果，元数据变化重新核对且相同成果复用', async () => {
  const f = await built(true), source = await readLocalSource(f.sourceFile, 'Markdown')
  const inputLimit = await layeredInputBudget(f.options), first = structuredClone(f.raw)
  first.metadata.title = '第一份成果标题'
  const reviewed = structuredClone(first)
  expect(await reviewExtraction(reviewed, source, f.options, inputLimit)).toBeGreaterThan(0)
  f.call.mockClear()
  const same = structuredClone(first)
  expect(await reviewExtraction(same, source, f.options, inputLimit)).toBe(0)
  expect(f.call).not.toHaveBeenCalled(); expect(same.metadata.title).toBe(first.metadata.title)
  expect(bytes(same)).toEqual(bytes(reviewed))
  const changed = structuredClone(first)
  changed.metadata.title = '第二份成果标题'
  expect(await reviewExtraction(changed, source, f.options, inputLimit)).toBeGreaterThan(0)
  expect(changed.metadata.title).toBe('第二份成果标题')
  expect(f.call.mock.calls.filter(args => JSON.parse(args[2]).review_stage === 'extraction')).toHaveLength(1)
})
