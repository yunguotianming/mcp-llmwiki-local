import { expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { extractSource } from '../src/layered/extraction.js'
import { readLocalSource } from '../src/layered/snapshot.js'
import type { BuildLayeredOptions, Extraction } from '../src/layered/schema.js'

const textOf = (data: any, part: any): string => part.text ?? data.evidence_dictionary[part.evidence_ref].quote
const point = (part: any, text: string) => ({ paragraph_id: part.paragraph_id, text, section: '主要发现',
  evidence: [{ paragraph_id: part.paragraph_id, locator: part.locator, quote: text }] })
const output = (points: any[], summary?: number[], reason: string | null = null) => JSON.stringify({ tags: ['方法', '研究', '样本'],
  credibility: 'unknown', credibility_reason: reason, points, terms: [], ...(summary ? { summary_point_indices: summary } : {}) })

async function fixture(text: string, respond: (data: any) => string, minimum = 0) {
  const directory = await mkdtemp(path.join(tmpdir(), 'llmwiki-extract-recovery-')), root = path.join(directory, '.llmwiki')
  await mkdir(root)
  const file = path.join(directory, 'source.md')
  await writeFile(file, text, 'utf8')
  const source = await readLocalSource(file, '合成测试'), requests: any[] = []
  const options: BuildLayeredOptions = { knowledgeRoot: '离线提取回归', tier: 5, topics: { sourceChapterMinPoints: minimum }, client: {
    info: async () => ({ provider: 'mock', id: 'extract', name: '假模型' }), concurrency: () => 1,
    call: async (_task, _system, raw) => { const data = JSON.parse(raw); requests.push(data); return respond(data) },
  } }
  const run = (previous?: Extraction) => extractSource(root, 'S-0001', source,
    { tier: 5, granularity: 'custom', prompt_version: '摘要与章节回归' }, options, 98304, previous)
  return { run, requests }
}

it('合法null说明的组只补摘要，成功要点保持原字节', async () => {
  const f = await fixture('甲研究纳入20人，随访3个月。', data => data.summary_id
    ? JSON.stringify({ point_ids: data.children[0].points.map((item: any) => item.point_id) })
    : output([point(data.paragraphs[0], textOf(data, data.paragraphs[0]))], [99]))
  const first = await f.run(), before = JSON.stringify(first.segments)
  f.requests.length = 0
  const second = await f.run(first)
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0].summary_id).toBeTruthy()
  expect(f.requests[0].paragraphs).toBeUndefined()
  expect(JSON.stringify(second.segments)).toBe(before)
  expect(second.gaps).toEqual([])
})

it('摘要和结构缺口共存时保留成功组，只重试摘要并保留细项诊断', async () => {
  const f = await fixture('甲研究纳入20人，随访3个月。', data => {
    if (data.summary_id) return JSON.stringify({ point_ids: data.children[0].points.map((item: any) => item.point_id) })
    if (data.correction_stage) return JSON.stringify({ items: [] })
    const valid = point(data.paragraphs[0], textOf(data, data.paragraphs[0]))
    return output([valid, { ...valid, text: 7 }], [99], '合成来源')
  })
  const first = await f.run(), before = JSON.stringify(first.segments)
  expect(first.gaps!.map(gap => gap.kind)).toEqual(['point', 'summary'])
  f.requests.length = 0
  const second = await f.run(first)
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0].summary_id).toBeTruthy()
  expect(JSON.stringify(second.segments)).toBe(before)
  expect(second.gaps!.map(gap => gap.kind)).toEqual(['point'])
  expect(second.correction_attempts).toEqual(first.correction_attempts)
})

it('摘要与未核实缺口共存时不重新提取，也不把未核实点改成有效', async () => {
  const f = await fixture('甲研究纳入20人，随访3个月。', data => data.summary_id
    ? JSON.stringify({ point_ids: data.children[0].points.map((item: any) => item.point_id) })
    : output([point(data.paragraphs[0], textOf(data, data.paragraphs[0]))], [99], '合成来源'))
  const first = await f.run(), saved = first.segments[0]!.points[0]!
  saved.verification = { status: 'unverified', missing: '缺少结论所需条件', fingerprint: '合成核对指纹' }
  first.gaps!.push({ kind: 'unverified_claim', segment_hashes: [first.segments[0]!.text_hash],
    item: { point_id: saved.point_id }, reasons: [{ rule: 'semantic-support', expected: '完整支撑', actual: '缺少结论所需条件' }] })
  const before = JSON.stringify(first.segments)
  f.requests.length = 0
  const second = await f.run(first)
  expect(f.requests).toHaveLength(1)
  expect(f.requests[0].summary_id).toBeTruthy()
  expect(JSON.stringify(second.segments)).toBe(before)
  expect(second.gaps!.map(gap => gap.kind)).toEqual(['unverified_claim'])
})

it('另一章证据不能凭主段号满足本章覆盖，只补该章的真实事实', async () => {
  const f = await fixture('# 甲章\n\n甲研究纳入20人，随访3个月。\n\n# 乙章\n\n乙研究采用随机分组，随访6个月。', data => {
    const parts = data.paragraphs.filter((part: any) => !textOf(data, part).startsWith('#'))
    if (data.coverage) return output([point(parts[0], textOf(data, parts[0]))])
    const first = point(parts[0], textOf(data, parts[0]))
    return output([first, { ...first, paragraph_id: parts[1].paragraph_id }])
  }, 1)
  const result = await f.run(), supplements = f.requests.filter(request => request.coverage)
  expect(supplements).toHaveLength(1)
  expect(supplements[0].paragraphs.some((part: any) => textOf(supplements[0], part).includes('乙研究'))).toBe(true)
  expect(supplements[0].point_limit).toBe(1)
  expect(result.segments.flatMap(segment => segment.points).some(item => item.text === '乙研究采用随机分组，随访6个月。')).toBe(true)
})

it('合法跨章联合证据同时计入对应章节，原主张与全部证据保持', async () => {
  const f = await fixture('# 甲章\n\n甲研究纳入20人。\n\n# 乙章\n\n乙研究纳入30人。', data => {
    const parts = data.paragraphs.filter((part: any) => !textOf(data, part).startsWith('#'))
    return output([{ paragraph_id: parts[0].paragraph_id, text: '甲研究纳入20人，乙研究纳入30人。', section: '主要发现',
      evidence: parts.map((part: any) => ({ paragraph_id: part.paragraph_id, locator: part.locator, quote: textOf(data, part) })) }])
  }, 1)
  const result = await f.run(), points = result.segments.flatMap(segment => segment.points)
  expect(f.requests).toHaveLength(1)
  expect(points).toHaveLength(1)
  expect(points[0]!.evidence).toHaveLength(2)
  expect(result.gaps).toEqual([])
})
