import { parse, stringify } from 'yaml'
import { evidenceBlockIds } from './anchors.js'
import { matchQuotation } from './quotation.js'
import { locatorRange } from './schema.js'
import { separateImages } from '../ingest/markdown.js'
import type { Evidence, Point, Segment } from './schema.js'

const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
const sentenceSegmenter = new Intl.Segmenter(undefined, { granularity: 'sentence' })

export const topicEvidenceContextVersion = 'topic-evidence-sentence-v2'
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
  // 上下文不穿过图片或编码；保留引文所属连续原文片段的真实偏移。
  const span = (/data:image\//i.test(rawParagraph) ? separateImages(rawParagraph).mapping
    : [{ replacement: false, originalStart: 0, originalEnd: rawParagraph.length }]).find(span => !span.replacement
    && span.originalStart <= quoteStart - owner.start && span.originalEnd >= quoteEnd - owner.start)
  if (!span) throw new Error('主题成员引文无法定位到不含图片的原文上下文。')
  const paragraphStart = owner.start + span.originalStart
  const paragraph = rawParagraph.slice(span.originalStart, span.originalEnd)
  // 软换行不是句界；保持字符长度，分句偏移仍可直接用于原文。
  const continuous = paragraph.replace(/\r?\n/g, newline => ' '.repeat(newline.length))
  const allSentences = [...sentenceSegmenter.segment(continuous)]
  const sentences = allSentences.filter(sentence =>
    sentence.index < quoteEnd - paragraphStart && sentence.index + sentence.segment.length > quoteStart - paragraphStart)
  if (!sentences.length) throw new Error('主题成员引文找不到完整句子上下文。')
  let first = sentences[0]!
  const last = sentences.at(-1)!
  // 代词可能出现在句中；所在句仍指向前句时，把前一个完整句子一并提供。
  // 现场 L227 的 them 指向前句 families，不能在句号处再次丢失该上下文。
  const preceding = allSentences[allSentences.indexOf(first) - 1]
  if (preceding && /\b(?:them|their|they|it|its|this|these|those|such)\b|该|上述|前述|他们|她们|它们|其/iu.test(first.segment)) first = preceding
  return paragraph.slice(first.index, last.index + last.segment.length).trim()
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
