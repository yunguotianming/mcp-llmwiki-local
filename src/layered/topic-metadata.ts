import { parse, stringify } from 'yaml'
import { evidenceBlockIds } from './anchors.js'
import { matchQuotation } from './quotation.js'
import { locatorRange } from './schema.js'
import { separateImages } from '../ingest/markdown.js'
import type { Evidence, Point, Segment } from './schema.js'

const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/

// 只识别独立的临时引用编号；不删除普通括号中的条件、数值或作者。
const referenceId = '(?:P\\d+|[ST]-\\d+(?:[.-]\\d+)*)'
const referenceList = `${referenceId}(?:[\\s、,，;；]+${referenceId})*`
const referenceMarker = `(?:[（(【]\\s*${referenceList}\\s*[）)】]|\\\\?\\[\\s*${referenceList}\\s*\\\\?\\](?!\\())`
const markdownLink = '\\[[^\\]\\n]*\\]\\((?:[^()\\s]|\\([^()\\n]*\\))*\\)'
const bareReferences = `${referenceList}(?=\\s*(?:${markdownLink}(?:[；;\\s]+${markdownLink})*)?\\s*$)`
const suffix = new RegExp(`^(?:[\\s；;]*)(?:${markdownLink}|${referenceMarker}|${bareReferences})`)

export function topicClaimText(text: string): string {
  return text.replace(new RegExp(referenceMarker, 'g'), '')
    .replace(new RegExp(`(^|[。！？.!?]\\s*)${bareReferences}`, 'g'), '$1').trim()
}

/** 保留原文偏移；句后引用和链接归属前一句，链接内部与作者缩写不是句界。 */
export function splitTopicSentences(text: string): string[] {
  const protectedSpans = [...text.matchAll(new RegExp(`${markdownLink}|${referenceMarker}`, 'g'))]
    .map(match => [match.index!, match.index! + match[0].length])
  const pairs: Record<string, string> = { '“': '”', '‘': '’', '「': '」', '『': '』', '（': '）', '(': ')', '[': ']', '【': '】', '{': '}', '《': '》' }
  const stack: string[] = []
  const result: string[] = []
  let start = 0
  for (let i = 0; i < text.length; i++) {
    const character = text[i]!
    if (protectedSpans.some(([a, b]) => i >= a! && i < b!)) continue
    if (character === '\\') { i++; continue }
    // 英文词中的撇号不是引号；未配对的引号或括号不能吞掉后续事实。
    if ((character === "'" || character === '’') && /[\p{L}\p{N}]/u.test(text[i - 1] ?? '')
      && (/[\p{L}\p{N}]/u.test(text[i + 1] ?? '') || character === "'" && stack.at(-1) !== character)) continue
    if (stack.at(-1) === character) { stack.pop(); continue }
    const close = pairs[character] ?? (character === '"' || character === "'" || character === '`' ? character
      : character === '<' && /^(?:https?:\/\/|mailto:)/i.test(text.slice(i + 1)) ? '>' : undefined)
    if (close && text.indexOf(close, i + 1) >= 0) { stack.push(close); continue }
    if (stack.length || !/[。！？!?.]/.test(character)) continue
    if (character === '.') {
      if (i + 1 < text.length && !/\s/.test(text[i + 1]!)) continue
      if (/(?:\b[A-Z]|\b(?:Dr|Mr|Mrs|Ms|Prof|Sr|Jr|vs|etc)|\bet al)\.$/i.test(text.slice(0, i + 1))) continue
    }
    let end = i + 1
    while (/[。！？!?]/.test(text[end] ?? '') && end < text.length) end++
    for (;;) {
      const attached = suffix.exec(text.slice(end))
      if (!attached) break
      end += attached[0].length
    }
    while (end < text.length && /\s/.test(text[end]!)) end++
    result.push(text.slice(start, end)); start = end; i = end - 1
  }
  if (start < text.length) result.push(text.slice(start))
  return result
}

export function rebuildTopicScope(content: string, members: Point[]): string {
  // 摘录最终成员原话形成范围，下一轮仍须逐句核对；程序不添加概括性主张。
  const summary = [...new Set(members.map(point => topicClaimText(point.text).replace(/[\r\n]+/g, ' ')))].slice(0, 3).join('；')
  if (!summary) return content.replace(/^范围：.*\r?\n?/m, '')
  return /^范围：/m.test(content) ? content.replace(/^范围：.*$/m, '范围：' + summary)
    : content.replace(/^(# .*\r?\n)/m, '$1范围：' + summary + '\n')
}

export const topicEvidenceContextVersion = 'topic-evidence-paragraph-v3'
export interface TopicEvidenceSource {
  title: string
  source_version: string
  text: string
  segments: readonly Segment[]
}

export function topicEvidenceContext(evidence: Evidence, source?: TopicEvidenceSource): string | undefined {
  if (!source) return undefined
  if (source.source_version !== evidence.source_version) throw new Error('主题成员证据与来源快照版本不一致。')
  let rangeStart: number, rangeEnd: number
  if (evidence.locator.startsWith('block:')) {
    const segment = source.segments.find(item => item.locator === evidence.locator)
    if (!segment) throw new Error('主题成员证据找不到所属原段。')
    rangeStart = segment.start; rangeEnd = segment.end
  } else {
    const [first, last] = locatorRange(evidence.locator)
    const offsets = [0, ...[...source.text.matchAll(/\n/g)].map(match => match.index! + 1)]
    if (last > offsets.length) throw new Error('主题成员证据定位超出来源快照。')
    rangeStart = offsets[first - 1]!; rangeEnd = offsets[last] ?? source.text.length
  }
  // 沿用原引文匹配规则，只扩展上下文，不改引文、定位或证据覆盖范围。
  const match = matchQuotation(source.text.slice(rangeStart, rangeEnd), evidence.quote)
  if (!match) throw new Error('主题成员引文不逐字匹配其来源定位。')
  const quoteStart = rangeStart + match.start, quoteEnd = rangeStart + match.end
  const owner = source.segments.find(segment => segment.start <= quoteStart && segment.end >= quoteEnd
    && (!evidence.locator.startsWith('block:') || segment.locator === evidence.locator))
  if (!owner) throw new Error('主题成员证据找不到所属原段。')
  const rawParagraph = source.text.slice(owner.start, owner.end)
  // 返回完整所属原段，后续补证和限定条件不得因句界丢失；图片编码仍由既有规则隔离。
  return /data:image\//i.test(rawParagraph) ? separateImages(rawParagraph).text : rawParagraph
}

export function citedTopicPoints(content: string, members: Point[], anchors = evidenceBlockIds(members)): Point[] {
  const body = content.replace(frontmatter, '').split(/^## 来源导航\s*$/m)[0]!
  const cited = new Set([...body.matchAll(/\]\([^\s)]*sources\/([^/]+)\.md#\^([^\s)]+)\)/g)].map(match => match[1] + '#' + match[2]))
  return members.filter(point => (anchors.get(point.point_id) ?? []).some(anchor => cited.has(point.point_id.split(':')[0] + '#' + anchor)))
}

export function topicAliases(content: string): string[] {
  const match = frontmatter.exec(content), aliases = match ? parse(match[1]!).aliases : []
  return Array.isArray(aliases) ? aliases.filter((item): item is string => typeof item === 'string') : []
}

export function synchronizeTopicMetadata(content: string, members: Point[], aliases = topicAliases(content)): string {
  const match = frontmatter.exec(content)
  if (!match) return content
  const header = parse(match[1]!), sources = [...new Set(members.flatMap(point => point.evidence.map(item => item.source_id)))].sort()
  header.title = /^# (.*)$/m.exec(content)?.[1] ?? header.title
  header.aliases = aliases
  header.sources = sources
  if (!content.includes('## 子主题导航')) {
    content = content.replace(/(## 来源导航\n)([\s\S]*?)(?=\n## |$)/, (_all, heading: string, body: string) => heading + '\n' + body.split('\n')
      .flatMap(line => {
        const source = sources.find(id => line.includes(`sources/${id}.md)`) || line.startsWith('- 来源版本：' + id + '@'))
        if (!source) return []
        const locators = [...new Set(members.flatMap(point => point.evidence.filter(item => item.source_id === source).map(item => item.locator)))]
        return [line.includes(' — ') ? line.replace(/ — .*/, ' — ' + locators.join('、')) : line]
      }).join('\n') + '\n')
  }
  return content.replace(frontmatter, `---\n${stringify(header).trimEnd()}\n---\n`)
}
