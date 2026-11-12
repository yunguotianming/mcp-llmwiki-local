import { terms } from './identity-search.js'

// 绝对词项覆盖率与排名分开；不把融合排名或候选存在性当作可信匹配。
export function pageRelevance(query: string, page: { title: string; aliases: string[]; snippet: string }): number {
  const normalize = (text: string) => text.normalize('NFKC').toLowerCase()
  if ([page.title, ...page.aliases].some(name => normalize(name) === normalize(query.trim()))) return 1
  const needles = [...terms(query)], text = normalize([page.title, ...page.aliases, page.snippet].join('\n'))
  return needles.filter(needle => text.includes(needle)).length / Math.max(1, needles.length)
}
export function searchConfidence(hits: { relevance: number }[], threshold: number) {
  const confidence = !hits.length ? 'none' as const : hits.some(hit => hit.relevance >= threshold) ? 'high' as const : 'low' as const
  return { confidence, ...(confidence !== 'high' ? { message: '未找到可信匹配；候选页仅供继续检索，请勿据此断言库中有答案。' } : {}) }
}
