import { existsSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { excerpts, pageParagraphs, tokenCost } from '../src/wiki/page-search.js'
import type { PointMatch } from '../src/wiki/page-search.js'
import { signature } from '../src/storage/files.js'
import { expectExcerptInPage } from './excerpt-assertions.js'

interface Case {
  id: string
  originalResponse: { query: string; response: { groups: { results: { path: string; excerpts: { content: string }[] }[] }[] } }
  page: { library: string; path: string; title: string; content: string }
  pointMatches: PointMatch[]
}
// 原始响应与发布页来自只读 real20k；向量分数由同库 qwen3-embedding:8b 重放原查询得到。
const hasFixture = existsSync(new URL('./fixtures/real20k/query-excerpts.json', import.meta.url))
const fixtures = (hasFixture ? JSON.parse(readFileSync(new URL('./fixtures/real20k/query-excerpts.json', import.meta.url), 'utf8')) : [{"id": "Q-003", "question": "Q-003"}, {"id": "Q-005", "question": "Q-005"}, {"id": "Q-006", "question": "Q-006"}, {"id": "Q-007", "question": "Q-007"}, {"id": "Q-008", "question": "Q-008"}, {"id": "Q-009", "question": "Q-009"}, {"id": "Q-010", "question": "Q-010"}]) as Case[]
const facts: Record<string, string[]> = {
  'Q-003': ['虚构档案条件e440c80296', '虚构档案条件1d57b55a16', '虚构档案条件675fb87c2a', '虚构档案条件c17e24bc52', '虚构档案条件df5b332683'],
  'Q-005': ['虚构档案条件980b22f854', '虚构档案条件bd07268a9e', '虚构档案条件9bd0424586'],
  'Q-006': ['虚构档案条件cf05239aea', '虚构档案条件602c699177', '虚构档案条件21906ff409', '虚构档案条件23f00d6702'],
  'Q-007': ['虚构档案条件6d96434ad2', '虚构档案条件7a58193f16', '虚构档案条件e2cb83aa1e', '虚构档案条件5c44579c9c'],
  'Q-008': ['虚构档案条件b69884778a', '虚构档案条件5f48a92c7b', '虚构档案条件374dfe2aa1'],
  'Q-009': ['虚构档案条件08422603ba', '虚构档案条件6c1d966064', '虚构档案条件17793ff9a2'],
  'Q-010': ['虚构档案条件60bb525750', '虚构档案条件4c726985ea'],
}
it.skipIf(!hasFixture).each(fixtures)('$id 现场原响应对应的答案事实进入连续摘录（夹具含第三方论文原文，未随公开仓库发布）', item => {
  expect(item.originalResponse.response.groups.flatMap(group => group.results).some(hit => hit.path === item.page.path)).toBe(true)
  const result = excerpts(item.page, [item.originalResponse.query], 1333, item.pointMatches)
  const content = result.map(quote => quote.content).join('\n')
  for (const fact of facts[item.id]!) {
    const equivalents: Record<string, string> = { '车轮的中心': '轮子中的枢纽', '伦理指南针': '伦理罗盘', '没有真正的权力': '没有真正权力' }
    if (equivalents[fact]) expect(content.includes(fact) || content.includes(equivalents[fact]!)).toBe(true)
    else expect(content).toContain(fact)
  }
  expect(result.reduce((sum, quote) => sum + quote.tokens, 0)).toBeLessThanOrEqual(1333)
  for (const quote of result) {
    expectExcerptInPage(item.page.content, quote.content)
    expect(quote.quote_hash).toBe(signature(quote.content))
    const [, first, last] = /^L(\d+)-L(\d+)$/.exec(quote.locator)!
    for (const point of quote.content.split(/\n(?=- )/)) {
      const body = point.replace(/\s*\[[^\]]+\]\([^)]*\)/g, '')
      expect(item.page.content.split('\n').slice(Number(first) - 1, Number(last)).join('\n')).toContain(body)
    }
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
