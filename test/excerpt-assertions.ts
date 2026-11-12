import { expect } from 'vitest'
import { readBlock } from '../src/layered/anchors.js'

// 多要点合并及来源引用展开后，逐条验证正文原样存在、原文定位与真实证据块一致。
export function expectExcerptInPage(page: string, content: string) {
  for (const point of content.split(/\n(?=\s*[-+*]\s)/)) {
    if (page.includes(point)) continue
    const restored = point.replace(/\[([^\]]+@[^\]]+#(?:L\d+-L\d+|block:[^\]]+))\]\(\.\.\/sources\/[^)]+#(\^p[\w-]+)\)/g,
      (link, citation: string, anchor: string) => {
        if (page.includes(link)) return link
        expect(readBlock(page, anchor)).toContain('[' + citation + ']')
        return `[证据](#${anchor})`
      })
    expect(page.includes(restored) || page.includes(restored.replaceAll('[证据]', '[回源]'))).toBe(true)
  }
}
