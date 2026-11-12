import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { claimWriter } from '../src/layered/devices.js'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { reviewExtraction } from '../src/layered/review.js'
import { reviewTopicContent } from '../src/layered/topic-review.js'
import { cleanupLayeredFixtures, layeredFixture, snapshotManifest } from './layered-fixture.js'
import { extractionFixture, output, point, reviewFixture } from './quality-fix2-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
beforeEach(() => vi.stubGlobal('fetch', () => { throw new Error('离线回归禁止网络请求') }))
afterEach(() => { cleanupLayeredFixtures(); vi.unstubAllGlobals() })

it('B11 升级：真实 v0.1.1 已发布库未变增量零调用且版本不变', async () => {
  const baseline = JSON.parse(await readFile(new URL('./fixtures/v011-published.json', import.meta.url), 'utf8'))
  expect(baseline.commit).toBe('b22dec2')
  const f = await layeredFixture()
  await claimWriter(f.root)
  for (const [relative, text] of Object.entries(baseline.files)) {
    const file = path.join(f.knowledgeRoot, relative)
    await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, text as string)
  }
  await utimes(path.join(f.knowledgeRoot, 'a.md'), new Date('2026-11-01'), new Date('2026-11-01'))
  f.options.topics = false
  f.options.client.info = async () => ({ provider: 'mock', id: 'review', name: '测试模型', context: { contextWindow: 128000 } })
  const before = await snapshotManifest(f.root)
  f.options.name = before.card.name; f.options.domain = before.card.domain
  const result = await buildLayeredLibrary(f.options)
  expect(f.call, '未变升级不得重提或重核对').not.toHaveBeenCalled()
  expect(result).toMatchObject({ unchanged: true, version: before.version, modelCalls: 0 })
  expect((await snapshotManifest(f.root)).version).toBe(before.version)
})

it.each([
  ['否定翻转', '研究显示，甲组没有参与研究。', '研究显示，甲组参与研究。'],
  ['数字改变', '研究显示，甲组纳入30人。', '研究显示，甲组纳入31人。'],
  ['归属改变', '研究显示，甲组参与研究。', '研究显示，乙组参与研究。'],
  ['肯定翻转', '研究显示，甲组参与研究。', '研究显示，甲组没有参与研究。'],
  ['研究归属', '研究显示，根据甲研究，护士负责访谈。', '研究显示，根据乙研究，护士负责访谈。'],
  ['陌生谓语', '研究显示，甲组访谈学生。', '研究显示，乙组访谈学生。'],
  ['否定范围', '研究显示，甲组参与研究并且没有提供数据。', '研究显示，甲组没有参与研究并且提供数据。'],
  ['英文归属', '研究显示，Alpha interviewed students.', '研究显示，Beta interviewed students.'],
])('B11 综合句：%s拒收并留缺口', async (_kind, original, changed) => {
  const f = reviewFixture(), members = [point(original!.replace('研究显示，', ''), '主要发现', 'S-0001:p')]
  const before = structuredClone(members), link = '[依据](../sources/S-0001.md#p)'
  f.call.mockImplementation(async (_task, _system, raw) => {
    const d = JSON.parse(raw)
    return JSON.stringify(d.review_stage === 'topic-correction'
      ? { sentences: d.sentences.map((s: any) => ({ id: s.id, text: s.text.replace(original, changed), point_ids: ['P1'], support: '完整支撑', missing: null })) }
      : { items: d.sentences.map((s: any) => ({ id: s.id, support: s.text.includes(original) ? '不支撑' : '完整支撑', missing: s.text.includes(original) ? '主张待纠正' : null })) })
  })
  const result = await reviewTopicContent('T-0001', '# 主题\n\n' + original + link, members, f.options)
  expect(result.content).not.toContain(changed)
  expect(result.content).not.toContain(original)
  expect(result.review!.removed).toHaveLength(1)
  expect(members).toEqual(before)
})

it.each([
  ['改措辞', '研究显示，甲组采用访谈。', '研究表明，甲组采用访谈。'],
  ['删分句', '研究显示，甲组采用访谈，并且效果显著。', '研究显示，甲组采用访谈。'],
])('B11 合法纠正：%s仍接受', async (_kind, original, changed) => {
  const f = reviewFixture(), members = [point('甲组采用访谈。', '方法', 'S-0001:p')]
  const link = '[依据](../sources/S-0001.md#p)'
  f.call.mockImplementation(async (_task, _system, raw) => {
    const d = JSON.parse(raw)
    return JSON.stringify(d.review_stage === 'topic-correction'
      ? { sentences: d.sentences.map((s: any) => ({ id: s.id, text: s.text.replace(original, changed), point_ids: ['P1'], support: '完整支撑', missing: null })) }
      : { items: d.sentences.map((s: any) => ({ id: s.id, support: s.text.includes(original) ? '不支撑' : '完整支撑', missing: s.text.includes(original) ? '措辞或多余分句待纠正' : null })) })
  })
  const result = await reviewTopicContent('T-0001', '# 主题\n\n' + original + link, members, f.options)
  expect(result.content).toContain(changed)
  expect(result.review!.removed).toEqual([])
  expect(result.failure).toBeUndefined()
})

const shortChapters = Array.from({ length: 10 }, (_, i) => '# 第' + (i + 1) + '节研究结果\n\n第' + (i + 1) + '项研究纳入' + (i + 10) + '人并持续12周。').join('\n\n')
async function chapterFixture(complete: boolean) {
  const f = await extractionFixture(shortChapters)
  f.call.mockImplementation(async (_task, _system, raw) => {
    const d = JSON.parse(raw)
    const result = (input: any) => output({ ...input, point_limit: complete ? 50 : input.point_limit })
    return JSON.stringify(d.coverage === 'chapters' ? { chapters: d.chapters.map((c: any) => ({ chapter_id: c.chapter_id, points: result(c).points })) } : result(d))
  })
  return f
}
it('B11 短章：篇级50不受单包5限制，每章覆盖且不少于旧版10条', async () => {
  const f = await chapterFixture(false), result = await f.run()
  const baseline = JSON.parse(await readFile(new URL('./fixtures/v011-published.json', import.meta.url), 'utf8')).short_chapters
  expect(f.source.text).toBe(baseline.text)
  expect(baseline.chapter_counts).toEqual(Array(10).fill(1))
  expect(result.point_limit).toBe(50)
  expect(result.chapters).toHaveLength(10)
  for (const chapter of result.chapters!) expect(chapter.paragraph_ids.flatMap(id => result.segments[id]!.points).length, chapter.title).toBeGreaterThanOrEqual(1)
  expect(result.segments.flatMap(s => s.points).length).toBeGreaterThanOrEqual(baseline.point_count)
  expect(result.gaps?.filter(g => g.reasons.some(r => r.rule === 'chapter-coverage' || r.rule === 'chapter-quota'))).toEqual([])
})
it('B11 短章对照：首提已达每章底线不补提', async () => {
  const f = await chapterFixture(true), result = await f.run()
  expect(result.segments.flatMap(s => s.points)).toHaveLength(10)
  expect(f.call).toHaveBeenCalledTimes(1)
  expect(f.call.mock.calls.filter(c => JSON.parse(c[2]).coverage)).toEqual([])
})

it('B11 同键并发核对：两个对象都回填且只调用一次', async () => {
  const storage = await layeredFixture(), f = reviewFixture()
  f.options.knowledgeRoot = storage.knowledgeRoot; f.options.wikiPath = storage.root
  const a = f.extraction, b = structuredClone(a), checkpoints = [vi.fn(async () => {}), vi.fn(async () => {})]
  const started = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>()
  f.call.mockImplementation(async (_task, _system, raw) => { started.resolve(); await finish.promise; return JSON.stringify(output(JSON.parse(raw))) })
  const first = reviewExtraction(a, f.source, f.options, 100000, checkpoints[0])
  const second = reviewExtraction(b, f.source, f.options, 100000, checkpoints[1])
  await started.promise; finish.resolve(); await Promise.all([first, second])
  expect(f.call).toHaveBeenCalledTimes(1)
  for (const [i, extraction] of [a, b].entries()) {
    expect(extraction.segments[0]!.points[0]!.verification?.status, '订阅者' + i).toBe('verified')
    expect(checkpoints[i]).toHaveBeenCalled()
  }
  b.segments[0]!.points[0]!.verification!.missing = '调用方修改'
  expect(a.segments[0]!.points[0]!.verification!.missing).toBe('')
})
