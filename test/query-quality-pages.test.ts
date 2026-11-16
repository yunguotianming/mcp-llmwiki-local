import { existsSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { excerpts } from '../src/wiki/page-search.js'
import type { PageExcerpt } from '../src/wiki/page-search.js'

interface Case {
  id: string; snapshot: string; queries: string[]
  page: { library: string; path: string; title: string; content: string }
  before: PageExcerpt[]
}
const hasFixture = existsSync(new URL('./fixtures/query-quality-pages.json', import.meta.url))
const { cases } = (hasFixture ? JSON.parse(readFileSync(new URL('./fixtures/query-quality-pages.json', import.meta.url), 'utf8')) : {"cases": [{"id": "C-021", "snapshot": "r1-base"}, {"id": "C-005", "snapshot": "r1-cand"}, {"id": "Q-150", "snapshot": "r1-cand"}, {"id": "C-038", "snapshot": "r2-base"}, {"id": "C-004", "snapshot": "r2-cand"}]}) as { cases: Case[] }
it.skipIf(!hasFixture).each(cases)('$snapshot / $id 原代码冻结摘录逐字不变且每段独立定位（夹具含第三方论文原文，未随公开仓库发布）', item => {
  const after = excerpts(item.page, item.queries, 1333)
  expect(after.map(({ segments: _segments, ...excerpt }) => excerpt)).toEqual(item.before)
  for (const excerpt of after) {
    const segments = excerpt.segments!
    expect(segments.length).toBeGreaterThan(0)
    expect(segments[0]!.start).toBe(0)
    expect(segments.at(-1)!.end).toBe(excerpt.content.length)
    for (const [index, segment] of segments.entries()) {
      expect(segment.start).toBe(index ? segments[index - 1]!.end + 1 : 0)
      expect(segment.end).toBeGreaterThan(segment.start)
      expect(segment.locator).toMatch(/^L\d+-L\d+$/)
      if (excerpt.content.slice(segment.start, segment.end).includes('【未核实】')) expect(segment.unverified).toBe(true)
    }
  }
})
