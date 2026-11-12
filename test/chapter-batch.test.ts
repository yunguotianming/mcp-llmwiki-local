import { expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { extractSource } from '../src/layered/extraction.js'
import { readLocalSource } from '../src/layered/snapshot.js'
import type { BuildLayeredOptions } from '../src/layered/schema.js'

async function fixture({ count = 12, chars = 60, inputLimit = 98304, outputLimit = 16384, concurrency = 3, invalid = false as boolean | 'schema' } = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'b4-batch-')), file = path.join(root, 'source.md'), requests: { prompt: string; data: any }[] = []
  await mkdir(path.join(root, '.llmwiki'))
  await writeFile(file, Array.from({ length: count }, (_, index) => `# 章节${index}\n\n章节${index}的结论成立。\n${'正'.repeat(chars)}`).join('\n\n'), 'utf8')
  const source = await readLocalSource(file, '测试')
  const points = (data: any) => {
    const part = data.paragraphs.find((part: any) => !(part.text ?? data.evidence_dictionary[part.evidence_ref]?.quote).startsWith('#'))
    if (!part) return []
    const quote = (part.text ?? data.evidence_dictionary[part.evidence_ref].quote).split('\n')[0]
    return [{ paragraph_id: part.paragraph_id, text: quote, section: '主要发现', evidence: [{ paragraph_id: part.paragraph_id, locator: part.locator, quote }] }]
  }
  const options: BuildLayeredOptions = { knowledgeRoot: root, tier: count, topics: { sourceChapterMinPoints: 1 }, client: {
    concurrency: () => concurrency,
    info: async () => ({ provider: 'mock', id: 'mock', name: '假模型', defaultMaxTokens: outputLimit }),
    call: async (_task, prompt, input) => {
      const data = JSON.parse(input); requests.push({ prompt, data })
      await new Promise(resolve => setTimeout(resolve, (data.chapters?.[0]?.paragraphs?.[0]?.paragraph_id ?? data.paragraphs?.[0]?.paragraph_id ?? 0) % 5))
      if (data.summary_id) return JSON.stringify({ point_ids: data.children.flatMap((child: any) => child.points.map((point: any) => point.point_id)).slice(0, data.point_limit) })
      if (data.chapters) return JSON.stringify({ chapters: data.chapters.flatMap((chapter: any, index: number) => {
        if (invalid === true && index === 1) return []
        return [{ chapter_id: invalid === true && index === 2 ? '不存在的章节' : chapter.chapter_id,
          points: invalid === 'schema' && index === 1 ? [{}] : invalid === true && index === 0 ? [] : points(chapter) }]
      }) })
      return JSON.stringify({ tags: ['方法', '研究', '样本'], credibility: 'unknown', credibility_reason: null,
        points: data.coverage ? points(data) : [], terms: [], summary_point_indices: [] })
    },
  } }
  const result = await extractSource(root, 'S-0001', source, { tier: count, granularity: 'custom', prompt_version: 'v1' }, options, inputLimit)
  return { result, requests, batches: requests.filter(request => request.data.chapters), singles: requests.filter(request => request.data.coverage && !request.data.chapters) }
}

it('打包：遗漏和无效章ID单章回退，明确空结果不重补，其余章节正常保留', async () => {
  const { result, batches, singles } = await fixture({ count: 4, invalid: true })
  expect(batches).toHaveLength(1); expect(singles).toHaveLength(2)
  expect(singles.map(request => request.data.coverage)).toEqual(result.chapters!.slice(1, 3).map(chapter => chapter.id))
  expect(result.segments.flatMap(segment => segment.points)).toHaveLength(3)
  expect(result.gaps!.filter(gap => gap.reasons.some(reason => reason.rule === 'chapter-coverage'))).toHaveLength(1)
  const malformed = await fixture({ count: 3, invalid: 'schema' })
  expect(malformed.singles).toHaveLength(1)
  expect(malformed.result.segments.flatMap(segment => segment.points)).toHaveLength(3)
})

it('打包：最多8章且正文超过12KB拆包，所有原文完整保留', async () => {
  const short = await fixture()
  expect(short.batches.map(request => request.data.chapters.length)).toEqual([8, 4])
  const large = await fixture({ count: 5, chars: 1800 })
  expect(large.batches.map(request => request.data.chapters.length)).toEqual([2, 2])
  expect(large.singles).toHaveLength(1)
  for (const request of [...large.batches.flatMap(request => request.data.chapters), ...large.singles.map(request => request.data)]) {
    expect(request.paragraphs.some((part: any) => (part.text ?? request.evidence_dictionary[part.evidence_ref]?.quote).includes('正'.repeat(1800)))).toBe(true)
  }
})

it('打包：完整请求受输入预算限制，不能只按正文预算装包', async () => {
  const { batches, singles, requests } = await fixture({ count: 9, inputLimit: 6000 })
  expect(batches[0]!.data.chapters.length).toBeLessThan(8)
  expect(batches.length + singles.length).toBeGreaterThan(1)
  for (const request of requests) expect(Buffer.byteLength(request.prompt + JSON.stringify(request.data))).toBeLessThanOrEqual(6000)
})

it('打包：输出预算按各章缺额累计限制包大小', async () => {
  const { batches, singles } = await fixture({ count: 5, outputLimit: 1280 })
  expect(batches.map(request => request.data.chapters.length)).toEqual([2, 2])
  expect(singles).toHaveLength(1)
})

it('打包：30、3、1路的包边界和最终提取结果逐字节一致', async () => {
  for (const invalid of [false, true]) {
    const results = []
    for (const concurrency of [30, 3, 1]) results.push(await fixture({ count: 18, concurrency, invalid }))
    const boundaries = (value: typeof results[number]) => value.batches.map(request => request.data.chapters.map((chapter: any) => chapter.chapter_id))
    expect(boundaries(results[0]!)).toEqual(boundaries(results[1]!)); expect(boundaries(results[1]!)).toEqual(boundaries(results[2]!))
    expect(JSON.stringify(results[0]!.result)).toBe(JSON.stringify(results[1]!.result))
    expect(JSON.stringify(results[1]!.result)).toBe(JSON.stringify(results[2]!.result))
  }
}, 15000)
