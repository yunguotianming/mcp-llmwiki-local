import { expect, it } from 'vitest'
import { rankGraph } from '../src/wiki/ranking.js'
it('多跳关联、循环和孤点均有界，编码路径可解析，歧义别名不选边', () => {
  const a = { path: 'concepts/a.md', references: ['concepts/a.md', 'A'], links: ['concepts/%E6%96%B9%E6%B3%95.md', '同名'] }
  const b = { path: 'concepts/方法.md', references: ['concepts/方法.md', '方法'], links: ['C'] }
  const c = { path: 'concepts/c.md', references: ['C'], links: ['A'] }
  const first = { path: 'concepts/d.md', references: ['同名'], links: [] }, second = { path: 'entities/e.md', references: ['同名'], links: [] }
  const result = rankGraph([a, b, c, first, second], new Map([[a, 20]]))
  expect([...result.keys()]).toEqual([a, b, c])
  expect(result.get(a)!).toBeGreaterThan(result.get(b)!)
  expect(result.get(b)!).toBeGreaterThan(result.get(c)!)
  expect([...result.values()].every(value => Number.isFinite(value))).toBe(true)
  expect(rankGraph([a, b], new Map())).toEqual(new Map())
})
