import * as fs from 'node:fs/promises'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { sharedFixture } from './query-pages-audit-fixture.js'
import { tokenCost, validVariants, fuseRanks } from '../src/wiki/page-search.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
const fixture = sharedFixture(false)

it('Q16 相同输入完全确定，原话单路权重不低于各变体', async () => {
  const f = fixture(), other = await f.addLegacy(); f.registry.libraries = [other]
  await fs.writeFile(path.join(other.wikiPath, 'concepts/b.md'), '# 变体命中\n\n变体关键词。', 'utf8')
  const options = { variants: ['变体命中'] }, first = await f.query.search('审查证据', undefined, undefined, 8, undefined, options)
  expect(await f.query.search('审查证据', undefined, undefined, 8, undefined, options)).toEqual(first)
  const ranks = fuseRanks([{ paths: ['原话'], weight: 1, channel: 'original' }, { paths: ['变体'], weight: .5, channel: 'variant1' }])
  expect(ranks.get('原话')!.score).toBe(ranks.get('变体')!.score * 2)
  expect(first.results.map(hit => hit.path)).toEqual(['concepts/a.md', 'concepts/b.md'])
  expect(first.results[0]!.score_channels.original).toBe(first.results[1]!.score_channels.variant1! * 2)
})

it('Q17 超过三变体、空串、规范化重复、非字符串和超长输入均过滤', async () => {
  expect(validVariants('ＡＢＣ', ['abc', ' ', 7, null, '一'.repeat(501), '第一', '第一', '第二', '第三', '第四'])).toEqual(['第一', '第二', '第三'])
  const f = fixture(), other = await f.addLegacy(); f.registry.libraries = [other]; other.queryUnderstanding = { enabled: true }
  const result = await f.query.search('审查证据', undefined, undefined, 8, undefined, { variants: ['', '审查证据', '第一', '第二', '第三', '第四'] })
  expect(result.understanding).toMatchObject({ variants: ['第一', '第二', '第三'], calls: 0, status: 'caller' })
  expect(f.runtime.stream).not.toHaveBeenCalled()
})

it('Q18 变体全部无命中时仍保留原话命中及原话通道', async () => {
  const f = fixture(), other = await f.addLegacy(); f.registry.libraries = [other]
  const initial = await f.query.search('审查证据'), result = await f.query.search('审查证据', undefined, undefined, 8, undefined, { variants: ['zznomatchaaa', 'zznomatchbbb', 'zznomatchccc'] })
  expect(result.results.map(hit => hit.path)).toEqual(initial.results.map(hit => hit.path))
  expect(result.results).toHaveLength(1)
  expect(result.results[0]!.score_channels).toEqual({ original: 1 / 61 })
})

it('Q19 摘录零预算、零页、关闭、最大值和非法边界均生效，跨库共享总预算', async () => {
  const f = fixture(), first = await f.addLegacy('budget-first'), other = await f.addLegacy('budget-second')
  f.registry.libraries = [first, other]
  for (const options of [{ excerpt_budget: 0 }, { excerpt_pages: 0 }, { include: 'hits' as const }]) {
    const result = await f.query.search('审查证据', undefined, undefined, 8, undefined, options)
    expect(result.results.every(hit => hit.excerpts.length === 0)).toBe(true)
  }
  const result = await f.query.search('审查证据', undefined, undefined, 8, undefined, { excerpt_budget: 61, excerpt_pages: 20 })
  const quotes = result.results.flatMap(hit => hit.excerpts)
  expect(quotes.reduce((sum, quote) => sum + tokenCost(quote.content), 0)).toBeLessThanOrEqual(61)
  expect(result.groups.map(group => group.libraryId)).toEqual([first.id, other.id])
  expect(result.results.filter(hit => hit.excerpts.length).length).toBeLessThanOrEqual(20)
  expect((await f.query.search('审查证据', undefined, undefined, 8, undefined, { excerpt_budget: 6000, excerpt_pages: 20 })).results.length).toBe(2)
  for (const options of [{ excerpt_budget: -1 }, { excerpt_budget: 6001 }, { excerpt_budget: Infinity }, { excerpt_budget: NaN }, { excerpt_budget: 1.5 }, { excerpt_pages: -1 }, { excerpt_pages: 21 }, { excerpt_pages: NaN }, { excerpt_pages: 1.5 }])
    await expect(f.query.search('审查证据', undefined, undefined, 8, undefined, options)).rejects.toThrow('摘录预算')
})

it('Q20 旧库含行内图片时摘录仍必须逐字存在于 Markdown', async () => {
  const f = fixture(), other = await f.addLegacy(); f.registry.libraries = [other]
  const raw = '# 页面\n\n审查证据：前半句 ![示意图](assets/a.png) 后半句。'
  await fs.writeFile(path.join(other.wikiPath, 'concepts/a.md'), raw, 'utf8')
  const result = await f.query.search('审查证据')
  expect(result.results).toHaveLength(1)
  expect.soft(raw).toContain(result.results[0]!.snippet)
  for (const quote of result.results[0]!.excerpts) expect.soft(raw).toContain(quote.content)
  const encoded = '# 图像证据\r\n\r\n审查证据前句 ![图](data:image/png;base64,' + 'A'.repeat(800) + ') 后句。\r\n同段续行。'
  await fs.writeFile(path.join(other.wikiPath, 'concepts/a.md'), encoded, 'utf8')
  const hit = (await f.query.search('审查证据 后句')).results[0]!
  expect(encoded).toContain(hit.snippet)
  expect(hit.excerpts.length).toBeGreaterThan(0)
  for (const quote of hit.excerpts) {
    expect(encoded).toContain(quote.content)
    expect(quote).toMatchObject({ path: 'concepts/a.md', library: other.name, anchor: '图像证据' })
    expect(quote.content).not.toContain('data:image')
    expect(quote.content).not.toContain('[图片')
  }
})
