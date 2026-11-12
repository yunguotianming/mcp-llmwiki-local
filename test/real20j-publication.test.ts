// 修改夹具保留同一来源标题达到 50% 段重合；来源 ID、核对范围及贡献断言保持。
import { afterEach, expect, it, vi } from 'vitest'
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildLayeredLibrary, revokeLayeredSources } from '../src/layered/index.js'
import { publishLibrary } from '../src/layered/publication.js'
import { topicHeader } from '../src/layered/topics.js'
import { cleanupLayeredFixtures, layeredIncrementalFixture, mockSupportReview, snapshotManifest, versionFile } from './layered-fixture.js'
import { pendingFixture } from './pipeline-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('P5正常路径：术语索引增量和撤权后头部、最终依赖及贡献来源始终一致', async () => {
  const f = await layeredIncrementalFixture(), original = f.call.getMockImplementation()!
  f.options.topics = { topicMergeMinSources: 1, termThreshold50: 2 }
  f.call.mockImplementation(async (...args) => {
    const d = JSON.parse(args[2]), review = mockSupportReview(d)
    if (review) return review
    if (d.term_id) return JSON.stringify({ definition: [{ text: '同一研究方法。', keys: d.contributions.map((item: any) => item.key) }], usage: [], findings: [], differences: [] })
    const output = JSON.parse(await original(...args))
    if (d.paragraphs) output.terms = d.paragraphs.map((part: any) => ({ paragraph_id: part.paragraph_id, name: '共同术语', referent: '稳定研究方法', category: '方法', aliases: [], locator: part.locator, note: '原文说明：' + part.text }))
    return JSON.stringify(output)
  })
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 资料a\n\n甲组共同术语代表研究方法。')
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '甲组共同术语适用于研究。')
  const check = async (ids: string[]) => {
    const manifest = await snapshotManifest(f.root), indices = Object.entries(manifest.deps!.pages).filter(([page]) => page.startsWith('terms/index-'))
    expect(indices).toHaveLength(1)
    for (const [page, deps] of indices) {
      expect(topicHeader(await versionFile(f.root, manifest.version!, page)).sources).toEqual(ids)
      expect(deps.sources).toEqual(ids)
      expect([...new Set(deps.terms!.flatMap(term => term.contributions.map(item => item.source_id)))].sort()).toEqual(ids)
    }
  }
  await buildLayeredLibrary(f.options); await check(['S-0001', 'S-0002'])
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 资料a\n\n甲组共同术语代表研究方法，适用于新增条件。')
  await buildLayeredLibrary(f.options); await check(['S-0001', 'S-0002'])
  await revokeLayeredSources(f.knowledgeRoot, ['S-0002'], '测试撤权')
  await buildLayeredLibrary(f.options); await check(['S-0001'])
  f.call.mockClear(); f.embed.mockClear()
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ unchanged: true, modelCalls: 0 })
  expect(f.call).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled()
})

it('根索引解析同目录、父目录和页内锚点，外部URL保持原样', async () => {
  const f = await pendingFixture(), [first, second] = f.pending.topics!.state.topics
  first!.summary = `[同目录](${path.posix.basename(second!.path)}) [来源](../sources/S-0001.md) [本页](#说明) [外部](https://example.com/a#b)`
  await publishLibrary(f.root, f.pending)
  const index = await versionFile(f.root, f.pending.version!, 'index.md')
  expect(index).toContain(`](${second!.path})`)
  expect(index).toContain('](sources/S-0001.md)')
  expect(index).toContain(`](${first!.path}#说明)`)
  expect(index).toContain('](https://example.com/a#b)')
})

it('根索引摘要引用不存在的本地页面时拒绝发布并给出目标', async () => {
  const f = await pendingFixture()
  f.pending.topics!.state.topics[0]!.summary = '[不存在](missing.md)'
  await expect(publishLibrary(f.root, f.pending)).rejects.toThrow('根索引相对链接目标不存在：topics/missing.md')
})

it('根索引缺口中的证据和子页链接按原主题目录重定位，已隔离目标只保留说明', async () => {
  const f = await pendingFixture()
  f.pending.manifest.topic_gaps = [{ topic_id: 'T-0001-01', point_ids: [], message: '核对缺口 [证据](../../sources/S-0001.md#^p) [相关主题](../T-0002.md) [已隔离主题](missing.md)' }]
  await publishLibrary(f.root, f.pending)
  const index = await versionFile(f.root, f.pending.version!, 'index.md')
  expect(index).toContain('[证据](sources/S-0001.md#^p)')
  expect(index).toContain('[相关主题](topics/T-0002.md)')
  expect(index).toContain('已隔离主题')
  expect(index).not.toContain('](missing.md)')
  for (const match of index.matchAll(/\]\(([^)]+)\)/g)) expect(Object.keys(f.pending.manifest.pages!)).toContain(match[1]!.split('#')[0])
})
