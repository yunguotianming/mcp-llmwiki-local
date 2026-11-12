import { fromMarkdown } from 'mdast-util-from-markdown'
import { parseFragment } from 'parse5'
import type { DefaultTreeAdapterMap } from 'parse5'
import type { Nodes } from 'mdast'
import { signature } from '../storage/files.js'
export interface TextMapping { start: number; end: number; originalStart: number; originalEnd: number; replacement: boolean }
export interface ImageOccurrence { id: string; url: string; alt: string; originalStart: number; originalEnd: number;
  line: number; state: 'pending' | 'preserved' | 'text-covered' | 'recognized' | 'failed'; reason: string; assetId?: string }
export interface ParsedSource { text: string; mapping: TextMapping[]; images: ImageOccurrence[] }
const imageData = /data:image\/[a-z0-9.+-]+(?:;[a-z0-9=.+-]+)*,[a-z0-9+/=%._~!$&*;:@?-]+(?:[ \t]*\r?\n[a-z0-9+/=]{16,})*/gi

const parsedMarkdown = new Map<string, ReturnType<typeof fromMarkdown>>()
let cachedChars = 0
// 快照、图片剥离、章节规划与证据检查只读同一棵树；按原文内容命中，限制驻留规模。
export function parseMarkdown(content: string): ReturnType<typeof fromMarkdown> {
  const cached = parsedMarkdown.get(content)
  if (cached) { parsedMarkdown.delete(content); parsedMarkdown.set(content, cached); return cached }
  const ast = fromMarkdown(content)
  if (content.length <= 2000000) {
    while (parsedMarkdown.size >= 8 || cachedChars + content.length > 2000000) {
      const oldest = parsedMarkdown.keys().next().value!
      cachedChars -= oldest.length; parsedMarkdown.delete(oldest)
    }
    parsedMarkdown.set(content, ast); cachedChars += content.length
  }
  return ast
}

export function separateImages(content: string, markdown = true): ParsedSource {
  if (!content.includes('![') && !/<img\b|data:image\//i.test(content)) return { text: content, images: [],
    mapping: content ? [{ start: 0, end: content.length, originalStart: 0, originalEnd: content.length, replacement: false }] : [] }
  const ast = parseMarkdown(markdown ? content : '')
  const definitions = new Map<string, { url: string; start: number; end: number }>()
  const edits: { start: number; end: number; replacement: string }[] = []
  const images: ImageOccurrence[] = []
  const addImage = (url: string, alt: string, start: number, end: number, line: number) => {
    const id = signature(`${start}:${end}:${url}`).slice(0, 24)
    images.push({ id, url, alt, originalStart: start, originalEnd: end, line, state: 'preserved', reason: '保留原图供阅读，不进行图片识别。' })
    edits.push({ start, end, replacement: `[图片 ${id}${alt ? '：' + alt.replace(imageData,'[图片数据]') : ''}]` })
  }
  function walk(node: Nodes, visit: (node: Nodes) => void) {
    visit(node)
    if ('children' in node) for (const child of node.children) walk(child, visit)
  }
  walk(ast, node => {
    if (node.type === 'definition' && node.position) definitions.set(node.identifier.toLowerCase(), { url: node.url, start: node.position.start.offset!, end: node.position.end.offset! })
  })
  const usedDefinitions = new Set<string>()
  walk(ast, node => {
    if (!node.position) return
    const start = node.position.start.offset!, end = node.position.end.offset!
    if (node.type === 'image') addImage(node.url, node.alt ?? '', start, end, node.position.start.line)
    if (node.type === 'imageReference') {
      const definition = definitions.get(node.identifier.toLowerCase())
      if (definition) { addImage(definition.url, node.alt ?? '', start, end, node.position.start.line); usedDefinitions.add(node.identifier.toLowerCase()) }
    }
    if (node.type === 'html') {
      const html = parseFragment(node.value, { sourceCodeLocationInfo: true })
      const visit = (element: DefaultTreeAdapterMap['node']) => {
        if ('tagName' in element && element.tagName === 'img' && element.sourceCodeLocation) {
          const url = element.attrs.find(attr => attr.name === 'src')?.value
          const alt = element.attrs.find(attr => attr.name === 'alt')?.value ?? ''
          const location = element.sourceCodeLocation
          if (url) addImage(url, alt, start + location.startOffset, start + location.endOffset, node.position!.start.line + location.startLine - 1)
        }
        if ('childNodes' in element) for (const child of element.childNodes) visit(child)
      }
      visit(html)
    }
  })
  for (const id of usedDefinitions) {
    const definition = definitions.get(id)!
    if (/^data:image\//i.test(definition.url)) edits.push({ start: definition.start, end: definition.end, replacement: `[图片资源定义：${id}]` })
  }
  // 未使用的资源定义、代码示例和 HTML 属性中的图片编码也不能进入模型上下文。
  for (const match of content.matchAll(imageData)) {
    const start=match.index,end=start+match[0].length
    if(!edits.some(edit=>edit.start<end&&edit.end>start))edits.push({start,end,replacement:'[图片数据已保留，不作为正文分析]'})
  }
  edits.sort((a, b) => a.start - b.start)
  const pieces: string[] = [], mapping: TextMapping[] = []
  let original = 0, clean = 0
  const add = (value: string, from: number, to: number, replacement: boolean) => {
    pieces.push(value); mapping.push({ start: clean, end: clean + value.length, originalStart: from, originalEnd: to, replacement }); clean += value.length
  }
  for (const edit of edits) {
    if (edit.start < original) continue
    if (edit.start > original) add(content.slice(original, edit.start), original, edit.start, false)
    add(edit.replacement, edit.start, edit.end, true); original = edit.end
  }
  if (original < content.length) add(content.slice(original), original, content.length, false)
  return { text: pieces.join(''), mapping, images }
}
export interface SourceChunk { id: string; start: number; end: number; originalStart: number; originalEnd: number; text: string; status: 'pending' | 'done' | 'failed' }
export function originalOffset(mapping:TextMapping[],offset:number,right=false):number {
  const segment=mapping.find(segment=>right?offset>segment.start&&offset<=segment.end:offset>=segment.start&&offset<segment.end)
  if(!segment)return right?mapping.at(-1)?.originalEnd??0:0
  return segment.replacement?right?segment.originalEnd:segment.originalStart:segment.originalStart+offset-segment.start
}
export function partitionText(parsed: ParsedSource, maxChars: number): SourceChunk[] {
  if (!Number.isInteger(maxChars) || maxChars < 200) throw new Error('分段预算至少为 200 个字符。')
  const chunks: SourceChunk[] = []
  let start = 0
  while (start < parsed.text.length) {
    let end = Math.min(start + maxChars, parsed.text.length)
    if (end < parsed.text.length) {
      const boundary = parsed.text.lastIndexOf('\n', end)
      if (boundary > start + maxChars / 2) end = boundary + 1
      // UTF-16 代理对不能被截成两个无效字符。
      if (end < parsed.text.length && /[\uD800-\uDBFF]/.test(parsed.text[end - 1]!)) end--
    }
    const text = parsed.text.slice(start, end)
    chunks.push({ id: signature(`${start}:${end}:${text}`).slice(0, 24), start, end,
      originalStart: originalOffset(parsed.mapping,start), originalEnd: originalOffset(parsed.mapping,end,true), text, status: 'pending' })
    start = end
  }
  return chunks
}
