import path from 'node:path'
import { realpath, stat } from 'node:fs/promises'
import { parseMarkdown as fromMarkdown } from '../ingest/markdown.js'
import type { Nodes } from 'mdast'
import { parse } from 'yaml'
import { separateImages } from '../ingest/markdown.js'
import { decodeSourceText } from '../ingest/text.js'
import { stableRead } from '../ingest/scanner.js'
import { within } from '../storage/paths.js'
import { hash, hashName, immutableWrite } from './files.js'
import type { Segment, SourceEntry, SourceMetadata } from './schema.js'

export interface LocalSource {
  path: string; bytes: Buffer; text: string; contentHash: string; segments: Segment[]; metadata: SourceMetadata
  sourceId?: string; sourceVersion?: string; files?: SourceEntry['files']; siyuan?: NonNullable<SourceEntry['siyuan']>
}
const assetReference = (value: string) => value.startsWith('data:') ? 'data-uri:' + hash(value) : value
export function segmentResources(source: LocalSource, files: SourceEntry['files']): string[][] {
  const images = separateImages(source.text).images
  return source.segments.map(segment => [...new Set(images.filter(image => image.originalStart >= segment.start && image.originalStart < segment.end)
    .flatMap(image => files.assets.filter(asset => asset.original_path === assetReference(image.url)).map(asset => asset.hash)))].sort())
}
export async function readLocalSource(file: string, sourceType: string): Promise<LocalSource> {
  const bytes = await stableRead(file), text = decodeSourceText(bytes), metadataBlock = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(text)
  const metadata = metadataBlock ? parse(metadataBlock[1]!) : undefined
  // 正文日期先剔除 URL、DOI 和标识符，避免把 DOI 的数字后缀当成年月日。
  const dateText = text.replace(/https?:\/\/[^\s<>"，。；、！？（）【】]+|\b(?:doi\s*:\s*)?10\.\d{1,9}\/[^\s<>"，。；、！？（）【】]+/gi, ' ')
  const found = dateText.match(/(?<![\w./-])(?:\d{4}-\d{2}-\d{2}(?![\w/-])|\d{4}年\d{1,2}月(?:\d{1,2}日)?)/u)?.[0]
  // 现有字段统一为 ISO 日期；原文只有年月时使用该月首日。
  const declaredDate = String(metadata?.source_date ?? metadata?.date ?? found ?? '').replace(/^(\d{4})年(\d{1,2})月(?:(\d{1,2})日)?$/, (_, year: string, month: string, day: string | undefined) => `${year}-${month.padStart(2, '0')}-${(day ?? '1').padStart(2, '0')}`)
  const parsedDate = new Date(declaredDate)
  const sourceDate = /^\d{4}-\d{2}-\d{2}$/.test(declaredDate) && !Number.isNaN(parsedDate.getTime()) && parsedDate.toISOString().slice(0, 10) === declaredDate ? declaredDate : undefined
  const segments: Segment[] = []
  for (const node of fromMarkdown(text).children) {
    if (!node.position) continue
    const start = node.position.start.offset!, end = node.position.end.offset!
    if (metadataBlock && end <= metadataBlock[0].length) continue
    segments.push({ locator: `L${node.position.start.line}-L${node.position.end.line}`, text_hash: hash(text.slice(start, end)), start, end })
  }
  return { path: file, bytes, text, contentHash: hash(bytes), segments, metadata: {
    title: String(metadata?.title ?? /^#\s+(.+)$/m.exec(text)?.[1]?.trim() ?? path.basename(file, path.extname(file))),
    source_type: String(metadata?.source_type ?? sourceType), credibility: 'unknown', credibility_reason: '尚无可核验的可信度依据',
    source_date: sourceDate ?? (await stat(file)).mtime.toISOString().slice(0, 10), source_date_basis: sourceDate ? '原文日期' : '文件时间',
  } }
}
export async function snapshotSource(root: string, knowledgeRoot: string, sourceId: string, source: LocalSource): Promise<SourceEntry['files']> {
  const directory = `objects/snapshots/${sourceId}/${hashName(source.contentHash)}`
  const files: SourceEntry['files'] = { source: directory + '/source.md', assets: [] }
  await immutableWrite(root, files.source, source.bytes)
  const references = new Set(separateImages(source.text).images.map(image => image.url))
  const definitions = new Map<string, string>()
  const visit = (node: Nodes, action: (node: Nodes) => void): void => { action(node); if ('children' in node) for (const child of node.children) visit(child, action) }
  const ast = fromMarkdown(source.text)
  visit(ast, node => { if (node.type === 'definition') definitions.set(node.identifier.toLowerCase(), node.url) })
  visit(ast, node => {
    if (node.type === 'link') references.add(node.url)
    if (node.type === 'linkReference') { const url = definitions.get(node.identifier.toLowerCase()); if (url) references.add(url) }
  })
  for (const reference of [...references].sort()) {
    if (!reference || reference.startsWith('#') || /^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(reference) && !reference.startsWith('data:image/')) continue
    let bytes: Buffer, name: string
    if (reference.startsWith('data:image/')) {
      const match = /^data:image\/([a-z0-9.+-]+);base64,([a-z0-9+/=\s]+)$/i.exec(reference)
      if (!match) throw new Error('无法保存内嵌图片。')
      bytes = Buffer.from(match[2]!, 'base64'); name = 'image.' + match[1]!.replace(/[^a-z0-9]/gi, '')
    } else {
      let relative: string
      try { relative = decodeURIComponent(reference.split(/[?#]/)[0]!) } catch { continue }
      let target: string
      try { target = await realpath(path.resolve(path.dirname(source.path), relative)) }
      catch (error) {
        if (error instanceof Error && 'code' in error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) continue
        throw error
      }
      if (!within(knowledgeRoot, target) || within(root, target)) continue
      if ((await stat(target)).isDirectory()) continue
      if (/\.(md|markdown)$/i.test(target)) continue
      bytes = await stableRead(target); name = path.basename(target)
    }
    const resourceHash = hash(bytes), resourcePath = `${directory}/assets/${hashName(resourceHash)}/${name}`
    await immutableWrite(root, resourcePath, bytes)
    files.assets.push({ original_path: assetReference(reference), hash: resourceHash, path: resourcePath })
  }
  return files
}
