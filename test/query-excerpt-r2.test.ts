import { existsSync, readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { excerpts, tokenCost } from '../src/wiki/page-search.js'
import { signature } from '../src/storage/files.js'

const hasFixture = existsSync(new URL('./fixtures/excerpt-r2/pages.json', import.meta.url))
const fixture = (hasFixture ? JSON.parse(readFileSync(new URL('./fixtures/excerpt-r2/pages.json', import.meta.url), 'utf8')) : {"pages": {}, "cases": [{"id": "Q-011"}, {"id": "Q-020"}, {"id": "Q-170"}, {"id": "C-021"}, {"id": "Q-113"}, {"id": "C-011"}]}) as {
  pages: Record<string, string>; cases: { id: string; query: string; variants: string[] }[]
}
const targets: Record<string, string[]> = {
  'Q-011': ['S-0011'], 'Q-020': ['S-0020'], 'Q-170': ['S-0020'], 'C-021': ['S-0005'],
  'Q-113': ['T-0065', 'S-0004', 'S-0014'], 'C-011': ['S-0010'],
}
// 中英文等价表述来自锁定题集及发布页；数值、关系和限定词分别断言。
const facts: Record<string, RegExp[]> = {
  'Q-011': [/虚构档案条件d3f1ed20e4/i, /虚构档案条件8e12ef7caa/i, /虚构档案条件feb4452961/i, /虚构档案条件2366f5760f/i],
  'Q-020': [/虚构档案条件54ba8fb65c/i, /虚构档案条件386c2f3f1f/, /虚构档案条件9a5350554c/, /虚构档案条件d1c3bb6ec3/, /虚构档案条件8fa37c76c6/i],
  'Q-170': [/虚构档案条件54ba8fb65c/i, /虚构档案条件386c2f3f1f/, /虚构档案条件9a5350554c/, /虚构档案条件d1c3bb6ec3/, /虚构档案条件8fa37c76c6/i],
  'C-021': [/虚构档案条件bab8523d01/i, /虚构档案条件b0018f58e6/i],
  'C-011': [/虚构档案条件17ef9b2ea7/i, /虚构档案条件17cd793f85/, /虚构档案条件bc3f91f8de/],
  'Q-113': [/虚构档案条件d7c6fd7b10/, /虚构档案条件6e2da749f5/, /虚构档案条件7162bf7fef/,
    /虚构档案条件492598ddcd/, /虚构档案条件9284cceaba/],
}
const page = (id: string) => {
  const path = (id.startsWith('S') ? 'sources/' : 'topics/') + id + '.md'
  return { library: '第二轮候选', path, title: id, content: fixture.pages[path]! }
}
it.skipIf(!hasFixture).each(fixture.cases)('$id 真实发布页保留全部锁定事实、完整句子和证据定位（夹具含第三方论文原文，未随公开仓库发布）', item => {
  const quotes = targets[item.id]!.flatMap(id => excerpts(page(id), [item.query, ...item.variants], 1333))
  const content = quotes.map(quote => quote.content).join('\n')
  for (const fact of facts[item.id]!) expect.soft(content).toMatch(fact)
  for (const quote of quotes) {
    expect(quote.tokens).toBe(tokenCost(quote.content))
    expect(quote.tokens).toBeLessThanOrEqual(1333)
    expect(quote.quote_hash).toBe(signature(quote.content))
    if (quote.path.startsWith('sources/')) {
      expect.soft(quote.content).toMatch(/\[S-\d+@sha256:[a-f0-9]+#L\d+-L\d+\]\(\.\.\/sources\/S-\d+\.md#\^p[\w-]+\)/)
      expect.soft(quote.content).not.toContain('[证据](#')
    }
    for (const line of quote.content.split('\n')) {
      const body = line.replace(/\s*(?:[；;]?\[[^\]]+\]\([^)]*\)\s*)+$/, '')
      expect.soft(body).toMatch(/[。！？!?;.][”’"')）]*$/)
    }
  }
  if (item.id === 'C-011') {
    const snippet = excerpts(page('S-0010'), [item.query, ...item.variants], 900)[0]!.content
    for (const fact of facts[item.id]!) expect.soft(snippet).toMatch(fact)
  }
})

it.skipIf(!(existsSync(new URL('./fixtures/excerpt-r2/pages.json', import.meta.url))))('参考文献问题可选择参考文献，事实问题优先正文而非书目（夹具含第三方论文原文，未随公开仓库发布）', () => {
  const source = page('S-0011')
  const reference = excerpts(source, ['参考文献中 Nicholson 1984 的论文刊载在哪里？'], 900)[0]!.content
  expect(reference).toMatch(/Administrative Science Quarterly/)
  expect(reference).toContain('#L364-L364')
  const answer = excerpts(source, ['Nicholson 四阶段是什么？'], 900)[0]!.content
  expect(answer).toContain('准备、遭遇、调整和稳定')
  expect(answer).not.toMatch(/参考文献列出|ORCID/)
})

it('长要点只截完整句子且保留全部引用，没有完整句能容纳时返回空', () => {
  const link = '[S-0001@sha256:abc#L9-L9](../sources/S-0001.md#^ptest)'
  const answer = '关键条件是完成登记。'
  const source = { library: '库', path: 'topics/T-0001.md', title: '条件', content: '- ' + '背景信息。'.repeat(30) + answer + '后续说明。'.repeat(30) + ' ' + link }
  const budget = tokenCost(answer + ' ' + link)
  expect(excerpts(source, ['关键条件'], budget)[0]!.content).toBe(answer + ' ' + link)
  expect(excerpts(source, ['关键条件'], tokenCost(link))).toEqual([])
  const unsplittable = { ...source, content: '- ' + '超长但没有句末标点的正文'.repeat(30) + ' ' + link }
  expect(excerpts(unsplittable, ['正文'], budget)).toEqual([])
})

it('同页相关要点按页序合并，跳过重复正文，预算不足不切第二条要点', () => {
  const first = '- 学费每年100元。 [证据](#^pa)', second = '- 学制为四年。 [证据](#^pb)'
  const source = { library: '库', path: 'page.md', title: '资料', content: first + '\n\n无关正文。\n\n' + second + '\n\n' + first }
  const full = excerpts(source, ['学制与学费'], tokenCost(first + '\n' + second))
  expect(full).toHaveLength(1)
  expect(full[0]!.content).toBe(first + '\n' + second)
  const small = excerpts(source, ['学制与学费'], tokenCost(first + '\n' + second) - 1)
  expect(small).toHaveLength(1)
  expect([first, second]).toContain(small[0]!.content)
})

it('结构信息降权按问法解除，方法与导航问题仍能命中相应章节', () => {
  const source = { library: '库', path: 'page.md', title: '资料', content: '# 资料\n\n## 参考文献\n\n- 登记条件材料引用论文。\n\n## 作者\n\n- 登记条件材料作者甲。\n\n## 研究目的\n\n- 研究旨在探索登记条件材料。\n\n## 结果\n\n- 登记条件是年满十八岁。\n\n## 方法\n\n- 采用访谈收集登记条件材料。\n\n## 目录\n\n- 登记条件目录。' }
  expect(excerpts(source, ['登记条件'], 110)[0]!.content).toBe('- 登记条件是年满十八岁。')
  expect(excerpts(source, ['参考文献引用论文'], 110)[0]!.content).toContain('引用论文')
  expect(excerpts(source, ['研究目的是什么'], 110)[0]!.content).toContain('旨在')
  expect(excerpts(source, ['研究方法采用访谈吗'], 110)[0]!.content).toContain('采用访谈')
  expect(excerpts(source, ['登记条件目录'], 110).map(quote => quote.content).join('\n')).toContain('登记条件目录')
})
