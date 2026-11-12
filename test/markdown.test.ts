import { describe, expect, it } from 'vitest'
import { partitionText, separateImages } from '../src/ingest/markdown.js'

const data = 'data:image/png;base64,' + 'a'.repeat(50000)
describe('Markdown 正文与图片', () => {
  it('移除真实内嵌图片编码，保留每次出现位置和代码示例含义', () => {
    const text = '# 标题\n\n![图一](' + data + ')\n\n![图二][p]\n\n[p]: ' + data + '\n\n`![示例](example.png)`\n'
    const parsed = separateImages(text)
    expect(parsed.images).toHaveLength(2)
    expect(parsed.text).not.toContain(data)
    expect(parsed.text).toContain('`![示例](example.png)`')
    expect(text.slice(parsed.images[0]!.originalStart, parsed.images[0]!.originalEnd)).toContain(data)
    expect(parsed.images[0]!.id).not.toBe(parsed.images[1]!.id)
  })
  it('HTML 图片按语法处理，注释与脚本文字不误识别为资源', () => {
    const parsed = separateImages('<img src="a.png" alt="示意图">\n\n<!-- <img src="ignored.png"> -->\n\n<script>const sample = "<img src=ignored.png>";</script>')
    expect(parsed.images.map(image => image.url)).toEqual(['a.png'])
    expect(parsed.text).toContain('ignored.png')
  })
  it('未使用的定义、代码和普通文本中的图片 Base64 均不作为文字，正文位置仍可核对',()=>{
    const content='正文前。\n\n[unused]: '+data+'\n\n`'+data+'`\n\n正文后。'
    const parsed=separateImages(content)
    expect(parsed.text).not.toContain('a'.repeat(100))
    expect(parsed.text).toContain('正文后。')
    expect(separateImages('正文：'+data,false).text).not.toContain('a'.repeat(100))
    const offset=parsed.mapping.find(item=>!item.replacement&&item.end===parsed.text.length)!
    expect(content.slice(offset.originalStart,offset.originalEnd)).toBe(parsed.text.slice(offset.start,offset.end))
  })
  it('超长单行分段无缺口、不拆代理对，原文位置可核对', () => {
    const content = '甲'.repeat(500) + '🌊'.repeat(1000) + '乙'.repeat(500)
    const parsed = separateImages(content)
    const chunks = partitionText(parsed, 201)
    expect(chunks.map(chunk => chunk.text).join('')).toBe(content)
    expect(chunks.every(chunk => chunk.text.length <= 201)).toBe(true)
    expect(chunks.every((chunk, index) => chunk.start === (chunks[index - 1]?.end ?? 0))).toBe(true)
    for (const chunk of chunks) expect(content.slice(chunk.originalStart, chunk.originalEnd)).toBe(chunk.text)
  })
})
