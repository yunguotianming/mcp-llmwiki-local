import { rename, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary, readLayeredPage } from '../src/layered/index.js'
import { topicHeader } from '../src/layered/topics.js'
import { readExtraction } from '../src/layered/publication.js'
import { writeVersion } from '../src/layered/objects.js'
import { writeJson } from '../src/layered/files.js'
import { cleanupLayeredFixtures, modelOutput, snapshotManifest } from './layered-fixture.js'
import { auditFixture } from './merged-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('M09 三文件循环互换再改名、副本新增与删其一，向量补标随来源ID继承', async () => {
  const f = await auditFixture(3); await buildLayeredLibrary(f.options)
  const before = await snapshotManifest(f.root)
  const vectorIds = Object.fromEntries(Object.entries(before.topics!.vectors).map(([id, ref]) => [id, ref.vector_id]))
  f.call.mockClear(); f.embed.mockClear()
  for (const [target, original] of [['a.md', 'c.md'], ['b.md', 'a.md'], ['c.md', 'b.md']]) await writeFile(path.join(f.knowledgeRoot, target!), f.originals.get(original!)!)
  await buildLayeredLibrary(f.options)
  const swapped = await snapshotManifest(f.root)
  expect(swapped.sources.map(s => [s.source_id, s.current_path]).sort()).toEqual([['S-0001', 'b.md'], ['S-0002', 'c.md'], ['S-0003', 'a.md']])
  await rename(path.join(f.knowledgeRoot, 'b.md'), path.join(f.knowledgeRoot, 'renamed.md'))
  await writeFile(path.join(f.knowledgeRoot, 'copy.md'), f.originals.get('a.md')!)
  await buildLayeredLibrary(f.options)
  await unlink(path.join(f.knowledgeRoot, 'renamed.md')); await buildLayeredLibrary(f.options)
  const now = await snapshotManifest(f.root)
  expect(now.sources).toHaveLength(3)
  expect(now.sources.find(s => s.source_id === 'S-0001')!.current_path).toBe('copy.md')
  expect(now.point_labels).toEqual(before.point_labels)
  expect(Object.fromEntries(Object.entries(now.topics!.vectors).map(([id, ref]) => [id, ref.vector_id]))).toEqual(vectorIds)
  expect(f.call).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled()
})

it('M10 离线继续后恢复归属，核对删句同步候选、导航、sources和索引', async () => {
  const f = await auditFixture()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组患者和公众未作贡献。')
  await buildLayeredLibrary(f.options)
  const before = await snapshotManifest(f.root), original = f.call.getMockImplementation()!, embed = f.embed.getMockImplementation()!
  f.options.topics = { ...f.options.topics || {}, embeddingUnavailable: 'continue' }
  f.embed.mockRejectedValue(new Error('合成离线'))
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '甲组学生学习体验。')
  await buildLayeredLibrary(f.options)
  const offline = await snapshotManifest(f.root)
  expect(offline.vector_state!.pending_points).toHaveLength(4)
  f.call.mockImplementation(async (...args) => {
    const d = JSON.parse(args[2])
    if (d.review_stage === 'topic') return JSON.stringify({ items: d.sentences.map((s: any) => ({ id: s.id,
      support: /未参与|学生/.test(s.text) ? '不支撑' : '完整支撑', missing: /未参与|学生/.test(s.text) ? '贡献不等于参与，学生不等于患者' : null })) })
    if (d.review_stage === 'topic-correction') return JSON.stringify({ sentences: d.sentences.filter((s: any) => s.text.includes('未参与')).map((s: any) => ({ id: s.id,
      text: '# 患者和公众未作贡献', point_ids: [d.members.find((p: any) => p.text.includes('未作贡献')).point_id], support: '完整支撑', missing: null })) })
    if (d.topic_id) {
      const points = [...(d.current_points ?? []), ...d.points]
      // 标题从有支撑的原主张生成；纠正不能把“未参与”改写为“未贡献”。
      return JSON.stringify({ title: '患者和公众未作贡献', summary: '患者和公众未作贡献。', aliases: ['学生学习'], consensus: [], differences: [], conditions: [
        { text: '患者和公众未作贡献。', point_ids: [points.find((p: any) => p.source_id === 'S-0001').point_id] },
        { text: '学生学习说明患者体验。', point_ids: [points.find((p: any) => p.source_id === 'S-0002').point_id] },
      ] })
    }
    return original(...args)
  })
  f.embed.mockImplementation(embed); f.requests.length = 0
  await buildLayeredLibrary(f.options)
  const now = await snapshotManifest(f.root), topic = now.topics!.topics[0]!
  const page = await readLayeredPage(f.knowledgeRoot, topic.path)
  expect(now.vector_state!.identity).toEqual(before.vector_state!.identity)
  // 删句后已无引用的来源按产品规则回到待归属；检查标题与导航，而非要求错误归属保留。
  expect(now.topic_gaps).toHaveLength(1); expect(now.topic_gaps![0]!.message).toContain('删除未支撑句')
  expect(now.vector_state!.pending_points).toEqual(offline.vector_state!.pending_points); expect(f.requests).toHaveLength(0)
  expect(topicHeader(page)).toMatchObject({ title: '患者和公众未作贡献', aliases: [], sources: ['S-0001'] })
  expect(now.topics!.candidates?.flat().filter(id => id.startsWith('S-0002:'))).toHaveLength(4)
  expect(page).not.toContain('未参与'); expect(page).not.toContain('S-0002')
  expect(await readLayeredPage(f.knowledgeRoot)).toContain('患者和公众未作贡献')
  expect(await readLayeredPage(f.knowledgeRoot, 'sources/S-0002.md')).toContain('学生学习')
})

it('M11 篇级选点遇章节局部修改，其他来源提取补标向量均零调用', async () => {
  const f = await auditFixture(2), original = f.call.getMockImplementation()!
  f.options.granularity = 'minimal'
  f.options.tier = 5 // 极简档显式配对五点上限，避免依赖已取消的标准档短文降额。
  const article = '# 甲组研究\n\n## 第一节\n\n甲组第一节固定事实。\n\n## 第二节\n\n甲组第二节原有事实。'
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), article)
  f.call.mockImplementation(async (...args) => {
    const d = JSON.parse(args[2])
    if (!d.paragraphs) return original(...args)
    f.requests.push({ system: args[1], input: d })
    const output = JSON.parse(modelOutput(d)); output.terms = []
    output.points = d.paragraphs.filter((p: any) => !p.text.startsWith('#')).flatMap((p: any) => ['主要发现', '对象与条件', '方法', '限制'].map(section => ({ paragraph_id: p.paragraph_id,
      text: `${section}：${p.text}`, section, evidence: [{ locator: p.locator, quote: p.text }] })))
    return JSON.stringify(output)
  })
  await buildLayeredLibrary(f.options)
  const old = await snapshotManifest(f.root), untouched = old.sources.find(s => s.current_path === 'b.md')!
  const selected = await readExtraction(f.root, old.sources.find(s => s.current_path === 'a.md')!.extract.path)
  expect(selected.segments.flatMap(s => s.points)).toHaveLength(selected.point_limit!)
  f.call.mockClear(); f.embed.mockClear(); f.requests.length = 0
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), article.replace('原有事实', '更新事实'))
  await buildLayeredLibrary(f.options)
  const now = await snapshotManifest(f.root)
  expect(f.requests.map(r => r.input.source_id)).toEqual(['S-0001'])
  expect(now.sources.find(s => s.source_id === untouched.source_id)!.extract).toEqual(untouched.extract)
  const labels = f.call.mock.calls.map(c => JSON.parse(c[2])).filter(d => d.label_stage)
  expect(labels.flatMap(d => d.points.map((p: any) => p.point_id.split(':')[0]))).not.toContain(untouched.source_id)
  expect(f.embed.mock.calls.flatMap(c => c[0]).some(text => text.includes('第1篇'))).toBe(false)
})

it('M12 无产出模型字段及旧指纹的库升级后至多重提一次，第二次零调用', async () => {
  const f = await auditFixture(); await buildLayeredLibrary(f.options)
  const legacy = await snapshotManifest(f.root), source = legacy.sources[0]!, extraction = await readExtraction(f.root, source.extract.path)
  legacy.version = 'v000002'; delete legacy.vector_state; delete source.models
  delete source.extract.processing.prompt_hash; source.extract.processing.model = '旧供应商/旧模型'; source.extract.processing_fingerprint = '旧算法指纹'
  delete extraction.processing.prompt_hash; extraction.processing.model = '旧供应商/旧模型'
  source.extract.path = 'work/merged-audit-legacy.json'; await writeJson(f.root, source.extract.path, extraction)
  await writeVersion(f.root, legacy); await writeJson(f.root, 'state/current.json', { version: legacy.version, revocation_generation: 0 })
  f.requests.length = 0; await buildLayeredLibrary(f.options)
  expect(f.requests.length).toBeLessThanOrEqual(1)
  const upgraded = await snapshotManifest(f.root)
  expect(upgraded.vector_state!.identity!.model).toBe('qwen3-embedding:0.6b')
  f.call.mockClear(); f.embed.mockClear()
  await buildLayeredLibrary(f.options)
  expect(f.call).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled()
  expect((await snapshotManifest(f.root)).sources[0]!.extract.path).toBe(upgraded.sources[0]!.extract.path)
})
