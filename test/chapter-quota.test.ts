import { expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { allocateChapterQuotas } from '../src/domain/granularity.js'
import { extractSource } from '../src/layered/extraction.js'
import { readLocalSource } from '../src/layered/snapshot.js'
import type { BuildLayeredOptions } from '../src/layered/schema.js'

it('名额充足：先每章一条，补底线，再严格按长度比例分余量', () => {
  expect(allocateChapterQuotas([10000, 20000, 30000], [1, 2, 3], 12)).toEqual([2, 4, 6])
  expect(allocateChapterQuotas([0, 10000, 20000], [0, 1, 2], 6)).toEqual([0, 2, 4])
})

it('名额够每章一条但不够底线：先补最长章，不降低其他章底线', () => {
  expect(allocateChapterQuotas([30000, 10000, 20000], [3, 1, 2], 4)).toEqual([2, 1, 1])
})

it('名额不足每章一条：从最长章开始，等长按原顺序', () => {
  expect(allocateChapterQuotas([3000, 1000, 3000, 5000], [1, 1, 1, 1], 2)).toEqual([1, 0, 0, 1])
  expect(allocateChapterQuotas([1, 2], [1, 1], 0)).toEqual([0, 0])
})

async function run(limit: number, mode: '超额首提' | '空首提') {
  const root = await mkdtemp(path.join(tmpdir(), 'b4-quota-')), file = path.join(root, 'source.md')
  await mkdir(path.join(root, '.llmwiki'))
  await writeFile(file, '# 甲\n\n甲的第一项事实。甲的第二项事实。甲的第三项事实。\n\n# 乙\n\n乙的第一项事实。乙的第二项事实。乙的第三项事实。\n\n# 丙\n\n丙的事实。', 'utf8')
  const source = await readLocalSource(file, '测试'), requests: any[] = []
  const options: BuildLayeredOptions = { knowledgeRoot: root, tier: limit, topics: { sourceChapterMinPoints: 1 }, client: {
    info: async () => ({ provider: 'mock', id: 'mock', name: '假模型' }), call: async (_task, _system, input) => {
      const data = JSON.parse(input); requests.push(data)
      if (data.chapters) return JSON.stringify({ chapters: data.chapters.map((chapter: any) => {
        const part = chapter.paragraphs.find((part: any) => !(part.text ?? chapter.evidence_dictionary[part.evidence_ref]?.quote).startsWith('#'))
        const points = (part.text ?? chapter.evidence_dictionary[part.evidence_ref].quote).split('。').filter(Boolean).slice(0, chapter.point_limit).map((text: string) => ({
          paragraph_id: part.paragraph_id, text: text + '。', section: '主要发现', evidence: [{ paragraph_id: part.paragraph_id, locator: part.locator, quote: text + '。' }],
        }))
        return { chapter_id: chapter.chapter_id, points }
      }) })
      const parts = data.paragraphs.filter((part: any) => !(part.text ?? data.evidence_dictionary[part.evidence_ref]?.quote).startsWith('#'))
      const point = (part: any, text: string) => ({ paragraph_id: part.paragraph_id, text, section: '主要发现', evidence: [{ paragraph_id: part.paragraph_id, locator: part.locator, quote: text }] })
      const points = data.coverage ? parts[0] ? (parts[0].text ?? data.evidence_dictionary[parts[0].evidence_ref].quote).split('。').filter(Boolean).slice(0, data.point_limit).map((text: string) => point(parts[0], text + '。')) : []
        : mode === '超额首提' ? (parts[0].text ?? data.evidence_dictionary[parts[0].evidence_ref].quote).split('。').filter(Boolean).map((text: string) => point(parts[0], text + '。')) : []
      return JSON.stringify({ tags: ['方法', '研究', '样本'], credibility: 'unknown', credibility_reason: null, points, terms: [] })
    },
  } }
  return { requests, result: await extractSource(root, 'S-0001', source, { tier: limit, granularity: 'custom', prompt_version: 'v1' }, options, 98304) }
}

it('只补差额：有名额的章补提后全部保留，超额首提不会挤掉新增要点', async () => {
  const { requests, result } = await run(4, '超额首提')
  const supplements = requests.flatMap(request => request.chapters ?? (request.coverage ? [request] : []))
  expect(supplements.map(request => request.point_limit)).toEqual([1, 1])
  expect(supplements.every(request => request.existing_points.length === 0)).toBe(true)
  expect(result.segments.flatMap(segment => segment.points).map(point => point.text)).toContain('乙的第一项事实。')
  expect(result.segments.flatMap(segment => segment.points).map(point => point.text)).toContain('丙的事实。')
  expect(result.segments.reduce((sum, segment) => sum + segment.points.length, 0)).toBe(4)
  expect(result.truncations!.reduce((sum, item) => sum + item.count, 0)).toBe(1)
})

it('零名额章不补提并记录配额不足，缺口不算达标', async () => {
  const { requests, result } = await run(1, '空首提')
  expect(requests.filter(request => request.coverage)).toHaveLength(1)
  expect(result.chapters!.map(chapter => chapter.quota)).toEqual([1, 0, 0])
  expect(result.gaps!.filter(gap => gap.reasons.some(reason => reason.rule === 'chapter-quota'))).toHaveLength(2)
  expect(result.chapters!.filter(chapter => !chapter.quota).every(chapter => chapter.paragraph_ids.every(id => !result.segments[id]!.points.length))).toBe(true)
})
