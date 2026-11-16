import { expect, it } from 'vitest'
import { excerpts, tokenCost } from '../src/wiki/page-search.js'

const version = 'sha256:' + 'a'.repeat(64), point = 'S-0001:sha256:' + 'c'.repeat(64) + ':01'
const a = `- ${point}：[S-0001@${version}#L7-L7] 原文甲。`
const b = `- ${point}：[S-0001@${version}#L9-L9] 原文乙。`
const page = { library: '测试库', path: 'sources/S-0001.md', title: '来源', content:
  `- 【未核实】合并说明。 [证据](#^pa)\n\n## 证据原文\n\n${a} ^pa\n${b} ^pb` }

it('语义命中且引用展开超预算时，补充路径不能绕回无保护元数据的原始证据', () => {
  const result = excerpts(page, ['完全无关的检索词'], tokenCost(a), [{ anchors: ['pa', 'pb'], score: 0.9 }])
  expect(result).toEqual([])
})

it('语义命中预算只够单段时，完整返回引用并保留未核实与缺组标记', () => {
  const result = excerpts(page, ['完全无关的检索词'], tokenCost(a) + 60, [{ anchors: ['pa', 'pb'], score: 0.9 }])
  expect(result).toHaveLength(1)
  expect(result[0]!.content).toContain('#L7-L7](../sources/S-0001.md#^pa)')
  expect(result[0]!.segments).toHaveLength(1)
  expect(result[0]!.segments![0]).toMatchObject({ unverified: true, truncated: true })
})

it('多锚点中存在缺失证据时，已返回原文仍标明未完整覆盖', () => {
  const result = excerpts(page, ['原文定位'], 3000, [{ anchors: ['pa', 'pb', 'pmissing'], score: 0.9 }])
  expect(result.length).toBeGreaterThan(0)
  expect(result.flatMap(item => item.segments ?? []).every(segment => segment.truncated && segment.unverified)).toBe(true)
})
