import { expect } from 'vitest'
import { readBlock } from '../src/layered/anchors.js'

// 多要点合并及来源引用展开后，逐条验证正文原样存在、原文定位与真实证据块一致。
export function expectExcerptInPage(page: string, content: string) {
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const link = /\[([^\]]+@[^\]]+#(?:L\d+-L\d+|block:[^\]]+))\]\(\.\.\/sources\/[^)]+#(\^p[\w-]+)\)/g
  const group = new RegExp(link.source + '(?:[ \\t]*[；;]?[ \\t]*' + link.source + ')*', 'g')
  for (const point of content.split(/\n(?=\s*[-+*]\s)/)) {
    if (page.includes(point)) continue
    let pattern = '', offset = 0
    for (const match of point.matchAll(group)) {
      const choices = new Set([match[0]])
      for (const item of match[0].matchAll(link)) {
        expect(readBlock(page, item[2]!)).toContain('[' + item[1] + ']')
        choices.add(`[证据](#${item[2]})`); choices.add(`[回源](#${item[2]})`)
      }
      // 全部展开引用都已逐条核对；原页可用一个主锚点，或逐条保存裸引用。
      choices.add(match[0].replace(link, (_text, citation: string) => '[' + citation + ']'))
      pattern += escape(point.slice(offset, match.index)) + '(?:' + [...choices].map(escape).join('|') + ')'
      offset = match.index! + match[0].length
    }
    pattern += escape(point.slice(offset))
    // 只替换引用写法，正文仍逐字连续匹配，不能放过跨段拼接或省略条件。
    expect(new RegExp(pattern).test(page)).toBe(true)
  }
}
