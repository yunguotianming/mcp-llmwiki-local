import path from 'node:path'
import type { LayeredReadView } from '../layered/revocations.js'
import { readExtraction } from '../layered/publication.js'
import { signature } from '../storage/files.js'
import { tokenCost, tokenSlice, stripBlockIds } from './page-search.js'
import { chapterBlockId } from '../layered/anchors.js'
import { PageMetadataError, pageMetadata } from './page-metadata.js'

export interface BrowseOptions { depth?: number | undefined; cursor?: string | undefined; limit?: number | undefined }
// summary 是页面原文连续片段，只去掉 YAML 头部及块 ID；保留 Markdown 与空白。
export interface BrowseNode { path: string; title: string; summary: string; type: string; parent: string; children_count: number; read_ref: string }
export async function browsePages(view: LayeredReadView, library: string, ref: string, options: BrowseOptions) {
  const depth = options.depth ?? 1, limit = options.limit ?? 20
  if (![1, 2].includes(depth) || !Number.isSafeInteger(limit) || limit < 1 || limit > 50) throw new Error('浏览 depth 为 1～2，limit 为 1～50。')
  const nodes = new Map<string, BrowseNode>(), sources = new Map<string, string[]>(), children = new Map<string, string[]>()
  const invalidMetadata: string[] = []
  nodes.set('index.md', { path: 'index.md', title: tokenSlice(view.manifest.card?.name ?? library, 80), summary: '', type: 'navigation', parent: '', children_count: 0, read_ref: 'index.md' })
  for (const relative of Object.keys(view.deps.pages).sort()) {
    const doc = await view.document(relative)
    if (doc.status !== 'ok') continue
    let metadata: ReturnType<typeof pageMetadata>
    try { metadata = pageMetadata(doc.content, relative) }
    catch (error) { if (error instanceof PageMetadataError) { invalidMetadata.push(relative); continue }; throw error }
    const { header } = metadata, content = stripBlockIds(metadata.content)
    const title = typeof header.title === 'string' ? header.title : /^#{1,6}\s+(.+)$/m.exec(content)?.[1] ?? path.posix.basename(relative, '.md')
    const type = relative.includes('#') ? 'term' : typeof header.page_type === 'string' ? header.page_type : 'navigation'
    nodes.set(relative, { path: relative, title: tokenSlice(title, 80), summary: tokenSlice(content, 120), type, parent: 'index.md', children_count: 0, read_ref: relative })
    sources.set(relative, view.deps.pages[relative]!.sources)
  }
  const attach = (parent: string, child: string) => {
    if (!nodes.has(parent) || !nodes.has(child) || parent === child) return
    const list = children.get(parent) ?? []; if (!list.includes(child)) list.push(child); children.set(parent, list)
  }
  for (const node of nodes.values()) {
    if (node.path === 'index.md') continue
    if (node.type === 'topic') {
      const topic = view.manifest.topics?.topics.find(topic => topic.path === node.path)
      const stateParent = view.manifest.topics?.topics.find(parent => parent.id === topic?.parent_id)?.path
      const dependencyParent = Object.entries(view.deps.pages).find(([, deps]) => deps.children?.some(child => child.page === node.path))?.[0]
      const parent = stateParent ?? dependencyParent ?? (path.posix.dirname(node.path) + '.md')
      node.parent = nodes.has(parent) ? parent : 'index.md'; attach(node.parent, node.path)
      for (const related of nodes.values()) if (['source', 'term', 'term-index'].includes(related.type) && sources.get(related.path)?.some(id => sources.get(node.path)?.includes(id))) attach(node.path, related.path)
    } else if (node.path.includes('#')) { node.parent = node.path.split('#')[0]!; attach(node.parent, node.path) }
  }
  for (const node of nodes.values()) if (node.type !== 'topic' && node.path !== 'index.md' && !node.path.includes('#')) {
    node.parent = [...children].find(([, list]) => list.includes(node.path))?.[0] ?? 'index.md'
    attach(node.parent, node.path)
  }
  // 章节只在来源及章节下钻时加载；目录不需要读取全部提取对象。
  let current = ref === 'root' ? 'index.md' : ref.includes('#') || /^[a-z][a-z0-9-]*$/i.test(ref) && !/^(S|T|TM|TI)-\d/.test(ref) ? ref : view.resolve(ref)
  for (const source of view.manifest.sources.filter(source => current.startsWith(`sources/${source.source_id}.md`) || !nodes.has(current) && !current.includes('/'))) {
    if (!nodes.has(`sources/${source.source_id}.md`)) continue
    const extraction = await readExtraction(view.root, source.extract.path), base = `sources/${source.source_id}.md`
    const chapter = extraction.chapters?.find(chapter => chapter.id === ref)
    if (!current.startsWith(base) && !chapter) continue
    if (chapter) current = base + '#^' + chapterBlockId(chapter.id)
    for (const chapter of extraction.chapters ?? []) {
      const relative = base + '#^' + chapterBlockId(chapter.id), parent = chapter.parent_id ? base + '#^' + chapterBlockId(chapter.parent_id) : base
      nodes.set(relative, { path: relative, title: tokenSlice(chapter.title, 80), summary: '', type: 'chapter', parent, children_count: 0, read_ref: relative })
    }
    for (const chapter of extraction.chapters ?? []) attach(chapter.parent_id ? base + '#^' + chapterBlockId(chapter.parent_id) : base, base + '#^' + chapterBlockId(chapter.id))
    break
  }
  const node = nodes.get(current)
  if (!node) throw new Error('浏览节点不存在或当前不可读。')
  for (const item of nodes.values()) item.children_count = children.get(item.path)?.length ?? 0
  const order: string[] = [], seen = new Set([current])
  const walk = (parent: string, remaining: number) => {
    for (const child of (children.get(parent) ?? []).sort()) if (!seen.has(child)) {
      seen.add(child); order.push(child); if (remaining > 1) walk(child, remaining - 1)
    }
  }; walk(current, depth)
  const identity = signature(JSON.stringify([view.version, view.generation, current, depth])), prefix = identity + ':'
  const offset = options.cursor?.startsWith(prefix) ? Number(options.cursor.slice(prefix.length)) : options.cursor ? NaN : 0
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > order.length) throw new Error('浏览游标已过期或不属于当前节点。')
  const result = { library, version: view.version, node, children: [] as BrowseNode[], next_cursor: null as string | null,
    ...(invalidMetadata.length ? { warning: `${invalidMetadata.length} 个页面元数据格式无效，本次跳过；格式错误不代表内容无依据，其他来源及原文仍可读取。页面示例：` + invalidMetadata.slice(0, 3).join('、') } : {}) }
  let next = offset
  while (next < order.length && result.children.length < limit) {
    const candidate = nodes.get(order[next]!)!
    // 首个完整节点保证可达；单节点超预算时允许独占一页，不能返回停滞的空页。
    if (result.children.length && tokenCost(JSON.stringify({ ...result, children: [...result.children, candidate], next_cursor: prefix + (next + 1) })) > 2000) break
    result.children.push(candidate); next++
  }
  // 满页提供续读位置；正好到末尾时下一次返回空页及 null，游标仍只向前。
  if (next < order.length || result.children.length === limit) result.next_cursor = prefix + next
  return result
}
