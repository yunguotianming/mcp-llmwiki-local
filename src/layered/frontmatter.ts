import { parse, stringify } from 'yaml'
import { mergedTags, prepareTags } from './tags.js'
import type { PendingBuild, SourceEntry } from './schema.js'

const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
export function validTimestamp(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value))
    && new Date(value.slice(0, 10)).toISOString().slice(0, 10) === value.slice(0, 10)
}
export function publicationCreated(pending: PendingBuild, page: string, source?: SourceEntry): string {
  const created = pending.manifest.page_created ??= {}
  const candidates = [created[page], ...(source && !pending.added.includes(source.source_id) ? [source.created_at, source.updated_at] : []), pending.card.updated_at]
  const timestamp = candidates.find(validTimestamp)
  if (!timestamp) throw new Error('页面 created 缺少有效的 ISO 8601 发布时间：' + page)
  created[page] = timestamp
  if (source) source.created_at = created[page]
  return timestamp
}
export function publicationMetadata(pending: PendingBuild, page: string, content: string, sources?: string[], tags = prepareTags(pending.terms?.records)): string {
  const match = frontmatter.exec(content), header = match ? parse(match[1]!) as Record<string, unknown> : {}
  const type = page === 'index.md' || page.startsWith('terms/index-') ? 'index' : page.startsWith('sources/') ? 'source' : page.startsWith('topics/') ? 'topic' : 'term'
  const source = type === 'source' ? pending.manifest.sources.find(item => item.source_id === header.id) : undefined
  header.page_type = type; header.type = type; header.created = publicationCreated(pending, page, source)
  // 发布时依赖已合并子页；页头与依赖必须使用同一份最终来源列表。
  if (sources && type === 'topic') header.sources = sources
  if (type === 'index') {
    delete header.aliases; delete header.tags
  } else if (type === 'topic') {
    const topic = pending.topics?.state.topics.find(item => item.path === page)
    header.aliases = topic?.aliases ?? []
    header.tags = tags.frequent(pending.manifest.sources.filter(item => topic?.sources.includes(item.source_id)), 8)
  } else if (type === 'term') {
    const term = pending.terms?.records.find(item => item.id === header.id)
    header.aliases = term?.aliases ?? []
    const members = new Set(term?.contributions.map(item => item.source_id))
    header.tags = tags.canonical([term?.category ?? '', ...tags.frequent(pending.manifest.sources.filter(item => members.has(item.source_id)), 3)])
  }
  if (Array.isArray(header.tags)) header.tags = mergedTags(header.tags, pending.manifest.tag_merges)
  return `---\n${stringify(header).trimEnd()}\n---\n${match ? content.slice(match[0].length) : '\n' + content}`
}

// 发布元数据由统一出口刷新；术语正文复用不因这些字段和更新时间触发重写。
export function termContentIdentity(content: string): string {
  return content.replace(frontmatter, (_match, yaml: string) => {
    const header = parse(yaml)
    for (const key of ['type', 'created', 'aliases', 'tags', 'updated']) delete header[key]
    if (header.page_type === 'term-index') header.page_type = 'index'
    return stringify(header)
  })
}
