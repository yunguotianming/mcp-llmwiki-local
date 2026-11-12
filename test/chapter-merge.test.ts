import { expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { parseMarkdown } from '../src/ingest/markdown.js'
import { hash } from '../src/layered/files.js'
import { bodyCharacters, originalSourceChapters, sourceChapters } from '../src/layered/longdoc.js'
import { extractSource } from '../src/layered/extraction.js'
import { readLocalSource, type LocalSource } from '../src/layered/snapshot.js'
import type { BuildLayeredOptions } from '../src/layered/schema.js'

export function chapterSource(text: string): LocalSource {
  return { path: '章节.md', text, bytes: Buffer.from(text), contentHash: hash(text),
    metadata: { title: '章节', source_type: '书', credibility: 'unknown', credibility_reason: '测试', source_date: '2026-11-11', source_date_basis: '原文日期' },
    segments: parseMarkdown(text).children.map(node => ({ start: node.position!.start.offset!, end: node.position!.end.offset!,
      locator: `L${node.position!.start.line}-L${node.position!.end.line}`, text_hash: hash(text.slice(node.position!.start.offset!, node.position!.end.offset!)) })) }
}

// 用户 2026-11-11 定：合章只用来打包调用，每个原小节的覆盖底线不变。
it('章节集合保持原标题章节，短章不合并', () => {
  const source = chapterSource('# 父\n\n父。\n\n## 子\n\n子。\n\n### 孙\n\n孙。\n\n# 乙\n\n乙。')
  const before = JSON.stringify(source), chapters = sourceChapters(source)
  expect(chapters.map(chapter => chapter.title)).toEqual(['父', '子', '孙', '乙'])
  expect(chapters).toEqual(originalSourceChapters(source))
  expect(JSON.stringify(source)).toBe(before)
  expect(sourceChapters(chapterSource('没有标题的正文'))).toEqual([])
})

it('正文字数不计标题和图片编码', () => {
  expect(bodyCharacters('# 长标题\n\n正文😀\n\n![图](data:image/png;base64,' + 'A'.repeat(20000) + ')')).toBe(3)
})

it('短章各自保留底线和缺口，同源短章打包成一次补提调用', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'b4-keep-')), file = path.join(root, 'source.md')
  await mkdir(path.join(root, '.llmwiki'))
  await writeFile(file, Array.from({ length: 6 }, (_, index) => `# 短章${index}\n\n短章${index}的结论成立。`).join('\n\n'), 'utf8')
  const source = await readLocalSource(file, '测试'), requests: any[] = []
  const options: BuildLayeredOptions = { knowledgeRoot: root, tier: 6, topics: { sourceChapterMinPoints: 1 }, client: {
    concurrency: () => 1,
    info: async () => ({ provider: 'mock', id: 'mock', name: '假模型', defaultMaxTokens: 16384 }),
    call: async (_task, _prompt, input) => {
      const data = JSON.parse(input); requests.push(data)
      if (data.chapters) return JSON.stringify({ chapters: data.chapters.map((chapter: any, index: number) => ({ chapter_id: chapter.chapter_id,
        // 第 3 章明确返回空结果，应保留本章覆盖缺口，不能被其他短章的要点抵消。
        points: index === 2 ? [] : chapter.paragraphs.filter((part: any) => !String(part.text ?? '').startsWith('#')).slice(0, 1).map((part: any) => ({
          paragraph_id: part.paragraph_id, text: part.text, section: '主要发现', evidence: [{ paragraph_id: part.paragraph_id, locator: part.locator, quote: part.text }] })) })) })
      return JSON.stringify({ tags: ['方法', '研究', '样本'], credibility: 'unknown', credibility_reason: null, points: [], terms: [], summary_point_indices: [] })
    },
  } }
  const result = await extractSource(root, 'S-0001', source, { tier: 6, granularity: 'custom', prompt_version: 'v1' }, options, 98304)
  expect(result.chapters!.map(chapter => chapter.title)).toEqual(['短章0', '短章1', '短章2', '短章3', '短章4', '短章5'])
  const batches = requests.filter(request => request.chapters)
  expect(batches).toHaveLength(1)
  expect(batches[0].chapters).toHaveLength(6)
  expect(result.segments.flatMap(segment => segment.points)).toHaveLength(5)
  const coverageGaps = result.gaps!.filter(gap => gap.reasons.some(reason => reason.rule === 'chapter-coverage'))
  expect(coverageGaps.map(gap => (gap.item as { chapter: string }).chapter)).toEqual(['短章2'])
})
