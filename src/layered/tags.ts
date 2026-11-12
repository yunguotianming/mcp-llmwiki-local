// 部分改编自 obsidian-llm-wiki（Apache-2.0），已修改。来源及版权见 THIRD_PARTY_NOTICES.md。
import type { Term, SourceEntry, TagStatus, TagMerges } from './schema.js'

export function normalizeTag(value: string): string {
  return value.normalize('NFKC').replaceAll('#', '').trim().replace(/\s+/gu, '-')
    .replace(/[^\p{L}\p{M}\p{N}_/\-]/gu, '').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '')
}
// 身份比较保留标点，防止输出清理把 C++ 等不同词误当作 C。
const spelling = (value: string) => value.normalize('NFKC').replaceAll('#', '').trim().replace(/\s+/gu, '-').replace(/\/{2,}/g, '/').replace(/^\/+|\/+$/g, '')
const key = (value: string) => spelling(value).toLowerCase()

export function personalTag(value: string): boolean {
  const text = value.normalize('NFKC')
  if (/[\w.!#$%&'*+/=?^`{|}~-]+@[\p{L}\p{N}](?:[\p{L}\p{N}.-]*[\p{L}\p{N}])?\.[\p{L}]{2,}/u.test(text)) return true
  for (const match of text.matchAll(/(?:^|[^\p{L}\p{N}])(\+?\d[\d ()-]*\d)(?=$|[^\p{L}\p{N}])/gu)) {
    const phone = match[1]!, digits = phone.replace(/\D/g, '')
    // 国际前缀、手机号、区号电话及常见分组；普通数字和日期不按电话计数。
    if (digits.length >= 7 && digits.length <= 15 && (phone.startsWith('+') || /^1[3-9]\d{9}$|^0\d{9,11}$/.test(digits)
      || /^\d{2,4}[ -]+\d{3,4}[ -]+\d{3,4}$|^\d{2,4}[ -]+\d{7,8}$|^\d{3}[ -]+\d{4}$/.test(phone))) return true
  }
  return false
}
export function tagStatus(tags: string[], removed = 0, minimum = 3): TagStatus {
  return { ...(tags.length < minimum ? { message: '标签不足' as const } : {}), count: tags.length, minimum, personal_information_removed: removed }
}
type TagTerm = Pick<Term, 'name' | 'aliases' | 'referent'>
// 术语派生表（大小写冲突、名称映射、全部名称的规范化身份）只依赖术语数组本身；同一数组在发布时会被每页、每来源重复使用，
// 按数组对象缓存并以名称与别名签名作失效判断，结果与每次重算一致。
interface TermTables { signature: string; ambiguous: Set<string>; names: Map<string, string>; termValues: string[]; origins?: Map<string, Set<string>> }
const termTables = new WeakMap<TagTerm[], TermTables>()
// 失效判断用全部名称与别名拼成的签名：数组原地改名或增删都会让签名变化；签名本身是线性开销。
const termSignature = (terms: TagTerm[]) => JSON.stringify(terms.map(term => [term.name, term.aliases]))
function tablesFor(terms: TagTerm[]): TermTables {
  const cached = termTables.get(terms), signature = termSignature(terms)
  if (cached && cached.signature === signature) return cached
  const ambiguous = caseConflicts(terms), names = new Map<string, string>()
  // 正式标题优先于同名别称；稳定顺序解决不同术语的别名冲突。
  for (const term of terms) names.set(key(term.name), term.name)
  for (const term of terms) for (const alias of term.aliases) if (!names.has(key(alias))) names.set(key(alias), term.name)
  const value = { signature, ambiguous, names, termValues: terms.flatMap(term => [term.name, ...term.aliases]) }
  termTables.set(terms, value)
  return value
}
export function canonicalVocabulary(tags: string[], terms: TagTerm[], merges?: TagMerges) {
  return { tags: canonicalTags(mergedTags(tags, merges), terms, [], false, Number.MAX_SAFE_INTEGER),
    terms: [...new Map(terms.map(term => [JSON.stringify([term.name, term.aliases]), { name: term.name, aliases: [...term.aliases], ...(term.referent ? { referent: term.referent } : {}) }])).values()] }
}
function caseConflicts(terms: TagTerm[]): Set<string> {
  const titles = new Map<string, Set<string>>()
  for (const term of terms) {
    const variants = titles.get(key(term.name)) ?? new Set<string>()
    variants.add(spelling(term.name)); titles.set(key(term.name), variants)
  }
  return new Set([...titles].filter(([, variants]) => variants.size > 1).map(([identity]) => identity))
}
export function canonicalTags(values: string[], terms: TagTerm[] = [], vocabulary: string[] = [], only = false, limit = 8): string[] {
  return canonicalWithTables(values, tablesFor(terms), vocabulary, only, limit)
}
function canonicalWithTables(values: string[], tables: TermTables, vocabulary: string[] = [], only = false, limit = 8): string[] {
  const { ambiguous, names } = tables
  const canonical = (value: string) => ambiguous.has(key(value)) ? value : names.get(key(value)) ?? value
  const identity = (value: string) => ambiguous.has(key(value)) ? spelling(value) : key(value)
  // 术语名称部分只算一次并缓存；本次的 values 与 vocabulary 再并入副本。
  const termOrigins = tables.origins ??= (() => {
    const map = new Map<string, Set<string>>()
    for (const value of tables.termValues) {
      const original = canonical(value), output = key(normalizeTag(original)), seen = map.get(output) ?? new Set<string>()
      seen.add(key(original)); map.set(output, seen)
    }
    return map
  })()
  const origins = new Map<string, Set<string>>()
  const originOf = (output: string) => {
    let seen = origins.get(output)
    if (!seen) { seen = new Set(termOrigins.get(output)); origins.set(output, seen) }
    return seen
  }
  for (const value of [...values, ...vocabulary]) {
    const original = canonical(value)
    originOf(key(normalizeTag(original))).add(key(original))
  }
  const originCount = (output: string) => (origins.get(output) ?? termOrigins.get(output))?.size ?? 0
  const allowed = new Map(vocabulary.filter(value => key(value) && !personalTag(value)).map(value => [identity(canonical(value)), normalizeTag(canonical(value))]))
  const result = new Map<string, string>()
  for (const value of values) {
    if (personalTag(value)) continue
    const original = canonical(value), tag = normalizeTag(original), id = identity(original)
    if (personalTag(original) || !tag || !/[\p{L}_\-/]/u.test(tag) || only && allowed.size && !allowed.has(id)) continue
    if (originCount(key(tag)) > 1 && key(tag) !== key(original)) continue
    if (!result.has(id)) result.set(id, allowed.get(id) ?? tag)
  }
  return [...result.values()].slice(0, limit)
}
export function frequentTags(sources: Pick<SourceEntry, 'tags'>[], limit = 8, terms: TagTerm[] = []): string[] {
  return frequentWithTables(sources, tablesFor(terms), limit)
}
function frequentWithTables(sources: Pick<SourceEntry, 'tags'>[], tables: TermTables, limit = 8): string[] {
  const counts = new Map<string, { tag: string; count: number }>()
  const { ambiguous } = tables
  for (const source of sources) for (const tag of canonicalWithTables(source.tags ?? [], tables)) {
    const identity = ambiguous.has(key(tag)) ? spelling(tag) : key(tag), current = counts.get(identity)
    counts.set(identity, { tag: current?.tag ?? tag, count: (current?.count ?? 0) + 1 })
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || key(a.tag).localeCompare(key(b.tag))).slice(0, limit).map(item => item.tag)
}

// 发布开始时固定术语派生表；单次发布不再修改名称和别名，签名只需检查一次。
// 普通入口仍逐次检查无歧义 JSON 签名，保留调用方原地编辑术语时的失效语义。
export function prepareTags(terms: TagTerm[] = []) {
  const tables = tablesFor(terms)
  return {
    canonical: (values: string[], vocabulary: string[] = [], only = false, limit = 8) => canonicalWithTables(values, tables, vocabulary, only, limit),
    frequent: (sources: Pick<SourceEntry, 'tags'>[], limit = 8) => frequentWithTables(sources, tables, limit),
  }
}

export function mergedTags(values: string[], merges?: TagMerges): string[] {
  const aliases = new Map(merges?.groups.flatMap(group => group.tags.map(tag => [tag, group.canonical] as const)) ?? [])
  return [...new Set(values.map(tag => aliases.get(tag) ?? tag))]
}
