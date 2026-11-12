import type { LibraryPolicy } from '../domain/policy.js'

export interface DedupPage { path: string; title: string; aliases: string[]; content: string; links: { ref: string; wiki: boolean }[] }
export interface DuplicateCandidate { left: string; right: string; reason: string; linkSimilarity: number; bodySimilarity: number; titleSimilarity: number }
const normalize = (value: string) => value.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
function bigrams(text: string): Set<string> {
  const chars = [...normalize(text)], result = new Set<string>()
  for (let index = 0; index < chars.length - 1; index++) result.add(chars[index]! + chars[index + 1]!)
  return result
}
function similarity(a: Set<string>, b: Set<string>): number {
  if (!a.size || !b.size) return 0
  let common = 0
  for (const token of a) if (b.has(token)) common++
  return common / (a.size + b.size - common)
}
export async function duplicateCandidates(pages: DedupPage[], policy: LibraryPolicy, signal?: AbortSignal): Promise<DuplicateCandidate[]> {
  const eligible = pages.filter(page => policy.lintDedupIncludeSources || !page.path.startsWith('sources/')).map(page => ({ page,
    names: [page.title, ...page.aliases].map(normalize).filter(Boolean),
    titles: [page.title, ...page.aliases].map(bigrams),
    body: bigrams(page.content.replace(/^#+[^\n]*$/gm, '').replace(/\[\[[^\]]*\]\]/g, '').replace(/\[[^\]]*\]\([^)]*\)/g, '')),
    links: new Set(page.links.filter(link => link.wiki).map(link => normalize(link.ref))),
  }))
  const result: DuplicateCandidate[] = []
  let compared = 0
  for (let left = 0; left < eligible.length; left++) for (let right = left + 1; right < eligible.length; right++) {
    if (++compared % 1000 === 0) { await new Promise<void>(resolve => setImmediate(resolve)); signal?.throwIfAborted() }
    const a = eligible[left]!, b = eligible[right]!
    if (a.page.path.startsWith('sources/') !== b.page.path.startsWith('sources/')) continue
    const bodySimilarity = similarity(a.body, b.body), linkSimilarity = similarity(a.links, b.links)
    const titleSimilarity = Math.max(0, ...a.titles.flatMap(title => b.titles.map(other => similarity(title, other))))
    const sameName = a.names.some(name => b.names.includes(name))
    const content = (page: DedupPage) => page.content.replace(/^#+[^\n]*$/gm, '').replace(/\s+/g, ' ').trim()
    const sameBody = !!content(a.page) && content(a.page) === content(b.page)
    if (a.page.path.startsWith('sources/') && !sameBody) continue
    const reason = sameBody ? '正文内容相同' : sameName ? '标题或别名相同' : titleSimilarity > 0 && titleSimilarity >= policy.lintBigramThreshold ? '标题或别名相似'
      : linkSimilarity > 0 && linkSimilarity >= policy.lintJaccardLinkThreshold && bodySimilarity >= policy.lintJaccardBodyGate ? '共享链接且正文相似' : ''
    if (reason) result.push({ left: a.page.path, right: b.page.path, reason, linkSimilarity, bodySimilarity, titleSimilarity })
  }
  signal?.throwIfAborted()
  return result
}
