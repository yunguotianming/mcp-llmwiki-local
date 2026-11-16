import { hash } from './files.js'
import { parseMarkdown } from '../ingest/markdown.js'
import type { Nodes } from 'mdast'
import type { Point } from './schema.js'

// 按完整要点 ID 排序分配；同页重复哈希和一条要点的多条证据共用编号序列。
export function evidenceBlockIds(points: Iterable<Pick<Point, 'point_id' | 'evidence'>>): Map<string, string[]> {
  const counts = new Map<string, number>(), result = new Map<string, string[]>()
  for (const point of [...points].sort((a, b) => a.point_id < b.point_id ? -1 : a.point_id > b.point_id ? 1 : 0)) {
    const base = 'p' + hash(point.point_id).slice(7, 19), key = point.point_id.split(':')[0] + ':' + base
    result.set(point.point_id, point.evidence.map(() => {
      const number = (counts.get(key) ?? 0) + 1
      counts.set(key, number)
      return base + (number === 1 ? '' : '-' + number)
    }))
  }
  return result
}
export const chapterBlockId = (id: string): string => 'chapter-' + id.replace(/^chapter-/, '').replace(/[^a-zA-Z0-9-]/g, '')
export const sectionBlockId = (id: string): string => id.replace(/[^a-zA-Z0-9-]/g, '-')

// 同一版本号只在来源导航保存一次；正文、定位、证据链接均逐字保留。
export function compactCitationVersions(content: string): string {
  if (!content.includes('## 来源导航\n')) return content
  content = expandCitationVersions(content).replace(/^- 来源版本：[^\n]+\n?/gm, '')
  const bySource = new Map<string, Set<string>>()
  for (const match of content.matchAll(/\[((?:S-\d+|\d{14}-[a-z0-9]{7}))@([^\]#]+)#/g)) {
    const versions = bySource.get(match[1]!) ?? new Set<string>(); versions.add(match[2]!); bySource.set(match[1]!, versions)
  }
  const versions = new Set<string>()
  const compact = content.replace(/\[((?:S-\d+|\d{14}-[a-z0-9]{7}))@([^\]#]+)#([^\]]+)\](\([^\n)]+\))/g,
    (match, source: string, version: string, locator: string, link: string) => {
      if (bySource.get(source)!.size !== 1) return match
      versions.add(source + '@' + version)
      return `[${source}#${locator}]${link}`
    })
  return versions.size ? compact.trimEnd() + '\n' + [...versions].sort().map(version => '- 来源版本：' + version).join('\n') + '\n' : content
}

// 发布校验先无损展开，仍使用原有逐点版本、定位和锚点校验。
export function expandCitationVersions(content: string): string {
  const versions = new Map<string, string>()
  for (const match of content.matchAll(/^- 来源版本：((?:S-\d+|\d{14}-[a-z0-9]{7}))@([^\n]+)$/gm)) {
    if (versions.has(match[1]!) && versions.get(match[1]!) !== match[2]) throw new Error('主题引用的来源版本映射不唯一。')
    versions.set(match[1]!, match[2]!)
  }
  return content.replace(/\[((?:S-\d+|\d{14}-[a-z0-9]{7}))#(L\d+-L\d+|block:\d{14}-[a-z0-9]{7})\](\([^\n)]+\))/g,
    (_match, source: string, locator: string, link: string) => {
      const version = versions.get(source)
      if (!version) throw new Error('主题引用缺少来源版本映射。')
      return `[${source}@${version}#${locator}]${link}`
    })
}

// 检查点缺失映射时，只按本页成员的来源、块锚点和定位恢复；不能用来源当前版本猜测。
export function restoreCitationVersions(content: string, members: Point[], anchors = evidenceBlockIds(members)): string {
  const mapped = new Set([...content.matchAll(/^- 来源版本：((?:S-\d+|\d{14}-[a-z0-9]{7}))@[^\n]+$/gm)].map(match => match[1]!))
  const byAnchor = new Map(members.flatMap(point => (anchors.get(point.point_id) ?? [])
    .map(anchor => [point.point_id.split(':')[0] + '#^' + anchor, point] as const)))
  const restored = content.replace(/\[((?:S-\d+|\d{14}-[a-z0-9]{7}))#(L\d+-L\d+|block:\d{14}-[a-z0-9]{7})\]\(([^\n)]+)\)/g,
    (citation, source: string, locator: string, link: string) => {
      if (mapped.has(source)) return citation
      const target = /^(?:\.\.\/)+sources\/([^/]+)\.md#(\^[a-zA-Z0-9-]+)$/.exec(link)
      const point = target?.[1] === source ? byAnchor.get(source + '#' + target[2]) : undefined
      const versions = new Set(point?.evidence.filter(item => item.source_id === source && item.locator === locator).map(item => item.source_version))
      if (versions.size !== 1) throw new Error('主题引用缺少可唯一恢复的成员证据。')
      return `[${source}@${[...versions][0]}#${locator}](${link})`
    })
  return expandCitationVersions(restored)
}

export function readBlock(content: string, anchor: string): string | undefined {
  const lines = content.split('\n'), index = lines.findIndex(line => line.trimEnd().endsWith(' ' + anchor))
  if (index < 0) return undefined
  const heading = /^(#{1,6}) /.exec(lines[index]!)
  let start = index, end = index + 1
  if (lines[index]!.trim() === anchor) {
    // 独立块标记属于前一个完整 Markdown 块，包括多行列表或围栏。
    const previous = parseMarkdown(lines.slice(0, index).join('\n')).children.at(-1)
    if (previous?.position) start = previous.position.start.line - 1
    return lines.slice(start, end).join('\n')
  }
  if (heading) {
    while (end < lines.length) {
      const next = /^(#{1,6}) /.exec(lines[end]!)
      if (next && (next[1]!.length <= heading[1]!.length || / \^[a-zA-Z0-9-]+\s*$/.test(lines[end]!))) break
      end++
    }
  } else {
    while (start > 0 && lines[start - 1]!.trim() && !/^\s*(?:[-+*]|\d+\.)\s/.test(lines[start]!) && !/ \^[a-zA-Z0-9-]+\s*$/.test(lines[start - 1]!)) start--
  }
  return lines.slice(start, end).join('\n')
}

// 只转换程序生成的旧引用，正文、路径和引文保持原样；用于旧待发布状态的重新渲染。
export function migrateAnchors(content: string, anchors: Map<string, string[]>): string {
  if (!/<a id=|\.md#(?!\^)/.test(content)) return content
  const edits: { start: number; end: number; text: string }[] = []
  const htmlStarts = new Set<number>(), headings: Extract<Nodes, { type: 'heading' }>[] = []
  const visit = (node: Nodes): void => {
    if (node.type === 'html' && node.position && /^<a id="/.test(node.value)) htmlStarts.add(node.position.start.offset!)
    if (node.type === 'heading') headings.push(node)
    if (node.type === 'link' && node.position) {
      const id = /\.md#([^\s]+)$/.exec(node.url)?.[1], block = id && anchors.get(id)?.[0]
      if (id && block) {
        const start = node.position.start.offset!, end = node.position.end.offset!
        const offset = content.slice(start, end).lastIndexOf('#' + id)
        if (offset >= 0) edits.push({ start: start + offset + 1, end: start + offset + 1 + id.length, text: '^' + block })
      }
    }
    if ('children' in node) node.children.forEach(visit)
  }
  visit(parseMarkdown(content))
  for (const heading of headings) if (heading.position) {
    const offset = heading.position.start.offset!, prefix = content.slice(0, offset)
    const match = /(?:^|\n)(<a id="([^"]+)"><\/a>)[ \t]*\r?\n\s*$/.exec(prefix)
    if (!match) continue
    const start = match.index + (match[0].startsWith('\n') ? 1 : 0)
    if (!htmlStarts.has(start)) continue
    edits.push({ start, end: offset, text: '' },
      { start: heading.position.end.offset!, end: heading.position.end.offset!, text: ' ^' + sectionBlockId(match[2]!) })
  }
  for (const edit of edits.sort((a, b) => b.start - a.start)) content = content.slice(0, edit.start) + edit.text + content.slice(edit.end)
  return content
}

export function renderEvidence(label: string, quote: string, id: string): string {
  if (!/[\r\n]/.test(quote)) return `- ${label} ${quote} ^${id}`
  // 多行引文按字面块展示，外层围栏长于引文内所有围栏；原文保持连续且逐字不变。
  const fence = '`'.repeat(Math.max(3, ...[...quote.matchAll(/`+/g)].map(match => match[0].length + 1)))
  return `\n${fence}text\n${label}\n${quote}\n${fence}\n\n ^${id}\n`
}
