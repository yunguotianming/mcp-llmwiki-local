import { expect, it } from 'vitest'
import { excerpts, tokenCost } from '../src/wiki/page-search.js'
import { signature } from '../src/storage/files.js'

it('重复命中标题不挤占中后部答案，命中段后补页首概览且保持原文与预算', () => {
  const answer = '访谈人数为23人，其中12人来自甲组、11人来自乙组。'
  const overview = '本页概览介绍研究背景。'
  const content = '# 访谈人数\n\n' + overview + '\n\n## 访谈人数\n\n' + '前部背景与过程。\n\n'.repeat(30) + '## 结果 ^result\n\n' + answer
  const page = { library: '测试库', path: 'sources/S-0001.md', title: '访谈人数', content }
  const budget = tokenCost(answer + overview)
  const quotes = excerpts(page, ['访谈人数'], budget)
  expect(quotes.map(quote => quote.content)).toEqual([answer, overview])
  expect(quotes[0]!.anchor).toBe('^result')
  expect(quotes.reduce((sum, quote) => sum + quote.tokens, 0)).toBe(budget)
  for (const quote of quotes) { expect(content).toContain(quote.content); expect(quote.quote_hash).toBe(signature(quote.content)) }
})

it('查询变体参与段落词项匹配，规范化匹配仍返回连续原文而非子串误命中', () => {
  const answer = 'The ＲＡＴＥ is 23%, with two  spaces\nand the original newline.'
  const content = '# 背景\n\nA separate paragraph.\n\nAnother separate paragraph.\n\n## 中后部答案\n\n' + answer
  const quotes = excerpts({ library: '测试库', path: 'sources/S-0001.md', title: '结果', content }, ['问题原话', 'rate'], tokenCost(answer))
  expect(quotes).toHaveLength(1); expect(quotes[0]!.content).toBe(answer)
  expect(quotes[0]!.tokens).toBe(tokenCost(answer)); expect(content).toContain(quotes[0]!.content)
  expect(quotes[0]!.locator).toBe('L9-L10')
})
