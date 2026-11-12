// 内容优先匹配使跨目录改名保持 ID；仍验证新目录图片的实际字节。
import { expectModelCalls, mockSupportReview } from './layered-fixture.js'
import * as filesystem from 'node:fs/promises'
import { mkdir, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import type { ImageBlock } from '@deepseek-ai/dsh-llm'
import { buildLayeredLibrary, readLayeredPage } from '../src/layered/index.js'
import type { CostReport, Extraction } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, layeredIncrementalFixture, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
it('发布文件并行失败等在途写入结束才释放锁，保持未发布并可零调用恢复', async () => {
  const f = await layeredIncrementalFixture()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组并行发布证据。')
  const started = Promise.withResolvers<void>(), failed = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const original = filesystem.rename
  const fault = vi.spyOn(filesystem, 'rename').mockImplementation(async (from, to) => {
    const target = String(to).replaceAll('\\', '/')
    if (target.includes('/objects/pages/')) {
      const content = await readFile(String(from), 'utf8')
      if (content.includes('page_type: source')) { started.resolve(); await release.promise }
      if (content.includes('来源数：')) { failed.resolve(); throw new Error('模拟并行发布失败') }
    }
    return original(from, to)
  })
  let settled = false
  const building = buildLayeredLibrary(f.options).then(() => undefined, error => error).finally(() => { settled = true })
  try {
    await Promise.all([started.promise, failed.promise])
    await setImmediate()
    expect(settled).toBe(false)
    await expect(buildLayeredLibrary(f.options)).rejects.toThrow('已有分层建库正在运行')
    await expect(stat(path.join(f.root, 'state/current.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { release.resolve(); await building; fault.mockRestore() }
  expect(await building).toMatchObject({ message: '模拟并行发布失败' })
  expect((await filesystem.readdir(f.root, { recursive: true })).some(file => file.endsWith('.tmp'))).toBe(false)
  f.call.mockClear(); f.embed.mockClear()
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ version: 'v000002', modelCalls: 0 })
  expect(f.call).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled()
})
it('附件变化默认零调用；使用图片只重提引用变化图片的段落并发送真实附件', async () => {
  const f = await layeredIncrementalFixture()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组文字。\n\n![甲组图片](a.png)\n\n![乙组图片](b.png)')
  await writeFile(path.join(f.knowledgeRoot, 'a.png'), '图片甲')
  await writeFile(path.join(f.knowledgeRoot, 'b.png'), '图片乙')
  await buildLayeredLibrary(f.options)
  const old = (await snapshotManifest(f.root)).sources[0]!, bytes = await readFile(path.join(f.root, old.extract.path), 'utf8')
  f.call.mockClear(); f.embed.mockClear()
  await writeFile(path.join(f.knowledgeRoot, 'a.png'), '甲图新版')
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ modelCalls: 0 })
  expect(f.call).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled()
  const updated = (await snapshotManifest(f.root)).sources[0]!
  expect(updated.resource_version).not.toEqual(old.resource_version)
  expect(updated.extract.path).toBe(old.extract.path); expect(await readFile(path.join(f.root, updated.extract.path), 'utf8')).toBe(bytes)
  expect(await readLayeredPage(f.knowledgeRoot, 'sources/S-0001.md')).toContain(updated.files.assets[0]!.hash)
  const loadImage = vi.fn(async (data: Buffer) => ({ type: 'image', attachment: { attachmentId: data.toString(), mediaType: 'image/png', bytes: data.length, width: 1, height: 1 } }) as ImageBlock)
  const options = { ...f.options, imagePolicy: 'images' as const, loadImage }
  await buildLayeredLibrary(options)
  f.requests.length = 0; f.call.mockClear(); loadImage.mockClear()
  await writeFile(path.join(f.knowledgeRoot, 'a.png'), '甲图再次更新')
  expect(await buildLayeredLibrary(options)).toMatchObject({ modelCalls: 1 })
  expect(f.requests).toHaveLength(1); expect(f.requests[0]!.input.paragraphs.map(part => part.text)).toEqual(['![甲组图片](a.png)'])
  expect(loadImage).toHaveBeenCalledTimes(1); expect(loadImage.mock.calls[0]![0].toString()).toBe('甲图再次更新')
  expect(f.call.mock.calls[0]![4]).toHaveLength(1)
  const entry = (await snapshotManifest(f.root)).sources[0]!, extract = JSON.parse(await readFile(path.join(f.root, entry.extract.path), 'utf8')) as Extraction
  expect(extract.segments.map(segment => segment.resource_hashes.length)).toEqual([0, 1, 1])
  f.call.mockClear(); expect(await buildLayeredLibrary(options)).toMatchObject({ unchanged: true }); expect(f.call).not.toHaveBeenCalled()
})
it('含相对路径图片的跨目录移动保留内容身份并刷新附件', async () => {
  const f = await layeredIncrementalFixture()
  await mkdir(path.join(f.knowledgeRoot, 'new'))
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组结论。\n\n![图片](image.png)')
  await writeFile(path.join(f.knowledgeRoot, 'image.png'), '旧图')
  await writeFile(path.join(f.knowledgeRoot, 'new/image.png'), '新目录图')
  await buildLayeredLibrary(f.options)
  await rename(path.join(f.knowledgeRoot, 'a.md'), path.join(f.knowledgeRoot, 'new/a.md'))
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ added: [] })
  const entries = (await snapshotManifest(f.root)).sources
  expect(entries).toHaveLength(1); expect(entries[0]!.source_id).toBe('S-0001'); expect(entries[0]!.previous_paths).toEqual(['a.md'])
  expect(await readFile(path.join(f.root, entries[0]!.files.assets[0]!.path), 'utf8')).toBe('新目录图')
})
it('提取完成后中断，丢失内存进度和派生主题状态仍从 extract 与 pending 续跑', async () => {
  const f = await layeredIncrementalFixture()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组第一次建库。')
  f.embed.mockRejectedValueOnce(new Error('模拟提取完成后退出'))
  await expect(buildLayeredLibrary(f.options)).rejects.toThrow('本地向量模型不可用')
  const pending = JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8'))
  const extract = pending.manifest.sources[0].extract.path, before = await readFile(path.join(f.root, extract), 'utf8')
  f.client.attempts.length = 0; f.requests.length = 0; f.call.mockClear()
  await unlink(path.join(f.root, 'state/topics.json')).catch(error => { if (error.code !== 'ENOENT') throw error })
  const client = { info: f.client.info.bind(f.client), inputBudget: f.client.inputBudget.bind(f.client), call: f.call }
  // 含标签归并调用：续跑完成一次主题综合后，三个去重标签首次归并 1 次。
  expect(await buildLayeredLibrary({ ...f.options, client })).toMatchObject({ modelCalls: 2 + 1 }) // 向量模式默认关闭补标，按其余文本阶段精确计数。
  expectModelCalls(f.call, { topic: 1, review: 1, merge: 1 })
  expect(f.requests).toHaveLength(0); expect(f.topicRequests).toHaveLength(1)
  expect(await readFile(path.join(f.root, extract), 'utf8')).toBe(before)
  await expect(stat(path.join(f.root, 'work/pending.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(stat(path.join(f.root, 'state/wiki.sqlite'))).rejects.toMatchObject({ code: 'ENOENT' })
})
it('发布前中断恢复零模型调用；完成后丢失派生索引仍保持页面与提取快照', async () => {
  const f = await layeredIncrementalFixture()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组待发布。')
  const original = filesystem.rename
  const fail = vi.spyOn(filesystem, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith('current.json')) throw new Error('模拟切换前中断')
    return original(from, to)
  })
  await expect(buildLayeredLibrary(f.options)).rejects.toThrow('模拟切换前中断')
  const pending = JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8')), extract = pending.manifest.sources[0].extract.path
  const extraction = await readFile(path.join(f.root, extract), 'utf8')
  fail.mockRestore(); f.call.mockClear(); f.embed.mockClear()
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ modelCalls: 0 })
  expect(f.call).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled()
  const page = await readLayeredPage(f.knowledgeRoot, 'topics/T-0001.md')
  await unlink(path.join(f.root, 'state/topics.json'))
  f.call.mockClear()
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ modelCalls: 0, unchanged: true })
  expect(f.call).not.toHaveBeenCalled(); expect(await readLayeredPage(f.knowledgeRoot, 'topics/T-0001.md')).toBe(page)
  expect(await readFile(path.join(f.root, extract), 'utf8')).toBe(extraction)
})
it('成本在清理 pending 前保存，逻辑任务和含重试的实际调用分列', async () => {
  const f = await layeredIncrementalFixture()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组成本样例。')
  const original = f.call.getMockImplementation()!
  f.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
    const input = JSON.parse(args[2])
    if (!input.topic_id) f.client.attempts.push(
      { route: { provider: 'mock', model: 'extractor' }, startedAt: new Date().toISOString(), durationMs: 2, finish: 'error', usage: { inputTokens: 3, cacheReadTokens: 1, outputTokens: 0 } },
      { route: { provider: 'mock', model: 'extractor' }, startedAt: new Date().toISOString(), durationMs: 3, finish: 'stop', usage: { inputTokens: 7, cacheReadTokens: 2, outputTokens: 4 } })
    return original(...args)
  })
  const originalUnlink = filesystem.unlink
  const cleanup = vi.spyOn(filesystem, 'unlink').mockImplementation(async file => {
    if (String(file).endsWith('pending.json')) {
      expect(await readFile(path.join(f.root, 'logs/cost-report.md'), 'utf8')).toContain('逻辑任务数')
      expect(await readFile(path.join(f.root, 'logs/build.md'), 'utf8')).toContain('实际调用数')
    }
    return originalUnlink(file)
  })
  const built = await buildLayeredLibrary(f.options)
  const reports = JSON.parse(await readFile(path.join(f.root, 'logs/costs.json'), 'utf8')) as Record<string, CostReport>
  expect(reports[built.version]!.stages['提取']).toMatchObject({ logical_tasks: 1, actual_calls: 2, input_tokens: 10, cache_tokens: 3, output_tokens: 4, unreported_calls: 0 })
  expect(reports[built.version]!.stages['主题']).toMatchObject({ logical_tasks: 1, actual_calls: 1 })
  expect(reports[built.version]!.stages['嵌入']).toMatchObject({ logical_tasks: 1, actual_calls: 1 })
  cleanup.mockRestore()
})
