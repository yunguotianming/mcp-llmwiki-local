import { existsSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { excerpts, tokenCost } from '../src/wiki/page-search.js'
import { signature } from '../src/storage/files.js'

const hasFixtures = existsSync(new URL('./fixtures/page-search-evidence.json', import.meta.url)) && existsSync(new URL('./fixtures/excerpt-r2/pages.json', import.meta.url))
const fixture = (hasFixtures ? JSON.parse(readFileSync(new URL('./fixtures/page-search-evidence.json', import.meta.url), 'utf8')) : {"pages": {}, "cases": [{"id": "Q-020", "path": "sources/S-0020.md", "queries": []}, {"id": "Q-170", "path": "sources/S-0020.md", "queries": []}, {"id": "Q-046", "path": "sources/S-0007.md", "queries": []}, {"id": "Q-167", "path": "sources/S-0017.md", "queries": []}, {"id": "Q-162", "path": "sources/S-0012.md", "queries": []}]}) as {
  pages: Record<string, string>; cases: { id: string; path: string; queries: string[] }[]
}
const existing = (hasFixtures ? JSON.parse(readFileSync(new URL('./fixtures/excerpt-r2/pages.json', import.meta.url), 'utf8')) : { pages: {} }) as { pages: Record<string, string> }
const facts: Record<string, RegExp[]> = {
  'Q-020': [/虚构档案条件b13f0b14f6/, /虚构档案条件386c2f3f1f/, /虚构档案条件9a5350554c/, /虚构档案条件822c516539/, /虚构档案条件57f5281cbb/, /#L63-L63/],
  'Q-170': [/虚构档案条件b13f0b14f6/, /虚构档案条件386c2f3f1f/, /虚构档案条件9a5350554c/, /虚构档案条件822c516539/, /虚构档案条件57f5281cbb/, /#L63-L63/],
  'Q-046': [/虚构档案条件90948914d5/, /虚构档案条件effc071054/, /虚构档案条件c40020e226/, /#L109-L109/],
  'Q-167': [/虚构档案条件fbded55ecc/, /虚构档案条件ec5827ac21/, /#L75-L75/, /#L81-L81/],
  'Q-162': [/虚构档案条件2176ec46b0/, /虚构档案条件299edc5480/, /虚构档案条件a312440c07/, /#L209-L209/],
}

// 查询、变体和正文均来自冻结反例；测试只调用纯摘录函数，不读取真实库或请求模型。
it.skipIf(!hasFixtures).each(fixture.cases)('$id 固定预算内保留完整事实及各自实际证据位置（夹具含第三方论文原文，未随公开仓库发布）', item => {
  const page = { library: '测试库', path: item.path, title: '来源', content: fixture.pages[item.path] ?? existing.pages[item.path]! }
  const result = excerpts(page, item.queries, 1333)
  const content = result.map(quote => quote.content).join('\n')
  for (const fact of facts[item.id]!) expect.soft(content).toMatch(fact)
  expect(result.reduce((sum, quote) => sum + quote.tokens, 0)).toBeLessThanOrEqual(1333)
  for (const quote of result) {
    expect(quote.tokens).toBe(tokenCost(quote.content))
    expect(quote.quote_hash).toBe(signature(quote.content))
    expect(quote.content).not.toContain('[证据](#')
    for (const segment of quote.segments ?? []) {
      const text = quote.content.slice(segment.start, segment.end)
      expect(text).not.toBe('')
      if (item.id !== 'Q-167') expect(segment.truncated).toBe(false)
    }
  }
  if (item.id === 'Q-167') expect(result.flatMap(quote => quote.segments ?? []).some(segment => segment.truncated)).toBe(true)
})
