import { expect, it } from 'vitest'
import { layeredSettings } from '../src/domain/config.js'
import { termIndexPages } from '../src/layered/terms.js'

const records = (categories: number, perCategory = 1) => Array.from({ length: categories * perCategory }, (_, index) =>
  ({ id: 'TM-' + String(index + 1).padStart(4, '0'), category: '类别' + String(Math.floor(index / perCategory) + 1).padStart(4, '0') }))

it('默认上限下小库一类一页，与改动前的页面一致', () => {
  const settings = layeredSettings()
  expect([settings.termIndexMaxPages, settings.termIndexPageSize]).toEqual([50, 200])
  const pages = termIndexPages(records(3, 2), settings)
  expect(pages.map(page => [...new Set(page.map(record => record.category))])).toEqual([['类别0001'], ['类别0002'], ['类别0003']])
})

it('类别超过上限时按类别排序定量分页，页数只随术语数增长', () => {
  // 194 篇护士库实测：5194 个术语、1200 个类别，原规则生成 1200 个索引页。
  const nurse = records(1200).concat(records(4, 998).map(record => ({ ...record, id: record.id + 'x' })))
  const pages = termIndexPages(nurse, layeredSettings())
  expect(pages).toHaveLength(Math.ceil(nurse.length / 200))
  expect(pages.flat()).toHaveLength(nurse.length)
  // 同一类别的术语相邻，分页不打乱类别顺序。
  const order = pages.flat().map(record => record.category)
  expect(order).toEqual([...order].sort())
})

it('边界：类别数等于上限仍一类一页，多一个就分页', () => {
  const settings = { termIndexMaxPages: 3, termIndexPageSize: 2 }
  expect(termIndexPages(records(3), settings)).toHaveLength(3)
  expect(termIndexPages(records(4), settings)).toHaveLength(2)
})
