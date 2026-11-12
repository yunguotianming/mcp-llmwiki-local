import { expectModelCalls, mockSupportReview } from './layered-fixture.js'
import { versionFile } from './layered-fixture.js'
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { buildLayeredLibrary, readLayeredDocument, readLayeredPage, readLayeredSource } from '../src/layered/index.js'
import type { Dependencies, Extraction } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, layeredIncrementalFixture, shareLayeredFixture, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
let template: Awaited<ReturnType<typeof shareLayeredFixture>>
let reuseRoot: string
beforeAll(async () => {
  const f = await layeredIncrementalFixture()
  reuseRoot = f.knowledgeRoot
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组保留结论。\n\n甲组将移除的结论。\n\n乙组独立结论。')
  await buildLayeredLibrary(f.options)
  template = await shareLayeredFixture(f)
})
it('未变和改名移动零调用且正文不变；新增只修订相关主题', async () => {
  const f = await layeredIncrementalFixture(template, reuseRoot)
  const page = await readLayeredPage(f.knowledgeRoot, 'sources/S-0001.md'), topic = await readLayeredPage(f.knowledgeRoot, 'topics/T-0001.md')
  const otherTopic = await readLayeredPage(f.knowledgeRoot, 'topics/T-0002.md')
  f.call.mockClear(); f.embed.mockClear()
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ unchanged: true, modelCalls: 0 })
  await mkdir(path.join(f.knowledgeRoot, 'sub'))
  await rename(path.join(f.knowledgeRoot, 'a.md'), path.join(f.knowledgeRoot, 'sub/renamed.md'))
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ unchanged: false, modelCalls: 0 })
  expect(f.call).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled()
  // 来源页现在展示全部路径；改名只更新路径和别名，知识正文仍逐字节相同。
  expect(await readLayeredPage(f.knowledgeRoot, 'sources/S-0001.md')).toBe(page.replace('aliases:\n  - a\n', 'aliases:\n  - a\n  - renamed\n')
    .replace('current_path: a.md', 'current_path: sub/renamed.md').replace('## 来源路径\n\n- a.md', '## 来源路径\n\n- sub/renamed.md'))
  expect(await readLayeredPage(f.knowledgeRoot, 'topics/T-0001.md')).toBe(topic)
  expect(await readLayeredPage(f.knowledgeRoot, 'topics/T-0002.md')).toBe(otherTopic)
  expect(await readLayeredPage(f.knowledgeRoot)).toContain('sub/renamed.md')
  expect((await snapshotManifest(f.root)).sources[0]).toMatchObject({ source_id: 'S-0001', previous_paths: ['a.md'], current_path: 'sub/renamed.md' })
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '甲组新增支持。')
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ modelCalls: 2 + 2, added: ['S-0002'] }) // 向量模式默认关闭补标，按其余文本阶段精确计数。
  expectModelCalls(f.call, { extraction: 1, review: 2, topic: 1 })
  expect(f.topicRequests.at(-1)!.input).toMatchObject({ mode: 'incremental', current_page: topic })
})
it('内容修改只提变化段、保留未变要点 ID；反向依赖重建并重绑其他主题引文', async () => {
  const f = await layeredIncrementalFixture(template, reuseRoot), file = path.join(f.knowledgeRoot, 'a.md')
  const old = (await snapshotManifest(f.root)).sources[0]!
  const before = JSON.parse(await readFile(path.join(f.root, old.extract.path), 'utf8')) as Extraction
  f.call.mockClear(); f.embed.mockClear(); f.topicRequests.length = 0; f.requests.length = 0
  await writeFile(file, '甲组新增加的一段。\n\n甲组保留结论。\n\n甲组又增加一段。\n\n乙组独立结论。')
  const built = await buildLayeredLibrary(f.options), next = (await snapshotManifest(f.root)).sources[0]!
  const after = JSON.parse(await readFile(path.join(f.root, next.extract.path), 'utf8')) as Extraction
  // 新增一次来源核对和一次受影响主题核对。
  expect(built.modelCalls).toBe(2 + 2); expect(f.call).toHaveBeenCalledTimes(2 + 2) // 向量模式默认关闭补标，按其余文本阶段精确计数。
  expectModelCalls(f.call, { extraction: 1, review: 2, topic: 1 })
  expect(f.requests.map(request => request.input.paragraphs.map(part => part.text))).toEqual([['甲组新增加的一段。', '甲组又增加一段。']])
  expect(after.segments[1]!.points[0]!.point_id).toBe(before.segments[0]!.points[0]!.point_id)
  expect(after.segments[1]!.points[0]).toMatchObject({ locator: 'L3-L3', source_version: next.source_version })
  expect(f.topicRequests).toHaveLength(1); expect(f.topicRequests[0]!.input.mode).toBe('rebuild')
  expect(f.topicRequests[0]!.input.current_page).toBeUndefined()
  const deps = JSON.parse(await versionFile(f.root, built.version, `deps.json`)) as Dependencies
  expect(deps.reverse[before.segments[1]!.points[0]!.point_id]).toBeUndefined()
  expect(await readLayeredPage(f.knowledgeRoot, 'topics/T-0001.md')).not.toContain('将移除')
  expect(await readLayeredPage(f.knowledgeRoot, 'topics/T-0002.md')).toContain(next.source_version)
  expect(await readLayeredSource(f.knowledgeRoot, old.source_id, { sourceVersion: old.source_version, locator: 'L999-L999' }))
    .toMatchObject({ status: 'updated', content: '已更新', sourceVersion: next.source_version })
  expect(await readLayeredSource(f.knowledgeRoot, old.source_id, { sourceVersion: next.source_version, locator: 'L3-L3' })).toMatchObject({ status: 'ok', content: '甲组保留结论。' })
})
it('删除先屏蔽再重建、空主题保留无引文旧页，重新添加不回收编号', async () => {
  const f = await layeredIncrementalFixture(template, reuseRoot)
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '甲组第二份。')
  await buildLayeredLibrary(f.options)
  await unlink(path.join(f.knowledgeRoot, 'a.md'))
  const original = f.call.getMockImplementation()!
  f.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
    expect(await readLayeredDocument(f.knowledgeRoot, 'sources/S-0001.md')).toMatchObject({ status: 'updating', content: '更新中' })
    expect(await readLayeredDocument(f.knowledgeRoot, 'topics/T-0001.md')).toMatchObject({ status: 'updating', content: '更新中' })
    return original(...args)
  })
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ modelCalls: 1 + 1 }) // 仅存续主题新增一次核对，归档主题不调用模型。
  expect(await readLayeredDocument(f.knowledgeRoot, 'topics/T-0001.md')).toMatchObject({ status: 'ok' })
  expect(await readLayeredPage(f.knowledgeRoot)).toContain('T-0002')
  expect(await readLayeredPage(f.knowledgeRoot, 'topics/T-0002.md')).toContain('旧主题保留')
  f.call.mockImplementation(original); f.call.mockClear(); f.embed.mockClear()
  await unlink(path.join(f.knowledgeRoot, 'b.md'))
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ modelCalls: 0 })
  expect((await snapshotManifest(f.root)).sources).toEqual([])
  expect(await readLayeredPage(f.knowledgeRoot)).toContain('当前库没有来源')
  expect(await readLayeredPage(f.knowledgeRoot)).not.toMatch(/\]\(sources\//)
  expect(await readLayeredPage(f.knowledgeRoot, 'T-0001')).toContain('旧主题保留')
  expect(await readFile(path.join(f.root, 'library.yaml'), 'utf8')).toContain('source_count: 0')
  expect(await readFile(path.join(f.root, 'logs/build.md'), 'utf8')).toContain('删除')
  expect(f.call).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组重新加入。')
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ added: ['S-0003'] })
})
it('改名且改内容按删除加新增，同哈希多副本归入原来源别名', async () => {
  const f = await layeredIncrementalFixture(template, reuseRoot)
  await unlink(path.join(f.knowledgeRoot, 'a.md'))
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '甲组改稿。')
  f.call.mockClear()
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ added: ['S-0002'], modelCalls: 2 + 2 }) // 向量模式默认关闭补标，按其余文本阶段精确计数。
  expectModelCalls(f.call, { extraction: 1, review: 2, topic: 1 })
  await unlink(path.join(f.knowledgeRoot, 'b.md'))
  await writeFile(path.join(f.knowledgeRoot, 'c.md'), '甲组改稿。')
  await writeFile(path.join(f.knowledgeRoot, 'd.md'), '甲组改稿。')
  // 内容优先：多个同内容路径是一个来源，改名与增加副本均不重提。
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ added: [], modelCalls: 0 })
  expect((await snapshotManifest(f.root)).sources).toMatchObject([{ source_id: 'S-0002', current_path: 'c.md', alias_paths: ['d.md'], previous_paths: ['b.md'] }])
  expect((await snapshotManifest(f.root)).sources).toHaveLength(1)
  const revocations = JSON.parse(await readFile(path.join(f.root, 'state/revocations.json'), 'utf8'))
  expect(revocations.sources.map((item: { source_id: string }) => item.source_id)).toEqual(['S-0001'])
})
it('提取配置变化整篇重提，重复段落对齐不唯一时保守重提', async () => {
  const f = await layeredIncrementalFixture(), file = path.join(f.knowledgeRoot, 'a.md')
  await writeFile(file, '甲组重复段落。\n\n甲组重复段落。')
  await buildLayeredLibrary(f.options)
  f.requests.length = 0
  await writeFile(file, '甲组重复段落。\n\n甲组重复段落。\n\n甲组新增段落。')
  await buildLayeredLibrary(f.options)
  expect(f.requests[0]!.input.paragraphs).toHaveLength(3)
  const before = (await snapshotManifest(f.root)).sources[0]!
  f.requests.length = 0; f.call.mockClear()
  expect(await buildLayeredLibrary({ ...f.options, promptVersion: 'v2' })).toMatchObject({ modelCalls: 1 }) // 要点与引文未变，核对和主题复用；仅重提来源。
  expect(f.requests[0]!.input.paragraphs).toHaveLength(3)
  expect((await snapshotManifest(f.root)).sources[0]!.extract.path).not.toBe(before.extract.path)
  expect(await readFile(path.join(f.root, before.extract.path), 'utf8')).toContain('layered-extract-v5')
})
