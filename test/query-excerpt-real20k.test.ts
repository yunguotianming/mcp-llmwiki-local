import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { excerpts, pageParagraphs, tokenCost } from '../src/wiki/page-search.js'
import type { PointMatch } from '../src/wiki/page-search.js'
import { signature } from '../src/storage/files.js'

interface Case {
  id: string
  originalResponse: { query: string; response: { groups: { results: { path: string; excerpts: { content: string }[] }[] }[] } }
  page: { library: string; path: string; title: string; content: string }
  pointMatches: PointMatch[]
}
// 原始响应与发布页来自只读 real20k；向量分数由同库 qwen3-embedding:8b 重放原查询得到。
const fixtures = JSON.parse(readFileSync(new URL('./fixtures/real20k/query-excerpts.json', import.meta.url), 'utf8')) as Case[]
const facts: Record<string, string[]> = {
  'Q-003': ['虚构样例Q-003的条件1', '虚构样例Q-003的条件2', '虚构样例Q-003的条件3', '虚构样例Q-003的条件4', '虚构样例Q-003的条件5'],
  'Q-005': ['虚构样例Q-005的条件1', '虚构样例Q-005的条件2', '虚构样例Q-005的条件3'],
  'Q-006': ['虚构样例Q-006的条件1', '虚构样例Q-006的条件2', '虚构样例Q-006的条件3', '虚构样例Q-006的条件4'],
  'Q-007': ['虚构样例Q-007的条件1', '虚构样例Q-007的条件2', '虚构样例Q-007的条件3', '虚构样例Q-007的条件4'],
  'Q-008': ['虚构样例Q-008的条件1', '虚构样例Q-008的条件2', '虚构样例Q-008的条件3'],
  'Q-009': ['虚构样例Q-009的条件1', '虚构样例Q-009的条件2', '虚构样例Q-009的条件3'],
  'Q-010': ['虚构样例Q-010的条件1', '虚构样例Q-010的条件2'],
}
it.each(fixtures)('$id 现场原响应对应的答案事实进入连续摘录', item => {
  expect(item.originalResponse.response.groups.flatMap(group => group.results).some(hit => hit.path === item.page.path)).toBe(true)
  const result = excerpts(item.page, [item.originalResponse.query], 1333, item.pointMatches)
  for (const fact of facts[item.id]!) expect(result.map(quote => quote.content).join('\n')).toContain(fact)
  expect(result.reduce((sum, quote) => sum + quote.tokens, 0)).toBeLessThanOrEqual(1333)
  for (const quote of result) {
    expect(item.page.content).toContain(quote.content)
    expect(quote.quote_hash).toBe(signature(quote.content))
    const [, first, last] = /^L(\d+)-L(\d+)$/.exec(quote.locator)!
    expect(item.page.content.split('\n').slice(Number(first) - 1, Number(last)).join('\n')).toContain(quote.content)
    expect(quote.content).not.toMatch(/章节导航|来源导航|提取缺口/)
  }
})

it('向量单独命中要点时映射主张与原文证据，全文独立命中也沿相同锚点选段', () => {
  const content = '# 资料\n\n## 概览\n\n一般背景。\n\n## 结果\n\n- 无词项重合的关键结论。 [证据](#^panswer)\n- 查询词描述背景。 [证据](#^pother)\n\n## 证据原文\n\n- 严格原文答案。 ^panswer\n- 查询词原文背景。 ^pother'
  const page = { library: '库', path: 'sources/S-0001.md', title: '资料', content }
  const result = excerpts(page, ['仅语义相关'], 600, [{ anchors: ['panswer'], score: 0.9 }])
  expect(result[0]!.content).toContain('关键结论')
  expect(result.some(item => item.content.includes('严格原文答案'))).toBe(true)
  expect(pageParagraphs(content, ['严格原文答案'])[0]!.content).toContain('关键结论')
  expect(result.every(item => content.includes(item.content))).toBe(true)
})

it('结构区块可保留在页面但不进入摘录，长列表按命中单项返回', () => {
  const structural = ['来源导航', '章节目录', '提取缺口', '来源列表']
    .map(title => '## ' + title + '\n\n- 答案词导航标题。\n').join('\n')
  const answer = '- 答案词对应完整结论。'
  const content = '---\ntitle: 答案词页头\n---\n# 答案词\n\n' + structural + '\n## 结果\n\n' +
    Array.from({ length: 100 }, (_, index) => '- 背景列表' + index + '。').join('\n') + '\n' + answer + '\n- 后续背景。'
  const result = excerpts({ library: '库', path: 'source.md', title: '答案词', content }, ['答案词'], tokenCost(answer))
  expect(result.map(item => item.content)).toEqual([answer])
  expect(result[0]!.locator).toMatch(/^L\d+-L\d+$/)
})

it('超长段落从命中句附近取连续窗口，保持实际行号和 UTF-8 预算', () => {
  const answer = '唯一关键条件：答对八题可通过。'
  const content = '# 资料\n\n' + '背景说明。'.repeat(100) + '\n' + answer + '\n' + '后续说明。'.repeat(100)
  const result = excerpts({ library: '库', path: 'source.md', title: '资料', content }, ['唯一关键条件'], tokenCost(answer))
  expect(result.map(item => item.content)).toEqual([answer])
  expect(result[0]!.locator).toBe('L4-L4')
  expect(result[0]!.tokens).toBe(tokenCost(answer))
})
