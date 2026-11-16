// 部分改编自 obsidian-llm-wiki（Apache-2.0），已修改。来源及版权见 THIRD_PARTY_NOTICES.md。
import { extractionSelectivity, ordinaryPointLimit, packPointLimit } from '../domain/granularity.js'
import { sourceOverview } from './overview.js'
import { matchQuotation, normalizeQuotation } from './quotation.js'
import { parseModelJson } from '../llm/json.js'
import { chapterBlockId, evidenceBlockIds, renderEvidence } from './anchors.js'
import { z } from 'zod'
import { stringify } from 'yaml'
import { randomUUID } from 'node:crypto'
import type { ModelAttempt } from '../llm/client.js'
import { CallGate, mapConcurrent } from '../llm/scheduler.js'
import { separateImages } from '../ingest/markdown.js'
import { allocatePointQuotas } from './budget.js'
import { isModelTransportError, ModelCallError } from '../llm/client.js'
import { appendLog, hash, hashName, writeJson } from './files.js'
import { locatorRange, sections } from './schema.js'
export { locatorRange } from './schema.js'
import type { BuildLayeredOptions, Extraction, ExtractionGap, ExtractionRejection, Point, Processing, SourceChapter, SourceEntry, SourceMetadata } from './schema.js'
import type { LocalSource } from './snapshot.js'
import { evidenceDictionary, expandEvidenceReferences } from './evidence.js'
import { localReferences } from './references.js'
import { defaultPolicy } from '../domain/policy.js'
import { parseMarkdown as fromMarkdown } from '../ingest/markdown.js'
import type { Nodes } from 'mdast'
import { layeredSettings } from '../domain/config.js'
import { bodyCharacters, chapterMinimum, coveragePurpose, longdocFingerprint, sourceChapters, sourceQuotas, synthesizeSourceSummary } from './longdoc.js'
import path from 'node:path'
import { canonicalTags, personalTag, tagStatus } from './tags.js'
import { recoveryTask, shareExtraction, validExtractionCache, validatedTask } from './extraction-cache.js'
import { explanationRule, nullableExplanation, jsonProtocol, schemaJSON } from '../llm/protocol.js'
import { correctionBatches, correctionContext, evidenceParagraph, repairParagraphs, sameClaim } from './corrections.js'
import { mergeModels, modelUsage } from './models.js'
import type { ModelRef } from './models.js'
import { activeAcceptedRefs, aliasAcceptedResponse, businessValue, recoveryBudget, recoveryContext, rejectAcceptedResponse, verifyAcceptedRefs, withAcceptedCall } from './accepted.js'
import type { AcceptedRef } from './accepted.js'

export const pointPriority = (section: unknown, text = '') => {
  if (section === '主要发现') return 0
  // “对象与条件”同时容纳样本、适用条件及背景，不能把整类都提到方法级。
  const sample = section === '对象与条件' && /样本|抽样|招募|入选|纳入|排除标准|参与者|受访者|受试者|被试|\b(?:samples?|participants?|respondents?|subjects?|recruit\w*|inclusion|exclusion)\b/iu.test(text)
  return section === '方法' || sample ? 1 : section === '限制' || section === '对象与条件' ? 2 : 3
}
export function selectSourcePoints(points: Point[], limit: number, floors: { ids: Set<string>; minimum: number }[]): Set<string> {
  const priority = [...points].sort((a, b) => pointPriority(a.section, a.text) - pointPriority(b.section, b.text)
    || Number(a.section !== '限制') - Number(b.section !== '限制') || a.point_id.localeCompare(b.point_id))
  const seen = new Set<string>()
  const distinct = priority.filter(point => {
    if (points.length <= limit) return true
    // 只合并同证据、同主张的排版和引导语变体；数值、否定、对象与条件仍参与比较。
    const text = normalizeQuotation(point.text).replace(/^(?:研究(?:结果)?(?:显示|表明|发现)|结果(?:显示|表明))[，,:：]?\s*/u, '')
      .replace(/[\s，,。；;：:]/g, '')
    const key = JSON.stringify([text, point.evidence.map(item => [item.source_id, item.source_version, normalizeQuotation(item.quote)]).sort()])
    if (seen.has(key)) return false
    seen.add(key); return true
  })
  const selected = new Set<string>()
  for (const floor of floors) {
    // 底线不能靠已去重的同主张凑数；真实不足由后续章节缺口说明。
    const candidates = distinct.filter(point => floor.ids.has(point.point_id))
    for (const point of candidates.slice(0, floor.minimum)) if (selected.size < limit) selected.add(point.point_id)
  }
  for (const point of distinct) if (selected.size < limit) selected.add(point.point_id)
  return selected
}
const credibility = z.enum(['high', 'medium', 'low', 'unknown'])
export const outputSchema = z.object({
  tags: z.array(z.string().trim().min(1)).max(8),
  credibility, credibility_reason: nullableExplanation,
  summary_point_indices: z.array(z.number().int().nonnegative()).optional(),
  points: z.array(z.object({ paragraph_id: z.number().int().nonnegative(), text: z.string().trim().min(1), section: z.enum(sections),
    evidence: z.array(z.object({ paragraph_id: z.number().int().nonnegative().optional(), locator: z.string(), quote: z.string().min(1).regex(/\S/, '引文不能为空白') })).min(1).meta({ examples: [[
      { paragraph_id: 0, locator: 'L1-L1', quote: '访谈。' }, { paragraph_id: 2, locator: 'L5-L5', quote: '两组。' },
    ]] }) })),
  terms: z.array(z.object({ referent: z.string().trim().min(1).optional(), paragraph_id: z.number().int().nonnegative(), name: z.string().trim().min(1), category: z.string().trim().min(1),
    aliases: z.array(z.string()), locator: z.string(), note: nullableExplanation })),
})
// 供应商约束和程序校验使用同一条目结构；证据编号在进入原有逐字校验前展开。
const wirePoint = outputSchema.shape.points.element.extend({ evidence: z.array(z.union([
  outputSchema.shape.points.element.shape.evidence.element, z.object({ evidence_ref: z.string().min(1), paragraph_id: z.number().int().nonnegative().optional() }),
])).min(1).meta(outputSchema.shape.points.element.shape.evidence.meta()!) })
export const wireOutput = outputSchema.omit({ summary_point_indices: true }).extend({ points: z.array(wirePoint) })
const longdocOutput = wireOutput.extend({ summary_point_indices: z.array(z.number().int().nonnegative()) })
const coverageBatchOutput = z.object({ chapters: z.array(z.object({ chapter_id: z.string().min(1), points: z.array(wirePoint) })) })
// 组级只校验外壳，条目结构错误留给各自的一次纠正，不牵连同组有效结果。
const groupSchema = outputSchema.extend({ tags: z.array(outputSchema.shape.tags.element).max(8), points: z.array(z.unknown()), terms: z.array(z.unknown()) })
const completeGroupSchema = outputSchema.extend({ tags: groupSchema.shape.tags })
function cachedGroup(raw: string, complete = false): z.infer<typeof groupSchema> | undefined {
  try { return (complete ? completeGroupSchema : groupSchema).safeParse(parseModelJson(raw, schemaJSON(wireOutput))).data } catch { return undefined }
}
export function reusableExtraction(value: unknown): value is Extraction {
  return validExtractionCache(value, (raw, complete) => Boolean(cachedGroup(raw, complete)))
}
function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined
}
function normalizeItem(value: unknown, kind: 'point' | 'term'): unknown {
  let item = object(value)
  if (!item) return value
  const feedback = object(item.validationFeedback)
  // 真实留痕中模型会回显请求；仅解包种类一致且没有并列条目的唯一外壳。
  if (feedback?.kind === kind && object(feedback.item) && Object.keys(item).every(key => ['source_id', 'validationFeedback', 'paragraphs'].includes(key))) item = object(feedback.item)!
  const fields = kind === 'point' ? ['paragraph_id', 'text', 'section', 'evidence'] : ['paragraph_id', 'name', 'category', 'aliases', 'locator', 'note']
  const result = { ...item }
  for (const field of fields) {
    const keys = Object.keys(item).filter(key => key.trim().toLowerCase() === field)
    // 大小写或空白变体只有唯一键时才可无歧义地改名。
    if (keys.length === 1 && keys[0] !== field) { result[field] = item[keys[0]!]; delete result[keys[0]!] }
  }
  if (kind === 'point' && typeof result.section === 'string') result.section = result.section.trim()
  // 不改写 paragraph_id、locator 或 quote 的值；未知字段由原有 schema 剥离。
  return result
}
function schemaReasons(error: z.ZodError, value: unknown): ExtractionRejection[] {
  return error.issues.flatMap(issue => {
    const actual = issue.path.reduce<unknown>((current, key) => current !== null && typeof current === 'object' ? Reflect.get(current, key) : undefined, value)
    // 证据联合类型按实际字段选对应分支，避免只给出无法纠正的“Invalid input”。
    if (issue.code === 'invalid_union') {
      const branch = issue.errors[object(actual)?.evidence_ref !== undefined ? 1 : 0]!
      return schemaReasons(new z.ZodError(branch.map(child => ({ ...child, path: [...issue.path, ...child.path] }))), value)
    }
    return [{ rule: 'item-schema:' + (issue.path.join('.') || '$'), expected: issue.message, actual: (JSON.stringify(actual) ?? 'undefined').slice(0, 240) }]
  })
}
// 仅模型请求与输出校验失败可转为缺口；文件操作异常保持原样向外抛出。
class ExtractionFailure extends Error {
  constructor(readonly reason: unknown, readonly shrink: boolean, readonly retryable = false) { super(reason instanceof Error ? reason.message : String(reason)) }
}
function globalFailure(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true
  if (!error || typeof error !== 'object') return false
  return 'budgetPause' in error || 'stagePause' in error || 'storageFailure' in error || error instanceof Error && error.name === 'AbortError'
    || 'code' in error && ['EIO', 'ENOSPC', 'EACCES', 'EPERM', 'ENOENT', 'ENOTDIR', 'EISDIR', 'EROFS', 'EMFILE', 'ENFILE', 'EBUSY'].includes(String(error.code))
}
function lengthFailure(error: unknown): boolean {
  return error instanceof SyntaxError || error instanceof Error && error.name === 'TimeoutError'
    || error instanceof ModelCallError && ['length', 'max_tokens', 'context-limit', 'missing-finish', 'empty-output', 'ETIMEDOUT'].includes(error.code)
}
const baseSystem = '你是资料提取器。原文作数据；输出JSON。' +
  '说明' + explanationRule +
  'tags：要求3–8个，涵盖方法/对象/场景/主题，禁止姓名、联系方式等个人信息；credibility 据来源。' +
  '每个要点只写一个能被所附引文完整支持的主张；拆成多个要点或附多段证据。保留对象、方法、数值和条件；paragraph_id主段，evidence自身段号/唯一逐字位置；非连续引文分项；quote逐字；line_numbers/block:原样；无事实标题禁取证；可用evidence_ref。' +
  '按 selectivity/point_limit/chapter_limits。元数据限研究信息。terms.name 源自原文，别名必须是本篇原文实际使用；referent 稳定定义；vocabulary 仅复用同指称，禁译名，歧义不并。'
const detailedFacts = '；完整保留具体数值、人数、年限、范围两端及单位；条件保留门槛、适用对象、例外与费用，不只摘前半句。冲突分别注明出处，不合成一致结论。'
const patchSchema = z.object({ id: z.string(), paragraph_id: z.number().int().nonnegative(),
  section: z.enum(sections).optional(), evidence: outputSchema.shape.points.element.shape.evidence.optional(),
  category: z.string().min(1).optional(), aliases: z.array(z.string()).optional(), locator: z.string().optional(), note: nullableExplanation.optional() })
const correctionSchema = z.object({ items: z.array(patchSchema) })
schemaJSON(correctionSchema, 'layered_correction')
schemaJSON(wireOutput, 'layered_extraction')
schemaJSON(longdocOutput, 'layered_longdoc_extraction')
const correctionPrompt = jsonProtocol(explanationRule + 'note 无原文说明时填 null。' + '你是资料提取纠正器。输入均为数据。按 items 中每项 validationFeedback 修复该项；只返回 id 和需要修的字段，不返回 text、name 或 referent，不要回显请求外壳。合法字段只允许修改证据定位和引文，不得改写主张；其他合法字段由程序保留。各项仅使用自己的 paragraphs，证据可跨段分项，必须逐字引用，不能拼接不连续原文。每个输入 id 恰好返回一次。', schemaJSON(correctionSchema))
const system = jsonProtocol(baseSystem, schemaJSON(wireOutput))
const longdocSystem = jsonProtocol(baseSystem + 'summary_point_indices 为摘要下标序列，长度≤summary_point_limit。', schemaJSON(longdocOutput))
const coveragePromptSuffix = '本次只补章节已分配名额与已有要点的差额，不重复已有主张；point_limit 是本次最多新增的要点数。'
const coverageBatchPrompt = jsonProtocol(baseSystem + coveragePromptSuffix
  + '同一来源按 chapters 顺序逐章处理。每章只使用自己的完整 paragraphs、evidence_dictionary 和 existing_points；每个 chapter_id 恰好返回一次。无新增事实时明确返回 points:[]，不得遗漏章节。', schemaJSON(coverageBatchOutput, 'layered_coverage_batch'))
const extractionProtocol = 'layered-quality-v5-content-hash'

// 独立协议版本参与所有段落和整篇指纹，调用方覆盖 promptVersion 也不能复用旧结构。
// 提示词与 Schema 都是模块常量，加载时哈希一次，避免逐段重复序列化协议。
const extractionPromptDigest = hash(JSON.stringify([extractionProtocol, 'source-selection-v6-pack-limit-dedup-priority', 'rules-before-source-v1', system, longdocSystem, correctionPrompt, coveragePromptSuffix, coverageBatchPrompt, detailedFacts,
  outputSchema.toJSONSchema(), schemaJSON(wireOutput), schemaJSON(longdocOutput), schemaJSON(correctionSchema), sections]))
export function extractionPromptHash(): string {
  return extractionPromptDigest
}
const customPointLimitDigest = hash(JSON.stringify([extractionPromptDigest, 'custom-book-hard-limit-v1']))
const processingPromptHash = (processing: Processing) => processing.granularity === 'custom' ? customPointLimitDigest : extractionPromptHash()
export function extractionProcessing(processing: Processing): Processing {
  return { tier: processing.tier, prompt_version: processing.prompt_version, prompt_hash: processingPromptHash(processing),
    ...(processing.granularity === undefined ? {} : { granularity: processing.granularity }),
    ...(processing.image_policy === undefined ? {} : { image_policy: processing.image_policy }) }
}
export function processingFingerprint(processing: Processing, resources: string[] = []): string {
  const content = { tier: processing.tier, granularity: processing.granularity, prompt_version: processing.prompt_version,
    prompt_hash: processing.prompt_hash ?? extractionPromptHash(), image_policy: processing.image_policy }
  return hash(JSON.stringify([extractionProtocol, content, processing.image_policy ? resources : []]))
}
export function sameProcessing(left: Processing | undefined, right: Processing | undefined): boolean {
  // 旧自定义成功组的逐字证据仍可复用；计划和最终限额另行按新上限校验。
  const compatible = (value: Processing) => value.granularity === 'custom' && value.prompt_hash === extractionPromptHash()
    ? { ...value, prompt_hash: customPointLimitDigest } : value
  return Boolean(left?.prompt_hash && right?.prompt_hash && processingFingerprint(compatible(left)) === processingFingerprint(compatible(right)))
}
export function extractionFingerprint(source: LocalSource, processing: Processing, resources: string[][] = [], grouping?: string): string {
  const segments = source.segments.length ? source.segments.map((_, index) => processingFingerprint(processing, resources[index])) : [processingFingerprint(processing)]
  return hash(JSON.stringify(grouping ? [segments, grouping] : segments))
}
export function resultFingerprint(extraction: Extraction): string {
  const segments = extraction.segments.length ? extraction.segments.map(segment => segment.processing_fingerprint) : [processingFingerprint(extraction.processing)]
  return hash(JSON.stringify(extraction.grouping_fingerprint ? [segments, extraction.grouping_fingerprint] : segments))
}
// 只排除无法匹配任何已校验成员的旧摘要组，不改变模型内容、计划或作者归属。
export function excludeEmptySourceSummary(result: Extraction, key: string, points: { text: string; evidence: { quote: string; locator: string }[] }[]): boolean {
  const group = result.group_cache?.[key]
  if (!group?.missing_summary || result.segments.flatMap(segment => segment.points).some(point => points.some(item =>
    item.text === point.text && item.evidence.every(evidence => point.evidence.some(saved => saved.quote === evidence.quote && saved.locator === evidence.locator))))) return false
  group.missing_summary = false
  group.summary_excluded_reason = '无可用摘要依据：原组在现有已校验要点中没有匹配成员。'
  result.gaps = result.gaps?.filter(gap => gap.kind !== 'summary' || !gap.segment_hashes.length || !gap.segment_hashes.every(hash => group.parts.some(part => part.text_hash === hash))) ?? []
  return true
}
export function retryableExtractionGap(gap: ExtractionGap): boolean {
  return gap.kind === 'group' && (gap.retryable ?? gap.reasons.some(reason => reason.rule === 'extract-group' && isModelTransportError(reason.actual)))
}
export function extractionNeedsRetry(extraction: Extraction, retryableOnly = false): boolean {
  return Boolean(extraction.gaps?.some(gap => retryableOnly ? retryableExtractionGap(gap) : gap.kind === 'group' || gap.kind === 'summary'))
}
interface Paragraph { paragraph_id: number; locator: string; text_hash: string; text: string }
function paragraphs(source: LocalSource): Paragraph[] {
  // 仅替换图片编码并补回换行，快照、段落哈希与原文偏移不变。
  const parsed = separateImages(source.text)
  const edits = parsed.mapping.filter(item => item.replacement && /data:image\//i.test(source.text.slice(item.originalStart, item.originalEnd)))
  return source.segments.map((segment, index) => {
    let text = source.text.slice(segment.start, segment.end)
    for (const edit of [...edits].reverse()) {
      if (edit.originalStart < segment.start || edit.originalEnd > segment.end) continue
      const original = source.text.slice(edit.originalStart, edit.originalEnd)
      const replacement = `[图片：${index + 1}，${segment.locator}]` + (original.match(/\r?\n/g) ?? []).join('')
      text = text.slice(0, edit.originalStart - segment.start) + replacement + text.slice(edit.originalEnd - segment.start)
    }
    return { paragraph_id: index, locator: segment.locator, text_hash: segment.text_hash, text }
  })
}
function numbered(parts: Paragraph[]) {
  return parts.map(part => ({ ...part, ...part.locator.startsWith('block:') ? {} : { line_numbers: part.text.split(/\r?\n/).map((_, index) => locatorRange(part.locator)[0] + index) } }))
}
// 术语词表只带名称或别名出现在本包正文里的项；未出现的术语无从复用，只会挤占正文预算。
export function packVocabulary(parts: Paragraph[], vocabulary: NonNullable<BuildLayeredOptions['vocabulary']>): NonNullable<BuildLayeredOptions['vocabulary']> {
  if (!vocabulary.terms.length) return vocabulary
  const fold = (value: string) => value.normalize('NFKC').toLowerCase()
  const text = fold(parts.map(part => part.text).join('\n'))
  return { tags: vocabulary.tags, terms: vocabulary.terms.filter(term => [term.name, ...term.aliases].some(name => fold(name).trim() && text.includes(fold(name).trim()))) }
}
function extractionInput(sourceId: string, source: LocalSource, processing: Processing, parts: Paragraph[], quota: number, summaryLimit?: number, chapters: SourceChapter[] = [], vocabulary: NonNullable<BuildLayeredOptions['vocabulary']> = { tags: [], terms: [] }): string {
  const evidence = evidenceDictionary(parts)
  const ids = new Set(parts.map(part => part.paragraph_id))
  const chapterLimits = chapters.filter(chapter => parts.some(part => chapter.paragraph_ids.includes(part.paragraph_id) && !/^#{1,6}\s|\n[=-]+\s*$/.test(part.text))).map(chapter => ({ title: chapter.title,
    paragraph_ids: chapter.paragraph_ids.filter(id => ids.has(id)), point_limit: chapter.quota,
    purpose: coveragePurpose(chapter.title, parts.filter(part => chapter.paragraph_ids.includes(part.paragraph_id)).map(part => part.text).join('\n')) }))
  return JSON.stringify({ tier: processing.tier, selectivity: extractionSelectivity(processing.tier, processing.granularity),
    ...(processing.tier >= 100 ? { fact_requirements: detailedFacts } : {}),
    point_limit: quota, ...(summaryLimit === undefined ? {} : { summary_point_limit: summaryLimit }),
    source_id: sourceId, source_version: source.sourceVersion ?? source.contentHash, vocabulary: packVocabulary(parts, vocabulary),
    ...(chapterLimits.length ? { chapter_limits: chapterLimits } : {}),
    metadata: source.metadata, paragraphs: evidence.paragraphs.map((part, index) => ({ ...part, ...part.locator.startsWith('block:') ? {} : { line_numbers: numbered([parts[index]!])[0]!.line_numbers } })), evidence_dictionary: evidence.dictionary })
}
function extractionRequest(prompt: string, request: string, schema: z.ZodType) {
  const input = JSON.parse(request), evidenceIds = Object.keys(input.evidence_dictionary ?? {})
  const evidenceRefs = localReferences(evidenceIds, 'E')
  if (evidenceIds.length) request = JSON.stringify({ ...input,
    evidence_dictionary: Object.fromEntries(evidenceIds.map(id => [evidenceRefs.alias(id), input.evidence_dictionary[id]])),
    paragraphs: input.paragraphs.map((part: { evidence_ref?: string }) => part.evidence_ref
      ? { ...part, evidence_ref: evidenceRefs.alias(part.evidence_ref) } : part),
  })
  return { prompt: jsonProtocol(prompt, schemaJSON(schema)), request, evidenceIds, evidenceRefs }
}
function isLongdoc(chunks: Paragraph[][]): boolean {
  return chunks.length > 1 && chunks.some(parts => parts.some(part => fromMarkdown(part.text).children.some(node => node.type === 'heading')))
}
export function groupingFingerprint(chunks: Paragraph[][], settings = layeredSettings(), legacyRequestOrder = false): string {
  // 记录实际调用边界与组内有序段落哈希；长段片段另记摘要，不记录设置档位和行位置。
  const parts = chunks.map(parts => parts.map(part => [part.text_hash, hash(part.text)]))
  return hash(JSON.stringify(['numbered-quality-v1', longdocFingerprint(settings, legacyRequestOrder), parts]))
}
export function extractionPlanConfigFingerprint(options: BuildLayeredOptions, settings = layeredSettings(options.topics || {}, options.tier)): string {
  const configured = (options.topics || {}) as Record<string, unknown>
  const resolved = settings as unknown as Record<string, unknown>
  const fields = ['extractMaxInputBytes', 'extractTargetRatio', 'extractCeilingRatio', 'extractMaxSplitDepth', 'sourcePackRatio']
  return hash(JSON.stringify(['extraction-plan-v1', options.maxInputBytes ?? null,
    fields.map(field => [field, configured[field] ?? null, resolved[field] ?? null])]))
}

// 已发布来源只因用户处理设置或原文变化重提；程序升级不替用户发起重新提取。
export function publishedExtractionUnchanged(previous: Extraction | undefined, sourceId: string, source: LocalSource, processing: Processing,
  options: BuildLayeredOptions, settings = layeredSettings(options.topics || {}, options.tier)): boolean {
  if (!previous || previous.in_progress || !reusableExtraction(previous) || !previous.chunk_plan
    || previous.source_id !== sourceId || previous.source_hash !== source.contentHash
    || !recoveryContext() && previous.plan_config_fingerprint !== extractionPlanConfigFingerprint(options, settings)) return false
  const requested = (value: Processing) => [value.tier, value.granularity, value.prompt_version, value.image_policy]
  if (JSON.stringify(requested(previous.processing)) !== JSON.stringify(requested(processing))) return false
  return previous.grouping_fingerprint === groupingFingerprint(previous.chunk_plan, settings)
    || previous.grouping_fingerprint === groupingFingerprint(previous.chunk_plan, settings, true)
}
function matchesSourcePlan(source: LocalSource, plan: Paragraph[][]): boolean {
  if (plan.some(parts => !parts.length)) return false
  const expected = paragraphs(source)
  let index = 0, offset = 0
  for (const part of plan.flat()) {
    const original = expected[index]
    if (!original || part.paragraph_id !== original.paragraph_id || part.text_hash !== original.text_hash
      || !part.text.length && original.text.length > 0 || original.text.slice(offset, offset + part.text.length) !== part.text) return false
    let locator = original.locator
    if (!locator.startsWith('block:') && (offset || part.text !== original.text)) {
      const start = locatorRange(original.locator)[0] + (original.text.slice(0, offset).match(/\n/g) ?? []).length
      locator = `L${start}-L${start + (part.text.match(/\n/g) ?? []).length}`
    }
    if (part.locator !== locator) return false
    offset += part.text.length
    if (offset === original.text.length) { index++; offset = 0 }
  }
  return index === expected.length && offset === 0
}
export function reusableExtractionPlan(previous: Extraction | undefined, sourceId: string, source: LocalSource, processing: Processing,
  options: BuildLayeredOptions, inputLimit: number, settings = layeredSettings(options.topics || {}, options.tier),
  vocabulary: BuildLayeredOptions['vocabulary'] = options.vocabulary ?? { tags: options.tagVocabulary ?? [], terms: [] }): Paragraph[][] | undefined {
  processing = extractionProcessing(processing)
  if (!previous || !reusableExtraction(previous) || !sameProcessing(previous.processing, processing)
    || previous.source_id !== sourceId || previous.source_hash !== source.contentHash || !(inputLimit > 0)
    || typeof previous.plan_book !== 'boolean' || typeof previous.plan_longdoc !== 'boolean'
    || !previous.chunk_plan || !previous.plan_quotas || !previous.chapters) return undefined
  const plan = previous.chunk_plan
  if (previous.segments.length !== source.segments.length || source.segments.some((segment, index) => {
    const before = previous.segments[index]!
    return before.text_hash !== segment.text_hash || before.locator !== segment.locator || before.start !== segment.start || before.end !== segment.end
  }) || !matchesSourcePlan(source, plan) || previous.grouping_fingerprint !== groupingFingerprint(plan, settings)
    || previous.plan_longdoc !== (previous.plan_book && isLongdoc(plan))) return undefined
  const whole = paragraphs(source)
  const wholeChars = whole.reduce((sum, part) => sum + Array.from(part.text).length, 0)
  const hardLimit = previous.plan_book && processing.granularity !== 'custom' ? undefined : packPointLimit(wholeChars, processing.tier, processing.granularity)
  const compatibleBookLimit = previous.plan_book && processing.granularity === 'custom' && previous.plan_hard_limit === undefined
    && previous.point_limit === hardLimit
  if (previous.plan_hard_limit !== hardLimit && !compatibleBookLimit || previous.plan_quotas.length !== plan.length
    || previous.plan_quotas.some(quota => !Number.isSafeInteger(quota) || quota < 0)) return undefined
  let allocation: ReturnType<typeof sourceQuotas>
  try { allocation = sourceQuotas(source, plan, processing.tier, settings, hardLimit) }
  catch {
    try { allocation = sourceQuotas(source, plan, processing.tier, { ...settings, sourceChapterMinPoints: 0 }, hardLimit) }
    catch { return undefined }
  }
  const chapters = (values: SourceChapter[]) => values.map(chapter => [chapter.id, chapter.title, chapter.depth, chapter.parent_id, chapter.paragraph_ids])
  const selectLimit = hardLimit === undefined ? allocation.limit : Math.max(allocation.limit, ordinaryPointLimit(wholeChars, processing.tier, processing.granularity, settings))
  if (previous.point_limit !== selectLimit || plan.length && previous.plan_quotas.reduce((sum, quota) => sum + quota, 0) !== allocation.limit
    || JSON.stringify(chapters(previous.chapters)) !== JSON.stringify(chapters(allocation.chapters))) return undefined
  if (!recoveryContext()) for (const [index, parts] of plan.entries()) {
    const request = extractionRequest(previous.plan_longdoc ? longdocSystem : system,
      extractionInput(sourceId, source, processing, parts, previous.plan_quotas[index]!,
        previous.plan_longdoc ? settings.sourceSummaryMaxPoints : undefined, previous.chapters, vocabulary),
      previous.plan_longdoc ? longdocOutput : wireOutput)
    if (Buffer.byteLength(request.prompt + request.request) > inputLimit) return undefined
  }
  // 接受协议冻结成功组；旧路径仍按当前预算校验整个候选计划。
  return structuredClone(plan)
}
export function planExtraction(sourceId: string, source: LocalSource, processing: Processing, inputLimit: number, settings = layeredSettings({}, processing.tier), vocabulary?: BuildLayeredOptions['vocabulary']): Paragraph[][] {
  let plan = planExtractionAtBudget(sourceId, source, processing, inputLimit, settings, vocabulary)
  if (!settings.sourcePackRatio || source.text.length < settings.sourcePointBaseChars) return plan
  const whole = paragraphs(source), book = sourceChapters(source).length > 0 && Buffer.byteLength(system + extractionInput(sourceId, source, processing, whole, processing.tier)) > inputLimit
  const hardLimit = book && processing.granularity !== 'custom' ? undefined : packPointLimit(whole.reduce((sum, part) => sum + Array.from(part.text).length, 0), processing.tier, processing.granularity)
  // 只拆高输出额度的大包；低配额长章不因正文长而增加调用。篇级总额保持不变。
  let limit = inputLimit
  while (limit > 32768) {
    let quotas: number[]
    try { quotas = sourceQuotas(source, plan, processing.tier, settings, hardLimit).quotas } catch { return plan }
    if (!quotas.some((quota, index) => quota > 50 && plan[index]!.reduce((sum, part) => sum + Buffer.byteLength(part.text), 0) > 24000)) break
    limit = Math.max(32768, Math.floor(limit / 2))
    plan = planExtractionAtBudget(sourceId, source, processing, limit, settings, vocabulary)
  }
  return plan
}
function planExtractionAtBudget(sourceId: string, source: LocalSource, processing: Processing, inputLimit: number, settings: ReturnType<typeof layeredSettings>, vocabulary?: BuildLayeredOptions['vocabulary']): Paragraph[][] {
  const chapters = sourceChapters(source)
  // 预留完整章节约束字段及数值的最大序列化长度，实际请求仍受同一上限约束。
  let hints = chapters.map(chapter => ({ ...chapter, quota: processing.tier * settings.sourcePointMaxMultiplier }))
  let longdoc = false
  const bytes = (parts: Paragraph[]) => Buffer.byteLength((longdoc ? longdocSystem : system) + extractionInput(sourceId, source, processing, parts, processing.tier, longdoc ? settings.sourceSummaryMaxPoints : undefined, hints, vocabulary))
  const all = paragraphs(source), chunks: Paragraph[][] = []
  let target = inputLimit * settings.extractTargetRatio, ceiling = inputLimit * settings.extractCeilingRatio
  const units: Paragraph[][] = []
  if (bytes([]) >= ceiling) throw new Error('模型上下文不足以容纳提取提示词。')
  if (!all.length) return chunks
  // 整篇边界按实际配额计算，避免预留数字误触发切包。
  const ordinaryLimit = packPointLimit(all.reduce((sum, part) => sum + Array.from(part.text).length, 0), processing.tier, processing.granularity)
  try { hints = sourceQuotas(source, [all], processing.tier, settings, ordinaryLimit).chapters } catch { /* 底线冲突由提取阶段登记缺口。 */ }
  const wholeBytes = Buffer.byteLength(system + extractionInput(sourceId, source, processing, all, ordinaryLimit, undefined, hints, vocabulary)), activePacking = wholeBytes <= inputLimit && settings.sourcePackRatio > 0 && chapters.length > 1 && wholeBytes > inputLimit * settings.sourcePackRatio
  if (wholeBytes <= inputLimit && !activePacking) return [all]
  if (activePacking && wholeBytes <= inputLimit * 3) {
    // 2～4 包按实际上下文预算分摊；短章顺序合并，不为标题单独发起调用。
    const count = Math.min(4, Math.max(2, Math.ceil(wholeBytes / (inputLimit * settings.sourcePackRatio))))
    target = Math.min(target, bytes([]) + Math.ceil((wholeBytes - bytes([])) / count))
    ceiling = Math.min(ceiling, Math.max(target, wholeBytes / Math.max(1, count - 1)))
  }
  longdoc = chapters.length > 0
  const divide = (parts: Paragraph[], level: number): void => {
    if (bytes(parts) <= ceiling) { units.push(parts); return }
    if (level <= 2) {
      const sections: Paragraph[][] = []
      for (const part of parts) {
        if (!sections.length || new RegExp(`^#{${level}}\\s`).test(part.text)) sections.push([])
        sections.at(-1)!.push(part)
      }
      for (const section of sections) divide(section, level + 1)
      return
    }
    for (const part of parts) {
      if (bytes([part]) <= ceiling) { units.push([part]); continue }
      // 原始段落本身超限才拆文本；片段保留原段身份，行号按换行偏移。
      const characters = Array.from(part.text)
      let offset = 0
      while (offset < characters.length) {
        const block = part.locator.startsWith('block:')
        const start = block ? 0 : locatorRange(part.locator)[0] + (characters.slice(0, offset).join('').match(/\n/g) ?? []).length
        const fragment = (count: number) => {
          const text = characters.slice(offset, offset + count).join('')
          return { ...part, text, locator: block ? part.locator : `L${start}-L${start + (text.match(/\n/g) ?? []).length}` }
        }
        // 协议占满软目标时使用既有硬上限，避免把少量正文切成几十次请求。
        const overhead = bytes([fragment(0)])
        const fragmentTarget = target - overhead < (ceiling - overhead) / 2 ? ceiling : target
        let lower = 1, upper = characters.length - offset, accepted = 0
        while (lower <= upper) {
          const middle = Math.floor((lower + upper) / 2)
          if (bytes([fragment(middle)]) <= fragmentTarget) { accepted = middle; lower = middle + 1 } else upper = middle - 1
        }
        if (!accepted) throw new Error('模型上下文不足以容纳一个正文字符。')
        units.push([fragment(accepted)]); offset += accepted
      }
    }
  }
  // 合并归属可以跨越保留的子章；输入仍按原段顺序排列，避免改变定位与恢复计划。
  const owners = new Map(chapters.flatMap(chapter => chapter.paragraph_ids.map(id => [id, chapter.id] as const)))
  const partitions: Paragraph[][] = []
  for (const part of all) {
    if (!partitions.length || owners.get(part.paragraph_id) !== owners.get(partitions.at(-1)!.at(-1)!.paragraph_id)) partitions.push([])
    partitions.at(-1)!.push(part)
  }
  let prefix: Paragraph[] = []
  for (const partition of partitions) {
    // 无正文的卷名或书名随下一章进入输入，不单独消耗一次提取。
    if (partition.length === 1 && /^#{1,6}\s|\n[=-]+\s*$/.test(partition[0]!.text)) { prefix.push(...partition); continue }
    divide([...prefix, ...partition], 1); prefix = []
  }
  if (prefix.length) divide(prefix, 1)
  let current: Paragraph[] = []
  for (const original of units) {
    let unit = original
    // 超长段切片前的纯标题必须带上正文，不能为标题单独调用模型。
    if (current.length && current.every(part => /^#{1,6}\s|\n[=-]+\s*$/.test(part.text))
      && bytes([...current, ...unit]) > ceiling && !/^#{1,6}\s|\n[=-]+\s*$/.test(unit[0]!.text)) {
      const first = unit[0]!, characters = Array.from(first.text)
      let lower = 1, upper = characters.length, accepted = 0
      while (lower <= upper) {
        const middle = Math.floor((lower + upper) / 2)
        if (bytes([...current, { ...first, text: characters.slice(0, middle).join('') }]) <= inputLimit) { accepted = middle; lower = middle + 1 } else upper = middle - 1
      }
      if (accepted) {
        const text = characters.slice(0, accepted).join(''), remaining = characters.slice(accepted).join('')
        const start = first.locator.startsWith('block:') ? 0 : locatorRange(first.locator)[0], line = start + (text.match(/\n/g) ?? []).length
        chunks.push([...current, { ...first, text, locator: start ? `L${start}-L${line}` : first.locator }]); current = []
        unit = [...(remaining ? [{ ...first, text: remaining, locator: start ? `L${line}-L${line + (remaining.match(/\n/g) ?? []).length}` : first.locator }] : []), ...unit.slice(1)]
      }
    }
    if (current.length && bytes([...current, ...unit]) > ceiling) { chunks.push(current); current = [] }
    current.push(...unit)
    if (bytes(current) >= target && current.some(part => !/^#{1,6}\s|\n[=-]+\s*$/.test(part.text))) { chunks.push(current); current = [] }
  }
  if (current.length) chunks.push(current)
  for (let index = chunks.length - 2; index >= 0; index--) {
    if (chunks[index]!.every(part => /^#{1,6}\s|\n[=-]+\s*$/.test(part.text)) && bytes([...chunks[index]!, ...chunks[index + 1]!]) <= inputLimit) {
      chunks[index + 1]!.unshift(...chunks[index]!); chunks.splice(index, 1)
    }
  }
  if (activePacking && wholeBytes <= inputLimit * 3) {
    // 贪心分包后的短尾章并入相邻包；在输入允许时把普通论文收束到最多四包。
    for (let index = chunks.length - 1; index > 0; index--) {
      const short = chunks[index]!.reduce((sum, part) => sum + Buffer.byteLength(part.text), 0) < all.reduce((sum, part) => sum + Buffer.byteLength(part.text), 0) / 8
      if ((chunks.length > 4 || short) && bytes([...chunks[index - 1]!, ...chunks[index]!]) <= inputLimit) {
        chunks[index - 1]!.push(...chunks[index]!); chunks.splice(index, 1)
      }
    }
  }
  return chunks
}
export async function extractSource(...args: Parameters<typeof extractSourceOnce>): Promise<Extraction> {
  const receipt = await extractSourceReceipt(...args)
  // 兼容旧调用方的本轮计数视图，不能修改回执中用于封存和哈希的成果。
  return receipt.reused ? { ...receipt.value, calls: [] } : receipt.value
}
export async function extractSourceReceipt(...args: Parameters<typeof extractSourceOnce>): Promise<{ value: Extraction; reused: boolean; acceptedRef?: AcceptedRef }> {
  const [root, sourceId, source, requestedProcessing, options, inputLimit, , resources, , planned, checkpointSuffix = ''] = args
  const processing = extractionProcessing(requestedProcessing)
  const key = JSON.stringify([path.resolve(root), sourceId, source.contentHash, source.sourceVersion, processingFingerprint(processing), inputLimit, resources, planned,
    options.topics, options.vocabulary, options.tagVocabulary, options.defaultCredibility, options.retrySources ?? null, checkpointSuffix])
  const execute = async (signal: AbortSignal) => {
    const receipt = await validatedTask({ ...options, signal }, 'extract', { key, source, protocol: extractionPromptHash(), resources,
      previous: args[6], imagePolicy: options.imagePolicy }, async signal => {
        const limit = Number.isFinite(inputLimit) ? inputLimit : await recoveryBudget('extract', async () => inputLimit,
          Math.min(options.maxInputBytes ?? Infinity, layeredSettings(options.topics || {}, options.tier).extractMaxInputBytes))
        return extractSourceOnce(root, sourceId, source, processing, { ...options, signal }, limit, args[6], resources, args[8], planned, checkpointSuffix)
      },
      value => reusableExtraction(value) && !value.in_progress && !value.gaps?.length, {
        unitId: sourceId + '/extraction', sourceRefs: [{ sourceId, sourceVersion: source.sourceVersion ?? source.contentHash }], operation: 'extract',
        input: businessValue({ source: { text: source.text, contentHash: source.contentHash, sourceVersion: source.sourceVersion ?? source.contentHash,
          metadata: source.metadata, segments: source.segments }, processing, resources: resources ?? [], vocabulary: options.vocabulary ?? null,
          tagVocabulary: options.tagVocabulary ?? [], defaultCredibility: options.defaultCredibility ?? null,
          contentRules: longdocFingerprint(layeredSettings(options.topics || {}, options.tier)), ...(options.retrySources ? { retrySources: options.retrySources } : {}) }),
        prompt: extractionPromptHash(), schema: schemaJSON(wireOutput), validatorVersion: extractionProtocol, semanticVersion: extractionProtocol,
      })
    // 回执保留封存成果的原始调用记录；本轮调用数由编排层单独统计。
    return receipt
  }
  // 非持久化入口仍共用在途任务；磁盘入口由完整回执身份合并，避免重复复制整篇成果。
  return path.isAbsolute(options.knowledgeRoot) ? execute(options.signal ?? new AbortController().signal) : shareExtraction(key, options.signal, execute)
}
async function extractSourceOnce(root: string, sourceId: string, source: LocalSource, processing: Processing, options: BuildLayeredOptions, inputLimit: number,
  savedPrevious?: Extraction, resources: string[][] = [], images?: (indices: number[]) => Promise<Parameters<BuildLayeredOptions['client']['call']>[4]>, planned?: Paragraph[][], checkpointSuffix = ''): Promise<Extraction> {
  const previous = reusableExtraction(savedPrevious) ? savedPrevious : undefined
  if (previous) await verifyAcceptedRefs(previous, true)
  const settings = layeredSettings(options.topics === false ? {} : options.topics, options.tier)
  const vocabulary = options.vocabulary ?? { tags: options.tagVocabulary ?? [], terms: [] }
  const whole = paragraphs(source)
  // 定向补缺冻结旧计划；输入预算只约束本次摘要，不得因此重分已接受的组。
  const reusablePlan = reusableExtractionPlan(previous, sourceId, source, processing, options, options.retrySources ? Infinity : inputLimit, settings, vocabulary)
  const plan = planned ?? reusablePlan ?? planExtraction(sourceId, source, processing, inputLimit, settings, vocabulary)
  const retainedPlan = reusablePlan !== undefined && JSON.stringify(plan) === JSON.stringify(reusablePlan)
  const book = retainedPlan ? previous!.plan_book! : sourceChapters(source).length > 0 && Buffer.byteLength(system + extractionInput(sourceId, source, processing, whole, processing.tier)) > inputLimit
  const wholeChars = whole.reduce((sum, part) => sum + Array.from(part.text).length, 0)
  const hardLimit = book && processing.granularity !== 'custom' ? undefined : packPointLimit(wholeChars, processing.tier, processing.granularity)
  const grouping = groupingFingerprint(plan, settings)
  const groupIdentity = (hashes: string[]) => JSON.stringify([...new Set(hashes)].sort())
  const gapKey = (gap: ExtractionGap) => {
    const key = object(gap.item)?.chunk_key
    return typeof key === 'string' ? key : groupIdentity(gap.segment_hashes)
  }
  const retryableGroups = new Set(previous?.gaps?.filter(retryableExtractionGap).map(gap => groupIdentity(gap.segment_hashes)))
  // 自动补传输缺口时，同篇内已经确认的内容失败仍保留；显式重试沿用原入口。
  const settledGroups = new Map(!options.retryGaps && previous?.source_hash === source.contentHash && previous.grouping_fingerprint === grouping
    && sameProcessing(previous.processing, processing) && previous.segments.every((segment, index) => JSON.stringify(segment.resource_hashes) === JSON.stringify(resources[index] ?? []))
    ? previous.gaps?.filter(gap => gap.kind === 'group' && !retryableExtractionGap(gap)).map(gap => [gapKey(gap), gap] as const) : [])
  const longdoc = retainedPlan ? previous!.plan_longdoc! : book && isLongdoc(plan), prompt = longdoc ? longdocSystem : system
  const input = (parts: Paragraph[], quota: number) => extractionInput(sourceId, source, processing, parts, quota, longdoc ? settings.sourceSummaryMaxPoints : undefined, allocation.chapters, vocabulary)
  const progressPath = (grouping: string) => 'work/extractions/' + sourceId + '/' + hashName(source.contentHash) + '/extract/' + hashName(extractionFingerprint(source, processing, resources, grouping))
    + (source.sourceVersion ? '-' + hashName(hash(source.sourceVersion)) : '') + checkpointSuffix + '-progress.json'
  const finish = (result: Extraction) => {
    delete (result as Extraction & { reextractGeneration?: number }).reextractGeneration
    delete result.in_progress; delete result.completed_chunks; delete result.chunk_results; delete result.chunk_calls
    delete result.chunk_quotas; delete result.pending_chunk_plan; delete result.summary_pending
    result.models = mergeModels(result.models)
    if (result.models[0]) {
      result.actual_model = `${result.models[0].provider}/${result.models[0].model}`
      // 保留旧读者使用的展示字段；模型从处理身份中排除，完整产出路由见 models。
      result.processing.model = result.actual_model
    }
    // 对象键的插入时间来自并发完成顺序，封存时统一排序；数组仍保持原文章节顺序。
    for (const field of ['correction_attempts', 'group_cache', 'group_summaries', 'summary_nodes', 'chunk_splits'] as const) {
      if (result[field]) Object.assign(result, { [field]: Object.fromEntries(Object.entries(result[field]!).sort(([a], [b]) => a.localeCompare(b))) })
    }
    // 同组多批纠正可能同时拒收；派生组缓存中的缺口也必须与主成果采用同一稳定顺序。
    for (const group of Object.values(result.group_cache ?? {})) group.gaps?.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    return result
  }
  const retrySummary = async (result: Extraction, key: string, ids: string[], call: (prompt: string, request: string, schema: z.ZodType) => Promise<{ raw: string; models: ModelRef[] }>) => {
    const schema = z.object({ point_ids: z.array(z.string()).min(1).max(settings.sourceSummaryMaxPoints) })
    const prompt = jsonProtocol('从本组已校验要点选择摘要。只返回输入中的 point_ids，不修改要点或证据，数量不超过 point_limit。', schemaJSON(schema))
    const members = new Map(result.segments.flatMap(segment => segment.points).filter(point => ids.includes(point.point_id)).map(point => [point.point_id, point]))
    const request = JSON.stringify({ source_id: sourceId, summary_id: key, point_limit: settings.sourceSummaryMaxPoints,
      children: [{ id: key, points: [...members.values()].map(point => ({ point_id: point.point_id, text: point.text })) }] })
    const valid = (selected: string[]) => selected.length > 0 && selected.length <= settings.sourceSummaryMaxPoints
      && new Set(selected).size === selected.length && selected.every(id => members.has(id))
    const receipt = await recoveryTask(options, 'extract', { request, prompt }, async () => {
      if (Buffer.byteLength(prompt + request) > inputLimit) throw Object.assign(new Error('完整组摘要输入超过预算，保留已校验要点。'),
        recoveryContext() || options.retrySources ? { stagePause: true, stage: 'extract', code: 'NO_COMPATIBLE_CANDIDATE' } : {})
      const response = await call(prompt, request, schema)
      try {
        const selected = schema.parse(parseModelJson(response.raw, schemaJSON(schema))).point_ids
        if (!valid(selected)) throw new Error('组摘要引用了未校验要点。')
        return { ids: selected, models: response.models }
      } catch (error) { await rejectAcceptedResponse(response.raw); throw error }
    }, value => valid(value.ids), {
      unitId: sourceId + '/group-summary/' + key, sourceRefs: [{ sourceId, sourceVersion: source.sourceVersion ?? source.contentHash }],
      operation: 'sourceSummary', input: { request }, prompt, schema: schemaJSON(schema), validatorVersion: 'source-summary-v1', semanticVersion: 'source-summary-v1',
      dependencies: activeAcceptedRefs([(result.group_cache?.[key] as { acceptedRef?: AcceptedRef } | undefined)?.acceptedRef]
        .filter((ref): ref is AcceptedRef => Boolean(ref))),
    })
    return { ...receipt.value, ...(receipt.acceptedRef ? { acceptedRef: receipt.acceptedRef } : {}) }
  }
  // 摘要独立补缺：已封存的点、术语、核对结论和 raw 都保留，失败也不重新提取。
  if (previous && (!previous.in_progress || previous.summary_pending) && previous.source_hash === source.contentHash && retainedPlan
    && previous.grouping_fingerprint === grouping && sameProcessing(previous.processing, processing) && !previous.gaps?.some(gap => gap.kind === 'group')
    && previous.segments.every((segment, index) => JSON.stringify(segment.resource_hashes) === JSON.stringify(resources[index] ?? []))
    && Object.values(previous.group_cache ?? {}).some(group => group.missing_summary)) {
    const result = structuredClone(previous)
    let summariesChanged = false
    result.in_progress = true
    result.summary_pending = Object.keys(result.group_summaries ?? {})
    for (const [key, group] of Object.entries(result.group_cache ?? {})) {
      if (!group.missing_summary) continue
      const raw = outputSchema.parse(parseModelJson(group.raw, schemaJSON(outputSchema)))
      const members = result.segments.flatMap(segment => segment.points).filter(point => raw.points.some(item =>
        item.text === point.text && item.evidence.every(evidence => point.evidence.some(saved => saved.quote === evidence.quote && saved.locator === evidence.locator))))
      if (options.retrySources && excludeEmptySourceSummary(result, key, raw.points)) {
        await writeJson(root, progressPath(grouping), result)
        continue
      }
      try {
        const selected = await retrySummary(result, key, members.map(point => point.point_id), async (prompt, request, schema) => {
          const usage = modelUsage(options.client)
          const raw = await usage.client.call('ingest', prompt, request, options.signal, [], { operation: 'extract', structuredSchemaKind: 'extraction', structuredSchema: { name: 'layered_group_summary', schema: schemaJSON(schema) } })
          const record = { input_bytes: Buffer.byteLength(prompt + request), input_limit: inputLimit }
          result.calls.push(record); (result.summary_calls ??= []).push(record)
          return { raw, models: mergeModels(usage.models) }
        })
        group.missing_summary = false
        summariesChanged = true
        group.summary_models = selected.models
        result.group_summaries![key] = { id: key, point_ids: selected.ids, models: selected.models, missing: [], level: 0, children: [], fingerprint: hash(JSON.stringify([key, selected.ids])),
          ...(selected.acceptedRef ? { acceptedRef: selected.acceptedRef } : {}) }
        result.gaps = result.gaps?.filter(gap => gap.kind !== 'summary' || !gap.segment_hashes.length || !gap.segment_hashes.every(hash => group.parts.some(part => part.text_hash === hash))) ?? []
      } catch (error) { if (globalFailure(error, options.signal ?? new AbortController().signal)) throw error }
      await writeJson(root, progressPath(grouping), result)
    }
    if (!options.retrySources || summariesChanged) await synthesizeSourceSummary(result, Object.keys(result.group_summaries ?? {}), options, settings, inputLimit,
      () => writeJson(root, progressPath(grouping), result), globalFailure)
    return finish(result)
  }
  if (previous?.in_progress && previous.summary_pending && !previous.gaps?.some(gap => gap.segment_hashes.length && (gap.kind === 'group' || gap.kind === 'summary'))
    && previous.source_hash === source.contentHash && previous.grouping_fingerprint === grouping && retainedPlan && sameProcessing(previous.processing, processing)) {
    const result = structuredClone(previous)
    result.processing = { ...processing }
    await synthesizeSourceSummary(result, result.summary_pending!, options, settings, inputLimit,
      () => writeJson(root, progressPath(result.grouping_fingerprint!), result), globalFailure)
    return finish(result)
  }
  if (options.retrySources) throw new Error('来源摘要补缺无法复用已发布计划或成果，已停止，未重新提取。')
  const headings: { start: number; end: number; text: string }[] = []
  const sourceLines = source.text.split(/\r?\n/)
  const visit = (node: Nodes): void => {
    if (node.type === 'heading' && node.position) headings.push({ start: node.position.start.line, end: node.position.end.line,
      text: source.text.slice(node.position.start.offset!, node.position.end.offset!) })
    if ('children' in node) node.children.forEach(visit)
  }
  visit(fromMarkdown(source.text))
  // 允许包含具体陈述的标题；名词性章节标题不能作为事实证据。
  const factualHeading = (value: string) => {
    const text = value.replace(/^#{1,6}\s+|\s*#+\s*$|[*_]/g, '').trim()
    // 疑问词与问号先判定，避免把“为什么”的“为”误当作谓语。
    if (/[?？]|什么|为何|为什么|如何|是否|怎样|哪(?:个|些|种)|\b(?:what|why|how|when|where|whether)\b/i.test(text)) return false
    return /\S.*?(?:是|为|指(?:的是)?|意味着|达到|增加|降低|提高|导致|包括|需要|必须|具有|属于|等于|定义为)\s*\S|\S\s+(?:is|are|was|were|has|have|means|refers to|increased|decreased|requires|includes)\s+\S/i.test(text)
  }
  // 独占一行的粗体也是常见标题样式；正文段落仍只接受逐字引文。
  sourceLines.forEach((text, index) => {
    if (/^\s*(?:\*\*[^*]+\*\*|__[^_]+__)\s*$/.test(text)) headings.push({ start: index + 1, end: index + 1, text })
  })
  const allocate = (quality: typeof settings) => {
    const value = sourceQuotas(source, plan, processing.tier, quality, hardLimit)
    if (retainedPlan) {
      value.quotas = [...previous!.plan_quotas!]
      value.chapters = structuredClone(previous!.chapters!)
    }
    return value
  }
  const allocation = allocate(settings)
  // 章节分配与最终篇级硬上限使用同一个限额。
  const selectLimit = hardLimit === undefined ? allocation.limit : Math.max(allocation.limit, ordinaryPointLimit(wholeChars, processing.tier, processing.granularity, settings))
  const chunks: Paragraph[][] = []
  // 重复段落无法唯一对齐时整篇重提，避免把同哈希的不同位置误认成同一段。
  const unique = (values: string[]) => new Set(values).size === values.length
  const partial = previous?.in_progress === true && !previous.summary_pending && previous.source_hash === source.contentHash && previous.grouping_fingerprint === grouping && retainedPlan && sameProcessing(previous.processing, processing)
  const completedChunks = new Set(partial ? previous.completed_chunks ?? [] : [])
  const reusable = plan.length <= 1 && previous && !partial && (previous.source_hash !== source.contentHash || previous.grouping_fingerprint === grouping) && sameProcessing(previous.processing, processing)
    && unique(previous.segments.map(segment => segment.text_hash)) && unique(source.segments.map(segment => segment.text_hash))
  const reused = new Map<number, Extraction['segments'][number]>()
  if (reusable) for (const [index, segment] of source.segments.entries()) {
    if (previous.gaps?.some(gap => (gap.kind === 'group' || gap.kind === 'summary') && gap.segment_hashes.includes(segment.text_hash))) continue
    const old = previous.segments.find(item => item.text_hash === segment.text_hash && item.processing_fingerprint === processingFingerprint(processing, resources[index]))
    if (!old) continue
    const value = structuredClone(old), block = segment.locator.startsWith('block:')
    const delta = block ? 0 : locatorRange(segment.locator)[0] - locatorRange(old.locator)[0]
    const locate = (locator: string) => { if (block) return segment.locator; const [start, end] = locatorRange(locator); return `L${start + delta}-L${end + delta}` }
    Object.assign(value, segment)
    let evidenceReusable = true
    for (const point of value.points) {
      point.source_version = source.sourceVersion ?? source.contentHash
      for (const evidence of point.evidence) {
        const owners = previous.segments.filter(part => {
          if (part.locator.startsWith('block:')) return part.locator === evidence.locator
          const [first, last] = locatorRange(part.locator), [start, end] = locatorRange(evidence.locator)
          return start >= first && end <= last
        })
        const before = owners.length === 1 ? owners[0] : undefined
        const nextId = before ? source.segments.findIndex(part => part.text_hash === before.text_hash) : -1
        const after = source.segments[nextId]
        if (!before || !after || !matchQuotation(source.text.slice(after.start, after.end), evidence.quote)) { evidenceReusable = false; break }
        if (after.locator.startsWith('block:')) evidence.locator = after.locator
        else {
          const delta = locatorRange(after.locator)[0] - locatorRange(before.locator)[0], [start, end] = locatorRange(evidence.locator)
          evidence.locator = 'L' + (start + delta) + '-L' + (end + delta)
        }
        if ('paragraph_id' in evidence) evidence.paragraph_id = nextId
        evidence.source_version = source.sourceVersion ?? source.contentHash
      }
      point.locator = point.evidence[0]!.locator
    }
    if (!evidenceReusable) continue
    for (const term of value.terms) term.locator = locate(term.locator)
    reused.set(index, value)
  }
  for (const parts of plan) {
    const remaining = parts.filter(part => !reused.has(part.paragraph_id))
    if (remaining.length) chunks.push(remaining)
  }
  if (partial && previous.pending_chunk_plan) chunks.splice(0, chunks.length, ...previous.pending_chunk_plan)
  const identities = chunks.map((parts, index) => {
    const chapter = allocation.chapters.find(chapter => chapter.id === allocation.groups[index])
    // 随首章携带的书名、卷名不参与该章缓存身份。
    const owned = chapter ? parts.filter(part => chapter.paragraph_ids.includes(part.paragraph_id)) : parts
    return (allocation.groups[index] ?? 'body') + '/' + hashName(hash(JSON.stringify(owned.map(part => [part.text_hash, hash(part.text), resources[part.paragraph_id] ?? []]))))
  })
  const keyFor = (parts: Paragraph[]) => {
    const index = chunks.indexOf(parts)
    const identity = identities[index]!
    return identity + '-' + identities.slice(0, index).filter(value => value === identity).length
  }
  const pendingChunks = chunks.filter(parts => !completedChunks.has(keyFor(parts)))
  const result: Extraction = { format_version: 1, tag_version: 1, tags: [], source_id: sourceId, source_hash: source.contentHash, processing: { ...processing }, metadata: { ...source.metadata }, calls: partial ? structuredClone(previous?.calls ?? []) : [],
    ...Object.fromEntries(['summary_plans', 'summary_blocks'].flatMap(field => {
      const value = (previous as unknown as Record<string, unknown> | undefined)?.[field]
      return value && sameProcessing(previous?.processing, processing) ? [[field, structuredClone(value)]] : []
    })),
    models: mergeModels(partial || reused.size ? previous?.models : undefined,
      ...[...reused.values()].flatMap(segment => [...segment.points.map(point => point.models), ...segment.terms.map(term => term.models)])),
    correction_attempts: sameProcessing(previous?.processing, processing) && previous?.source_hash === source.contentHash && previous.grouping_fingerprint === grouping ? structuredClone(previous.correction_attempts ?? {}) : {},
    correction_batches: sameProcessing(previous?.processing, processing) && previous?.source_hash === source.contentHash ? { ...previous.correction_batches,
      structure: previous.correction_batches?.structure ?? Object.values(previous.chunk_results ?? {}).reduce((sum, chunk) => sum + (chunk.correction_batches ?? 0), 0) } : {},
    gaps: partial ? structuredClone(previous?.gaps ?? []) : (previous?.gaps ?? []).filter(gap => gap.segment_hashes.length && gap.segment_hashes.every(value => [...reused.values()].some(segment => segment.text_hash === value))),
    segments: source.segments.map((segment, index) => reused.get(index) ?? ({ ...segment, resource_hashes: resources[index] ?? [], processing_fingerprint: processingFingerprint(processing, resources[index]),
      points: partial ? structuredClone(previous?.segments[index]?.points ?? []) : [], terms: partial ? structuredClone(previous?.segments[index]?.terms ?? []) : [] })),
    grouping_fingerprint: grouping, chunk_calls: structuredClone(partial ? previous.chunk_calls ?? {} : {}), truncations: structuredClone(partial ? previous.truncations ?? [] : []),
    point_limit: selectLimit, chapters: allocation.chapters,
    plan_config_fingerprint: extractionPlanConfigFingerprint(options, settings), plan_book: book, plan_longdoc: longdoc,
    ...(hardLimit === undefined ? {} : { plan_hard_limit: hardLimit }), plan_quotas: [...allocation.quotas],
    group_cache: sameProcessing(previous?.processing, processing) ? structuredClone(previous?.group_cache ?? {}) : {},
    group_summaries: partial ? structuredClone(previous.group_summaries ?? {}) : {},
    summary_nodes: sameProcessing(previous?.processing, processing) ? structuredClone(previous?.summary_nodes ?? {}) : {},
    summary_calls: partial ? structuredClone(previous.summary_calls ?? []) : [],
    chunk_plan: plan, pending_chunk_plan: chunks,
    chunk_splits: structuredClone(sameProcessing(previous?.processing, processing) ? previous?.chunk_splits ?? {} : {}),
    ...(previous?.actual_model && (partial || reused.size) ? { actual_model: previous.actual_model } : {}),
    ...(partial ? { in_progress: true, completed_chunks: [...completedChunks], chunk_results: structuredClone(previous.chunk_results ?? {}) } : {}) }
  const ranks = ['unknown', 'low', 'medium', 'high']
  const cachedPoints = result.segments.reduce((sum, segment) => sum + segment.points.length, 0)
  const paragraphChapters = new Map(allocation.chapters.flatMap(chapter => chapter.paragraph_ids.map(id => [id, chapter.id] as const)))
  const evidenceChapters = new WeakMap<Point, Set<string>>()
  const pointsInChapter = (chapter: SourceChapter) => result.segments.flatMap(segment => segment.points).filter(point => {
    let chapters = evidenceChapters.get(point)
    if (!chapters) {
      // 覆盖来自可定位的本章原文；跨章联合证据可同时覆盖各章，主段号不作证据。
      chapters = new Set(point.evidence.flatMap(evidence => {
        const owner = evidenceParagraph(whole, evidence), id = owner && paragraphChapters.get(owner.paragraph_id)
        return id ? [id] : []
      }))
      evidenceChapters.set(point, chapters)
    }
    return chapters.has(chapter.id)
  })
  const reservedQuota = Object.values(result.chunk_results ?? {}).reduce((sum, value) => sum + value.quota, 0)
  const available = Math.max(0, allocation.limit - (partial ? reservedQuota : cachedPoints))
  const fresh = pendingChunks.filter(parts => !result.chunk_results?.[keyFor(parts)])
  if (longdoc && previous?.point_limit === allocation.limit && !partial) {
    // 总额不变时先保留未变化组的配额；删除或新增章节只分配余量。章节重排因此零重提。
    const retained = fresh.map(parts => { const saved = result.group_cache![keyFor(parts)]; return saved?.selected_quota ?? saved?.quota ?? 0 })
    const reserved = retained.reduce((sum, quota) => sum + quota, 0)
    if (reserved <= available) {
      const targets = fresh.map((_, index) => retained[index] ? 0 : index + 1).filter(Boolean).map(index => index - 1)
      const recipients = targets.length ? targets : fresh.map((_, index) => index)
      const extra = allocatePointQuotas(recipients.map(index => fresh[index]!.reduce((sum, part) => sum + Array.from(part.text).length, 0)), available - reserved)
      recipients.forEach((index, offset) => { retained[index]! += extra[offset]! })
      fresh.forEach((parts, index) => { allocation.quotas[chunks.indexOf(parts)] = retained[index]! })
      if (!allocation.groups.some(group => group.includes('+'))) for (const chapter of allocation.chapters) chapter.quota = allocation.quotas.reduce((sum, quota, index) => sum + (allocation.groups[index] === chapter.id ? quota : 0), 0)
    }
  }
  result.plan_quotas = [...allocation.quotas]
  const quotas = reused.size ? allocatePointQuotas(fresh.map(parts => parts.reduce((sum, part) => sum + Buffer.byteLength(part.text), 0)), available)
    : fresh.map(parts => allocation.quotas[chunks.indexOf(parts)]!)
  result.chunk_quotas = partial && previous.chunk_quotas ? { ...previous.chunk_quotas } : Object.fromEntries(fresh.map((parts, index) => [keyFor(parts), quotas[index]!]))
  const refresh = () => {
    const keys = (key: string): string[] => [key, ...(result.chunk_splits?.[key] ?? []).flatMap(keys)]
    const ordered = chunks.flatMap(parts => keys(keyFor(parts)))
    result.calls = [...ordered.flatMap(key => result.chunk_calls?.[key] ?? []), ...(result.summary_calls ?? [])]
    const outputs = ordered.flatMap(key => {
      const raw = result.chunk_results?.[key]?.raw
      return raw ? [groupSchema.parse(parseModelJson(raw, schemaJSON(wireOutput)))] : []
    })
    const candidates = [...(reused.size ? previous?.tag_candidates ?? previous?.tags ?? [] : []), ...outputs.flatMap(output => output.tags)]
    result.tag_candidates = [...new Set(candidates.filter(value => !personalTag(value)))]
    result.tags = canonicalTags(result.tag_candidates, options.vocabulary?.terms, options.tagVocabulary, settings.tagVocabularyOnly, settings.tagLimit)
    result.tag_status = tagStatus(result.tags, candidates.filter(personalTag).length + (reused.size ? previous?.tag_status?.personal_information_removed ?? 0 : 0))
    const ranksUsed = outputs.map(output => ranks.indexOf(output.credibility))
    if (reused.size && previous) ranksUsed.push(ranks.indexOf(previous.metadata.credibility))
    if (!ranksUsed.length) return
    result.metadata.credibility = ranks[Math.min(...ranksUsed, ranks.length - 1)] as SourceMetadata['credibility']
    result.metadata.credibility_reason = [...new Set([...(reused.size && previous ? [previous.metadata.credibility_reason] : []), ...outputs.map(output => output.credibility_reason)].filter((value): value is string => Boolean(value?.trim())))].join('；') || '未提供依据'
  }
  const checkpoint = async () => {
    result.in_progress = true; refresh()
    await writeJson(root, progressPath(grouping), { ...result, reextractGeneration: recoveryContext()?.pending.reextractGenerations?.[sourceId]
      ?? (options.taskModelIdentity as { reextractJob?: number } | undefined)?.reextractJob ?? 0 })
  }
  const signal = options.signal ?? new AbortController().signal
  type PointOutput = z.infer<typeof outputSchema>['points'][number]
  type TermOutput = z.infer<typeof outputSchema>['terms'][number]
  type Candidate = { kind: 'point' | 'term'; item: unknown; key: string; index: number }
  type Inspected = { item?: PointOutput | TermOutput; reasons: ExtractionRejection[] }
  type CorrectionEntry = { candidate: Candidate; original: Record<string, unknown>; context: Paragraph[]; fingerprint: string; reasons: ExtractionRejection[] }
  type ChunkState = {
    parts: Paragraph[]; chunkKey: string; order: string; depth: number; quota: number
    cached?: NonNullable<Extraction['chunk_results']>[string] | undefined
    saved?: NonNullable<Extraction['group_cache']>[string] | undefined
    progress?: NonNullable<Extraction['chunk_results']>[string] | undefined
    output?: z.infer<typeof groupSchema> | undefined
    raw?: string | undefined
    normalizedCache?: NonNullable<Extraction['group_cache']>[string] | undefined
    ownGaps: ExtractionGap[]
    failed: CorrectionEntry[]
    batches: CorrectionEntry[][]
    accepted: Map<string, PointOutput | TermOutput>
    split: boolean
    groupFailed: boolean
    children: string[]
    coverageAttempted: Set<string>
    initialCandidates: Candidate[]
    finalized?: boolean
    initialDone?: boolean
    reservationDone?: boolean
    callLog: { seq: number; call: Extraction['calls'][number] }[]
    callSeq: number
    models: ModelRef[]
    initialModels: ModelRef[]
    itemModels: Record<string, ModelRef[]>
    acceptedRef?: AcceptedRef
  }
  type CoverageTask = { state: ChunkState; chapter: SourceChapter; chapterParts: Paragraph[]; floor: number; target: number; coverageKey: string; coverageInput: string; extra?: z.infer<typeof groupSchema>; candidates?: Candidate[]; models?: ModelRef[]; error?: unknown }
  const rejected = (rule: string, expected: string, actual: string): ExtractionRejection => ({ rule, expected, actual: actual.slice(0, 240) })
  const record = async (prompt: string, request: string, rawOutput: string, rejections: unknown[], details?: unknown) => {
    const timestamp = new Date().toISOString()
    await writeJson(root, `logs/failures/${sourceId}/${timestamp.replaceAll(':', '-')}-${randomUUID()}.json`, {
      source_id: sourceId, source_hash: source.contentHash, timestamp,
      request: { hash: hash(prompt + request), length: Buffer.byteLength(prompt + request) }, raw_output: rawOutput, rejections, details,
    })
  }
  const states = new Map<string, ChunkState>()
  const concurrency = options.client.concurrency?.() ?? defaultPolicy().pageGenerationConcurrency
  const callGate = new CallGate(concurrency, 0)
  let dispatchCorrections = () => {}
  const batchCounts = result.correction_batches!
  const contextFor = (state: ChunkState, parts = state.parts) => {
    const request = input(parts, state.quota)
    const find = (paragraphId: number, locator: string, quote?: string): ExtractionRejection[] => {
      const matches = parts.filter(part => part.paragraph_id === paragraphId)
      if (!matches.length) return [rejected('paragraph-id', `输入段 ID：${parts.map(part => part.paragraph_id).join(',')}`, String(paragraphId))]
      if (source.siyuan) {
        if (!/^block:\d{14}-[a-z0-9]{7}$/.test(locator) || !matches.some(part => part.locator === locator)) return [rejected('block-locator', matches.map(part => part.locator).join(','), locator)]
        if (quote && matches.every(part => /^#{1,6}\s/.test(part.text) && !factualHeading(part.text))) return [rejected('heading-only', '含事实内容的原文证据', quote)]
        return quote && !matches.some(part => part.locator === locator && matchQuotation(part.text, quote))
          ? [rejected('verbatim-quote', '引文逐字包含于该块或数据库行', quote)] : []
      }
      let start: number, end: number
      try { [start, end] = locatorRange(locator) }
      catch { return [rejected('locator-format', 'L起始行-L结束行，起始行≤结束行', locator)] }
      const ranges = matches.filter(part => { const [first, last] = locatorRange(part.locator); return start >= first && end <= last })
      if (!ranges.length) return [rejected('paragraph-range', matches.map(part => part.locator).join(','), locator)]
      if (quote && !ranges.some(part => matchQuotation(part.text, quote))) return [rejected('verbatim-quote', '引文逐字包含于输入段落', quote)]
      if (quote && !matchQuotation(sourceLines.slice(start - 1, end).join('\n'), quote)) return [rejected('quote-lines', `引文逐字包含于 ${locator}`, quote)]
      if (quote) {
        const selected = sourceLines.slice(start - 1, end).join('\n'), match = matchQuotation(selected, quote)
        const first = start + (selected.slice(0, match?.start ?? 0).match(/\n/g) ?? []).length
        const last = first + (match?.quote.match(/\n/g) ?? []).length
        const supported = match && !headings.some(heading => first >= heading.start && last <= heading.end && !factualHeading(heading.text))
        if (!supported) return [rejected('heading-only', '含事实内容的原文证据', quote)]
      }
      return []
    }
    const checkPoint = (point: PointOutput) => {
      if (!parts.some(part => part.paragraph_id === point.paragraph_id)) return [rejected('paragraph-id', '输入中的主段 ID', String(point.paragraph_id))]
      return point.evidence.flatMap(evidence => {
        // 段号和行号唯一时直接定位；下面的 find 仍执行原有全部逐字校验。
        let owner = evidenceParagraph(parts, { paragraph_id: evidence.paragraph_id, locator: evidence.locator }) ?? evidenceParagraph(parts, evidence)
        // 错绑到另一段时保留原拒绝原因；真正跨段的引文仍须逐字匹配自己的段落。
        if (owner && owner.paragraph_id !== point.paragraph_id && !matchQuotation(owner.text, evidence.quote)) owner = undefined
        const reasons = owner ? find(owner.paragraph_id, evidence.locator, evidence.quote)
          : find(point.paragraph_id, evidence.locator, evidence.quote)
        if (!owner && !reasons.length) reasons.push(rejected('paragraph-id', '唯一原文段落', '引文归属不唯一'))
        if (!reasons.length) {
          const original = source.siyuan ? owner!.text
            : sourceLines.slice(locatorRange(evidence.locator)[0] - 1, locatorRange(evidence.locator)[1]).join('\n')
          evidence.quote = matchQuotation(original, evidence.quote)!.quote
        }
        return reasons
      })
    }
    const checkTerm = (term: TermOutput) => find(term.paragraph_id, term.locator)
    const dictionary = JSON.parse(request).evidence_dictionary ?? {}
    const inspect = <T extends PointOutput | TermOutput>(kind: 'point' | 'term', value: unknown, check: (value: T) => ExtractionRejection[], schema: z.ZodType<T>): { item?: T; reasons: ExtractionRejection[] } => {
      const normalized = normalizeItem(value, kind)
      let expanded = normalized
      const evidence = object(normalized)?.evidence
      if (kind === 'point' && Array.isArray(evidence) && evidence.some(value => object(value)?.evidence_ref !== undefined)) {
        // 联合 Schema 会剥离多余字段；先拒绝未知编号，不能靠附带合法引文绕过。
        if (evidence.some(value => object(value)?.evidence_ref !== undefined && !Object.hasOwn(dictionary, String(object(value)!.evidence_ref))))
          return { reasons: [rejected('evidence-ref', '本组中属于该段的证据编号', '模型引用了不属于本次请求的证据编号。')] }
        const wire = wirePoint.safeParse(normalized)
        if (!wire.success) return { reasons: schemaReasons(wire.error, normalized) }
        try { expanded = JSON.parse(expandEvidenceReferences(JSON.stringify({ points: [wire.data] }), dictionary)).points[0] }
        catch (error) { return { reasons: [rejected('evidence-ref', '本组中属于该段的证据编号', String(error))] } }
      }
      const parsed = schema.safeParse(expanded)
      return parsed.success ? { item: parsed.data, reasons: check(parsed.data) } : { reasons: schemaReasons(parsed.error, expanded) }
    }
    const inspectCandidate = (candidate: Candidate, value = candidate.item): Inspected => candidate.kind === 'point'
      ? inspect('point', value, checkPoint, outputSchema.shape.points.element)
      : inspect('term', value, checkTerm, outputSchema.shape.terms.element)
    return { request, inspect, inspectCandidate, checkTerm }
  }
  const callFor = (state: ChunkState, parts = state.parts) => async (prompt: string, request: string, schema: z.ZodType = longdoc ? longdocOutput : wireOutput): Promise<{ raw: string; models: ModelRef[] }> => {
    const sequence = state.callSeq++
    // 只在模型边界替换证据编号；缓存继续使用稳定身份，旧检查点无需重提。
    const prepared = extractionRequest(prompt, request, schema)
    prompt = prepared.prompt; request = prepared.request
    const { evidenceIds, evidenceRefs } = prepared
    const attempts: ModelAttempt[] = []
    const usage = modelUsage(options.client)
    let raw = '', cause: unknown, failed = false
    const attachments = await images?.(parts.map(part => part.paragraph_id))
    try { raw = await withAcceptedCall({ unitId: sourceId + '/group/' + state.chunkKey,
      operation: schema === coverageBatchOutput ? 'coverage' : schema === wireOutput || schema === longdocOutput || schema === correctionSchema ? 'extract' : 'sourceSummary',
      dependencyTaskIds: state.acceptedRef ? [state.acceptedRef.taskId] : [] },
      () => callGate.run(() => usage.client.call('ingest', prompt, request, signal, attachments,
        { operation: 'extract', structuredSchemaKind: schema === correctionSchema ? 'correction' : 'extraction', onAttempt: attempt => attempts.push(attempt), structuredSchema: { name: schema === coverageBatchOutput ? 'layered_coverage_batch' : 'layered_extraction', schema: schemaJSON(schema) } }), signal)) }
    catch (error) { failed = true; cause = error }
    state.models = mergeModels(state.models, usage.models)
    result.models = mergeModels(result.models, usage.models)
    if (state.progress) state.progress.models = mergeModels(state.progress.models, usage.models)
    signal.throwIfAborted()
    for (const attempt of attempts.filter(attempt => attempt.error)) await record(prompt, request, attempt.failure?.rawOutput ?? '',
      [rejected('model-call', '模型调用完整结束', attempt.error!)], attempt.failure)
    if (failed) {
      if (!attempts.some(attempt => attempt.error)) await record(prompt, request, cause instanceof ModelCallError ? cause.failure?.rawOutput ?? '' : '',
        [rejected('model-call', '模型调用完整结束', cause instanceof Error ? cause.message : String(cause))], cause instanceof ModelCallError ? cause.failure : undefined)
      if (globalFailure(cause, signal)) throw cause
      throw new ExtractionFailure(cause, lengthFailure(cause), isModelTransportError(cause))
    }
    const call = { input_bytes: Buffer.byteLength(prompt + request), input_limit: inputLimit }
    state.callLog.push({ seq: sequence, call })
    ;(result.chunk_calls![state.chunkKey] ??= []).push(call)
    if (result.models[0]) result.actual_model = `${result.models[0].provider}/${result.models[0].model}`
    if (evidenceIds.length) {
      try {
        const original = raw
        raw = JSON.stringify(parseModelJson(raw, schemaJSON(schema)), (key, value) => key === 'evidence_ref' && typeof value === 'string'
          ? evidenceRefs.has(value) ? evidenceRefs.original(value) : '未知证据短编号：' + value : value)
        aliasAcceptedResponse(original, raw)
      } catch { /* 非法 JSON 保留原文，交由已有组级校验处理。 */ }
    }
    return { raw, models: mergeModels(usage.models) }
  }
  const preservePointFor = (state: ChunkState, point: PointOutput, index: number, models: ModelRef[] = state.initialModels) => {
    const segment = result.segments[point.paragraph_id]!, stableIndex = index
    const number = state.order + '.' + String(stableIndex).padStart(8, '0')
    segment.points.push({ models: mergeModels(models), point_id: `${sourceId}:${segment.text_hash}:${number}`, text_hash: segment.text_hash,
      locator: point.evidence[0]!.locator, source_version: source.sourceVersion ?? source.contentHash, text: point.text, section: point.section,
      evidence: point.evidence.map(evidence => ({ ...evidence, source_id: sourceId, source_version: source.sourceVersion ?? source.contentHash })) })
  }
  const preserveFor = (state: ChunkState, candidate: Candidate, value: PointOutput | TermOutput) => {
    const models = state.itemModels[candidate.key] ?? state.initialModels
    if (candidate.kind === 'point') preservePointFor(state, value as PointOutput, state.saved?.point_indices?.[candidate.index] ?? candidate.index, models)
    else { const { paragraph_id, ...term } = value as TermOutput; result.segments[paragraph_id]!.terms.push({ ...term, models: mergeModels(models) }) }
  }
  const gapFor = (state: ChunkState, entry: CorrectionEntry) => {
    const value: ExtractionGap = { kind: entry.candidate.kind, segment_hashes: entry.context.map(part => part.text_hash), item: entry.candidate.item, reasons: entry.reasons }
    result.gaps!.push(value); state.ownGaps.push(value)
  }
  const correctionId = (entry: CorrectionEntry, index: number) => entry.candidate.key.startsWith('coverage:') ? 'C' + (index + 1) : entry.candidate.key
  const correctionRequestFor = (state: ChunkState, batch: CorrectionEntry[]) => JSON.stringify({ correction_stage: 'structure', source_id: sourceId, items: batch.map((entry, index) => ({ id: correctionId(entry, index),
    validationFeedback: { kind: entry.candidate.kind, item: entry.original, reasons: entry.reasons }, paragraphs: numbered(entry.context) })) })
  const fitsCorrection = (state: ChunkState, batch: CorrectionEntry[]) => Buffer.byteLength(correctionPrompt + correctionRequestFor(state, batch)) <= inputLimit
  // 每项先独立检查，再按原文顺序分配篇级纠正额度；额度确定后不同章节包的纠正可以并发。
  const collectCorrections = (state: ChunkState, candidates: Candidate[], validator = contextFor(state), parts = state.parts): CorrectionEntry[] => {
    const failed: CorrectionEntry[] = []
    for (const candidate of candidates) {
      if (state.progress!.completed_items.includes(candidate.key)) continue
      const normalized = object(normalizeItem(candidate.item, candidate.kind))
      // 已指向有效段落但定位冲突时仍须纠正，不能用自动定位绕过主张不变校验。
      if (normalized && candidate.kind === 'point' && !whole.some(part => part.paragraph_id === normalized.paragraph_id)) candidate.item = repairParagraphs(whole, normalized)
      const initial = validator.inspectCandidate(candidate)
      if (!initial.reasons.length && initial.item) { state.accepted.set(candidate.key, initial.item); continue }
      const original = object(normalizeItem(candidate.item, candidate.kind)) ?? {}
      const local = correctionContext(parts, original)
      const fingerprint = hash(JSON.stringify([sourceId, source.contentHash, state.chunkKey, candidate.kind, original]))
      const entry = { candidate, original, context: local, fingerprint, reasons: initial.reasons }
      if (!local.length || (result.correction_attempts![fingerprint]?.structure ?? 0) >= 1) {
        entry.reasons.push(rejected('correction-limit', '可定位的局部原文且结构纠正尚未使用', local.length ? '已用完一次结构纠正' : '没有唯一引文锚点'))
        gapFor(state, entry); continue
      }
      failed.push(entry)
    }
    return failed
  }
  const runCorrectionBatch = async (state: ChunkState, batch: CorrectionEntry[]) => {
    signal.throwIfAborted()
    batchCounts.structure = (batchCounts.structure ?? 0) + 1
    state.progress!.correction_batches = (state.progress!.correction_batches ?? 0) + 1
    await record(system, input(state.parts, state.quota), state.raw!, batch.map(entry => ({ kind: entry.candidate.kind, item: entry.candidate.item, reasons: entry.reasons })))
    for (const entry of batch) (result.correction_attempts![entry.fingerprint] ??= {}).structure = 1
    await checkpoint()
    const request = correctionRequestFor(state, batch)
    let correctedRaw = ''
    try {
      const response = await callFor(state)(correctionPrompt, request, correctionSchema)
      correctedRaw = response.raw
      const body = z.object({ items: z.array(z.unknown()) }).parse(parseModelJson(correctedRaw, schemaJSON(correctionSchema)))
      for (const [index, entry] of batch.entries()) {
        const matches = body.items.filter(item => object(item)?.id === correctionId(entry, index))
        const patch = matches.length === 1 ? patchSchema.safeParse(matches[0]) : undefined
        if (!patch?.success) { entry.reasons = patch?.error ? schemaReasons(patch.error, matches[0]) : [rejected('correction-schema', '每项返回唯一 id 及合法修订字段', '缺失或重复 id')]; gapFor(state, entry); continue }
        const returned = object(matches[0])!
        if (entry.candidate.kind === 'point' && 'text' in returned && !sameClaim(entry.original.text, returned.text)) {
          entry.reasons = [rejected('correction-claim', '原主张保持不变', '纠正改变主张')]; gapFor(state, entry); continue
        }
        const repaired: Record<string, unknown> = { ...entry.original, ...patch.data }
        const fields = entry.candidate.kind === 'point' ? outputSchema.shape.points.element.shape : outputSchema.shape.terms.element.shape
        for (const [field, fieldSchema] of Object.entries(fields)) {
          if (['paragraph_id', 'locator', 'evidence'].includes(field)) continue
          if (fieldSchema.safeParse(entry.original[field]).success) repaired[field] = entry.original[field]
        }
        // 主张与名称没有可由模型补写的替代值；原值非法时记录缺口。
        for (const field of entry.candidate.kind === 'point' ? ['text'] : ['name', 'referent']) repaired[field] = entry.original[field]
        // 批量仅合并调用；每条仍用自己的原文上下文验收，避免重叠段被误判为多个来源。
        const checked = contextFor(state, entry.context).inspectCandidate(entry.candidate, repaired)
        entry.reasons = checked.reasons
        if (!checked.reasons.length && checked.item) {
          state.itemModels[entry.candidate.key] = mergeModels(state.itemModels[entry.candidate.key] ?? state.initialModels, response.models)
          state.progress!.item_models = state.itemModels
          state.accepted.set(entry.candidate.key, checked.item)
          if (!entry.candidate.key.startsWith('coverage:')) {
            if (entry.candidate.kind === 'point') state.output!.points[entry.candidate.index] = checked.item
            else state.output!.terms[entry.candidate.index] = checked.item
          } else {
            const separator = entry.candidate.key.lastIndexOf(':'), key = entry.candidate.key.slice(0, separator)
            const raw = state.progress!.coverage_outputs?.[key]
            if (raw) {
              const output = groupSchema.parse(parseModelJson(raw, schemaJSON(wireOutput)))
              output.points[Number(entry.candidate.key.slice(separator + 1))] = checked.item
              state.progress!.coverage_outputs![key] = JSON.stringify(output)
            }
          }
        } else gapFor(state, entry)
      }
      state.progress!.raw = JSON.stringify(state.output)
    } catch (error) {
      if (error && typeof error === 'object' && 'budgetPause' in error) {
        // 预算拦截发生在实际请求之前，不消耗该条的纠正机会。
        for (const entry of batch) delete result.correction_attempts![entry.fingerprint]!.structure
        state.progress!.correction_batches = Math.max(0, (state.progress!.correction_batches ?? 1) - 1)
        batchCounts.structure = Math.max(0, (batchCounts.structure ?? 1) - 1)
      }
      if (globalFailure(error, signal)) throw error
      if (!(error instanceof ExtractionFailure) && !(error instanceof SyntaxError) && !(error instanceof z.ZodError)) throw error
      for (const entry of batch) { entry.reasons = [rejected('correction-schema', '逐项返回修订字段', String(error))]; gapFor(state, entry) }
    }
    const rejectedItems = batch.filter(entry => entry.reasons.length).map(entry => ({ kind: entry.candidate.kind, item: entry.candidate.item, reasons: entry.reasons }))
    if (rejectedItems.length) await record(correctionPrompt, request, correctedRaw, rejectedItems)
    // 原始返回与尝试次数一起保存；续做可验收已返回字段，不重复模型调用。
    await checkpoint()
  }
  const createChildren = async (state: ChunkState, existing?: string[]) => {
    const middle = Math.ceil(state.parts.length / 2), halves = [state.parts.slice(0, middle), state.parts.slice(middle)]
    const quotas = allocatePointQuotas(halves.map(half => half.reduce((sum, part) => sum + Buffer.byteLength(part.text), 0)), state.quota)
    const keys = existing ?? halves.map((_, index) => state.chunkKey + '.' + index)
    result.chunk_splits![state.chunkKey] = keys
    state.split = true; state.children = keys
    // 失败兄弟包互不依赖，并发完成；子包身份和配额在启动前已按原顺序固定。
    await mapConcurrent(halves, concurrency, signal, async half => {
      const index = halves.indexOf(half)
      const key = keys[index]!
      result.chunk_quotas![key] ??= quotas[index]!
      await readyInitial(half, signal, key, state.order + '.' + index, state.depth + 1)
    })
  }
  const runInitial = async (parts: Paragraph[], signal: AbortSignal, chunkKey: string, order: string, depth: number): Promise<ChunkState> => {
    const existing = states.get(chunkKey)
    if (existing) return existing
    signal.throwIfAborted()
    const cached = result.chunk_results?.[chunkKey]
    const quota = result.chunk_quotas![chunkKey] ?? cached?.quota ?? 0
    const calls = result.chunk_calls?.[chunkKey] ?? []
    const state: ChunkState = { parts, chunkKey, order, depth, quota, cached, progress: undefined, ownGaps: [], failed: [], batches: [], accepted: new Map(),
      split: false, groupFailed: false, children: [], coverageAttempted: new Set(), initialCandidates: [], callLog: calls.map((call, seq) => ({ seq, call })), callSeq: calls.length,
      models: mergeModels(cached?.models), initialModels: mergeModels(cached?.initial_models), itemModels: structuredClone(cached?.item_models ?? {}) }
    states.set(chunkKey, state)
    const identity = groupIdentity(parts.map(part => part.text_hash))
    // 长段切片可共用段落哈希；旧缺口不能区分切片且其中有传输失败时，重新提取该范围。
    const settled = settledGroups.get(chunkKey) ?? (retryableGroups.has(identity) ? undefined : settledGroups.get(identity))
    if (settled) {
      state.groupFailed = true
      if (!result.gaps!.some(gap => gap.kind === 'group' && gapKey(gap) === gapKey(settled))) result.gaps!.push(structuredClone(settled))
      return state
    }
    if (partial && !cached && !result.chunk_splits?.[chunkKey]) {
      // 失败组不列为完成；续跑前替换该组旧缺口和未完成候选，避免重复发布。
      const hashes = new Set(parts.map(part => part.text_hash))
      result.gaps = result.gaps!.filter(gap => gap.kind === 'group' && typeof object(gap.item)?.chunk_key === 'string'
        ? gapKey(gap) !== chunkKey : !gap.segment_hashes.some(value => hashes.has(value)))
      for (const segment of result.segments) segment.points = segment.points.filter(point => !point.point_id.includes(':' + order + '.'))
    }
    if (result.chunk_splits?.[chunkKey]) { await createChildren(state, result.chunk_splits[chunkKey]); return state }
    if (longdoc && !quota) return state
    try {
      const candidate = result.group_cache![chunkKey]
      const parsedCandidate = candidate && cachedGroup(candidate.raw, true)
      const saved = candidate && parsedCandidate && (!candidate.missing_summary || !candidate.gaps?.some(gap => gap.kind !== 'summary'))
        && Math.max(candidate.quota, parsedCandidate.points.length) >= quota ? candidate : undefined
      state.saved = saved
      const savedRef = activeAcceptedRefs([(cached as { acceptedRef?: AcceptedRef } | undefined)?.acceptedRef
        ?? (saved as { acceptedRef?: AcceptedRef } | undefined)?.acceptedRef].filter((ref): ref is AcceptedRef => Boolean(ref)))[0]
      if (savedRef) state.acceptedRef = savedRef
      if (!cached && saved) {
        state.models = mergeModels(saved.models)
        state.initialModels = mergeModels(saved.summary_models)
        state.itemModels = structuredClone(saved.item_models ?? {})
      }
      if (saved?.gaps && !cached) { result.gaps!.push(...structuredClone(saved.gaps)); state.ownGaps.push(...structuredClone(saved.gaps)) }
      const rebound = () => {
        if (!saved) return undefined
        const output = parseModelJson(saved.raw, schemaJSON(wireOutput))
        for (const item of [...output.points, ...output.terms]) {
          const before = saved.parts.find(part => part.paragraph_id === item.paragraph_id)
          const after = before && parts.find(part => part.text_hash === before.text_hash && part.text === before.text)
          if (!before || !after) continue
          item.paragraph_id = after.paragraph_id
          const locate = (value: string) => {
            if (after.locator.startsWith('block:')) return after.locator
            const delta = locatorRange(after.locator)[0] - locatorRange(before.locator)[0]
            const [start, end] = locatorRange(value); return `L${start + delta}-L${end + delta}`
          }
          if (typeof item.locator === 'string') item.locator = locate(item.locator)
          for (const evidence of item.evidence ?? []) {
            const owner = evidenceParagraph(saved.parts, evidence)
            const next = owner && parts.find(part => part.text_hash === owner.text_hash && part.text === owner.text)
            if (!owner || !next) return undefined
            if (next.locator.startsWith('block:')) evidence.locator = next.locator
            else {
              const delta = locatorRange(next.locator)[0] - locatorRange(owner.locator)[0], [start, end] = locatorRange(evidence.locator)
              evidence.locator = 'L' + (start + delta) + '-L' + (end + delta)
            }
            if (evidence.paragraph_id !== undefined) evidence.paragraph_id = next.paragraph_id
          }
        }
        return JSON.stringify(output)
      }
      const request = input(parts, quota)
      let raw = cached?.raw ?? rebound()
      if (raw === undefined) {
        state.saved = undefined
        state.models = []
        state.initialModels = []
        state.itemModels = {}
        const prepared = extractionRequest(prompt, request, longdoc ? longdocOutput : wireOutput)
        const receipt = await recoveryTask({ ...options, signal }, 'extract', { request, prompt },
          async () => {
            if (recoveryContext() && Buffer.byteLength(prepared.prompt + prepared.request) > inputLimit) {
              if (parts.length > 1) throw new ExtractionFailure(new Error('未完成组需要按新窗口细分。'), true)
              throw Object.assign(new Error('单个完整提取成员超过新窗口，已保留成功组和原始证据。'), { stagePause: true, stage: 'extract', code: 'NO_COMPATIBLE_CANDIDATE' })
            }
            return callFor(state)(prompt, request)
          }, value => {
            const output = cachedGroup(value.raw, true)
            if (!output) return false
            const validator = contextFor(state)
            return [...output.points.map((item, index) => ({ kind: 'point' as const, item, index, key: 'point:' + index })),
              ...output.terms.map((item, index) => ({ kind: 'term' as const, item, index, key: 'term:' + index }))]
              .every(candidate => !validator.inspectCandidate(candidate).reasons.length)
          }, { unitId: sourceId + '/group/' + chunkKey, sourceRefs: [{ sourceId, sourceVersion: source.sourceVersion ?? source.contentHash }], operation: 'extract',
            input: businessValue({ request, resources: parts.map(part => resources[part.paragraph_id] ?? []) }), prompt,
            schema: schemaJSON(longdoc ? longdocOutput : wireOutput), validatorVersion: extractionProtocol, semanticVersion: extractionProtocol,
            groupPlan: { members: parts, quota } })
        const response = receipt.value
        if (receipt.acceptedRef) state.acceptedRef = receipt.acceptedRef
        raw = response.raw
        state.initialModels = response.models
        state.models = mergeModels(state.models, response.models)
      }
      result.models = mergeModels(result.models, state.models)
      state.raw = raw
      let output: z.infer<typeof groupSchema>
      try {
        output = groupSchema.parse(parseModelJson(raw, schemaJSON(wireOutput)))
      } catch (error) {
        await rejectAcceptedResponse(raw)
        await record(system, request, raw, [rejected('output-schema', '合法 JSON 与提取结构', String(error))])
        throw new ExtractionFailure(error, true)
      }
      const progress = (result.chunk_results ??= {})[chunkKey] ??= { raw, quota, completed_items: [], correction_batches: 0 }
      state.progress = progress; state.output = output
      if (state.acceptedRef) Object.assign(progress, { acceptedRef: state.acceptedRef })
      progress.models = mergeModels(progress.models, state.models)
      progress.initial_models = mergeModels(state.initialModels)
      progress.item_models = state.itemModels
      // 单包也先校验完整候选，再统一去重、按篇级优先级选点并留痕。
      // 不能在这里抢先裁剪，否则重复项会占掉关键事实的名额。
      const validator = contextFor(state)
      const initialCandidates: Candidate[] = [
        ...output.points.map((item, index) => ({ kind: 'point' as const, item, key: 'point:' + index, index })),
        ...output.terms.map((item, index) => ({ kind: 'term' as const, item, key: 'term:' + index, index })),
      ]
      state.initialCandidates = initialCandidates
      // 先封存有效条目，再批量修复失败项；有效项从不回交模型。
      for (const candidate of initialCandidates) {
        if (progress.completed_items.includes(candidate.key)) continue
        const checked = validator.inspectCandidate(candidate)
        if (!checked.reasons.length && checked.item) { preserveFor(state, candidate, checked.item); progress.completed_items.push(candidate.key) }
      }
      state.failed = collectCorrections(state, initialCandidates, validator)
      // 无纠正依赖的组立即封存，后续组取消时仍能复用成功原文与摘要。
      if (!state.failed.length) await finalizeState(state)
      await checkpoint()
    } catch (error) {
      if (!(error instanceof ExtractionFailure) || globalFailure(error.reason, signal)) throw error instanceof ExtractionFailure ? error.reason : error
      // 只沿段落边界对半缩小；叶段失败记缺口，兄弟组与其他来源继续。
      if (error.shrink && parts.length > 1 && depth < settings.extractMaxSplitDepth) await createChildren(state)
      else {
        state.groupFailed = true
        result.gaps!.push({ kind: 'group', retryable: error.retryable, segment_hashes: [...new Set(parts.map(part => part.text_hash))],
          item: { chunk_key: chunkKey, paragraphs: parts.map(part => ({ paragraph_id: part.paragraph_id, locator: part.locator })), depth },
          reasons: [rejected('extract-group', '该组完成提取', error.message)] })
      }
    }
    return state
  }
  const readyInitial = async (...args: Parameters<typeof runInitial>) => {
    const state = await runInitial(...args)
    state.initialDone = true
    dispatchCorrections()
    return state
  }
  const complete = async (state: ChunkState) => {
    const succeeded = !state.groupFailed && (state.quota === 0 || state.normalizedCache && !state.normalizedCache.missing_summary
      || result.chunk_splits?.[state.chunkKey]?.every(key => result.completed_chunks?.includes(key)))
    if (succeeded) result.completed_chunks = [...new Set([...(result.completed_chunks ?? []), state.chunkKey])]
    const raw = state.progress?.raw
    if (raw && state.normalizedCache) result.group_cache![state.chunkKey] = state.normalizedCache
    if (!succeeded && result.chunk_results) delete result.chunk_results[state.chunkKey]
    result.chunk_calls![state.chunkKey] = [...state.callLog].sort((a, b) => a.seq - b.seq).map(item => item.call)
    if (chunks.length > 1 || !chunks.every(parts => result.completed_chunks?.includes(keyFor(parts)))) await checkpoint()
  }
  const finalizeState = async (state: ChunkState): Promise<void> => {
    if (state.finalized) return
    if (state.split) {
      for (const key of state.children) { const child = states.get(key); if (child) await finalizeState(child) }
      await complete(state); return
    }
    const output = state.output, progress = state.progress, parts = state.parts, chunkKey = state.chunkKey, order = state.order, saved = state.saved, quota = state.quota
    if (output && progress && !state.groupFailed) {
      const accepted = new Map(result.segments.flatMap(segment => segment.points).filter(point => point.point_id.includes(':' + order + '.'))
        .sort((a, b) => Number(a.point_id.split('.').at(-1)) - Number(b.point_id.split('.').at(-1)))
        .map(point => [Number(point.point_id.split('.').at(-1)), point.point_id]))
      const selectedIndices = output.summary_point_indices?.map(index => saved?.point_indices?.[index] ?? index) ?? [...accepted.keys()].slice(0, settings.sourceSummaryMaxPoints)
      const savedSummary = saved && !saved.missing_summary ? previous?.group_summaries?.[chunkKey] : undefined
      let requested = savedSummary && !savedSummary.missing.length && savedSummary.point_ids.every(id => [...accepted.values()].includes(id))
        ? savedSummary.point_ids.map(id => [...accepted].find(([, value]) => value === id)![0])
        : saved ? selectedIndices.filter(index => accepted.has(index)) : selectedIndices
      let invalid = Boolean(saved?.missing_summary) || requested.length > settings.sourceSummaryMaxPoints || requested.some(index => !accepted.has(index))
      let summaryRef = state.acceptedRef
      if (saved?.missing_summary && accepted.size) {
        try {
          const selected = await retrySummary(result, chunkKey, [...accepted.values()], callFor(state))
          requested = selected.ids.map(id => [...accepted].find(([, pointId]) => pointId === id)![0])
          summaryRef = selected.acceptedRef ?? summaryRef
          state.initialModels = mergeModels(selected.models); invalid = false
        } catch (error) { if (globalFailure(error, signal)) throw error }
      }
      result.group_summaries![chunkKey] = { id: chunkKey, point_ids: [...new Set(requested)].filter(index => accepted.has(index)).slice(0, settings.sourceSummaryMaxPoints).map(index => accepted.get(index)!),
        ...(summaryRef ? { acceptedRef: summaryRef } : {}),
        models: mergeModels(state.initialModels), missing: invalid || !accepted.size ? [chunkKey] : [], level: 0, children: [], fingerprint: hash(JSON.stringify([chunkKey, requested])) }
      if (invalid) result.gaps!.push({ kind: 'summary', segment_hashes: parts.map(part => part.text_hash), item: requested,
        reasons: [rejected('summary-support', '摘要只引用本组已通过逐字校验的要点', '存在未校验要点下标或超出摘要上限')] })
      // 缓存通过逐字校验及纠正后的候选，避免其他章节改动时再次纠正同一条。
      // 跨首提包的补提证据保存在整篇结果和补提回执；不能塞进缺少完整上下文的局部缓存。
      const candidates = result.segments.flatMap((segment, paragraph_id) => segment.points.filter(point => point.point_id.includes(':' + order + '.')
        && parts.some(part => part.paragraph_id === paragraph_id) && point.evidence.every(evidence => evidenceParagraph(parts, evidence)))
        .map(point => ({ paragraph_id, point }))).sort((a, b) => Number(a.point.point_id.split('.').at(-1)) - Number(b.point.point_id.split('.').at(-1)))
      const indices = candidates.map(item => Number(item.point.point_id.split('.').at(-1)))
      const validator = contextFor(state)
      const terms = output.terms.flatMap((item, index) => {
        const checked = validator.inspect('term', item, validator.checkTerm, outputSchema.shape.terms.element)
        return !checked.reasons.length && checked.item ? [{ item: checked.item, models: state.itemModels['term:' + index] ?? state.initialModels }] : []
      })
      state.normalizedCache = { parts, quota: Math.max(quota, saved?.quota ?? 0), selected_quota: quota, gaps: state.ownGaps, missing_summary: Boolean(invalid), point_indices: indices,
        ...(state.acceptedRef ? { acceptedRef: state.acceptedRef } : {}),
        models: mergeModels(state.models), summary_models: mergeModels(state.initialModels),
        item_models: Object.fromEntries([
          ...candidates.map(({ point }, index) => ['point:' + index, mergeModels(point.models)] as const),
          ...terms.map((term, index) => ['term:' + index, mergeModels(term.models)] as const),
        ]), raw: JSON.stringify({ ...output,
        points: candidates.map(({ paragraph_id, point }) => ({ paragraph_id, text: point.text, section: point.section, evidence: point.evidence.map(({ locator, quote }) => ({ locator, quote })) })),
        terms: terms.map(term => term.item),
        summary_point_indices: requested.filter(index => indices.includes(index)).map(index => indices.indexOf(index)).slice(0, settings.sourceSummaryMaxPoints),
      }) }
      // 包配额用于指导生成；所有校验通过的候选先保留，统一按篇级硬上限选择，避免其他包空额时丢失事实。
    }
    await complete(state)
    state.finalized = true
  }
  const correctionTasks: Promise<void>[] = []
  try {
    let reserved = batchCounts.structure ?? 0, correctionError: unknown, correctionFailed = false
    // 顺序只约束额度分配：前缀首提一就绪就放行其纠正，不等待前项纠正或后续首提。
    dispatchCorrections = () => {
      const reserve = (state: ChunkState | undefined): boolean => {
        if (!state) return false
        if (state.split) return state.children.every(key => reserve(states.get(key)))
        if (!state.initialDone) return false
        if (state.reservationDone) return true
        state.reservationDone = true
        const { batches, overflow } = correctionBatches(state.failed, batch => fitsCorrection(state, batch), Math.max(0, 2 - reserved))
        for (const entry of overflow) { entry.reasons.push(rejected('correction-budget', '至多两批且每批不超过输入预算', String(inputLimit))); gapFor(state, entry) }
        state.batches = batches; reserved += batches.length
        for (const batch of batches) correctionTasks.push(runCorrectionBatch(state, batch).catch(error => {
          if (!correctionFailed) { correctionFailed = true; correctionError = error }
        }))
        return true
      }
      for (const parts of chunks) if (!reserve(states.get(keyFor(parts)))) break
    }
    await mapConcurrent(chunks, concurrency, signal, async (parts) => {
      await readyInitial(parts, signal, keyFor(parts), String(parseInt(hashName(hash(keyFor(parts))).slice(0, 10), 16)), 0)
    })
    const leaves: ChunkState[] = []
    const visitLeaves = (state: ChunkState) => {
      if (state.split) for (const key of state.children) { const child = states.get(key); if (child) visitLeaves(child) }
      else leaves.push(state)
    }
    for (const parts of chunks) { const state = states.get(keyFor(parts)); if (state) visitLeaves(state) }
    await Promise.all(correctionTasks)
    if (correctionFailed) throw correctionError
    for (const state of leaves) {
      if (!state.output || !state.progress) continue
      for (const candidate of state.initialCandidates) {
        if (state.progress.completed_items.includes(candidate.key)) continue
        const value = state.accepted.get(candidate.key)
        if (value) preserveFor(state, candidate, value)
        state.progress.completed_items.push(candidate.key)
      }
    }
    // 补提只依赖各自章节当前要点；先并发取回，再按原文章节顺序验收、纠正和合并。
    const coverageTasks: CoverageTask[] = []
    for (const chapter of allocation.chapters) {
      const chapterParts = whole.filter(part => chapter.paragraph_ids.includes(part.paragraph_id))
      // 包名额只指导首提；补提兑现原章节底线，最终仍按篇级硬上限选择。
      const floor = chapterMinimum(chapter, chapterParts, settings), target = Math.min(selectLimit, floor)
      const existingPoints = pointsInChapter(chapter)
      const coverageKey = 'coverage:' + chapter.id
      if (!target || existingPoints.length >= target || coveragePurpose(chapter.title, '') !== '研究内容'
        || leaves.some(state => state.progress?.completed_items.includes(coverageKey))) continue
      const state = leaves.find(state => state.output && state.progress && state.parts.some(part => chapter.paragraph_ids.includes(part.paragraph_id)))
      if (!state) continue
      const missing = target - existingPoints.length
      const coverageInput = JSON.stringify({ ...JSON.parse(input(chapterParts, missing)), coverage: chapter.id,
        existing_points: existingPoints.map(({ text, evidence }) => ({ text, evidence: evidence.map(({ locator, quote }) => ({ locator, quote })) })) })
      coverageTasks.push({ state, chapter, chapterParts, floor, target, coverageKey, coverageInput })
    }
    const singleCoverage = async (task: CoverageTask) => {
      try {
        const saved = task.state.progress!.coverage_outputs ??= {}
        const models = task.state.progress!.coverage_models ??= {}
        let raw = saved[task.coverageKey]
        if (raw === undefined) {
          if (Buffer.byteLength(prompt + coveragePromptSuffix + task.coverageInput) > inputLimit) throw new Error('完整章节补提输入超过预算，保留缺口')
          const response = await callFor(task.state, task.chapterParts)(prompt + coveragePromptSuffix, task.coverageInput)
          raw = response.raw
          models[task.coverageKey] = response.models
        }
        task.models = mergeModels(models[task.coverageKey])
        task.extra = groupSchema.parse(parseModelJson(raw, schemaJSON(wireOutput)))
        saved[task.coverageKey] = raw
        await checkpoint()
      } catch (error) { if (globalFailure(error, signal)) throw error; task.error = error }
    }
    const batchInput = (tasks: CoverageTask[]) => {
      const first = JSON.parse(tasks[0]!.coverageInput)
      return JSON.stringify({ source_id: sourceId, source_version: first.source_version, coverage: 'chapters',
        tier: first.tier, selectivity: first.selectivity, metadata: first.metadata, fact_requirements: first.fact_requirements,
        chapters: tasks.map(task => {
          const input = JSON.parse(task.coverageInput)
          return { chapter_id: task.chapter.id, point_limit: input.point_limit, paragraphs: input.paragraphs,
            evidence_dictionary: input.evidence_dictionary, existing_points: input.existing_points, vocabulary: input.vocabulary }
        }) })
    }
    // 未声明输出上限时使用保守的 4096 token；单章超出打包门槛仍走原单章路径。
    const outputLimit = coverageTasks.length ? (await options.client.info('ingest', signal, undefined, 'extract')).defaultMaxTokens || 4096 : 4096
    const fitsCoverageBatch = (tasks: CoverageTask[]) => tasks.length <= 8
      && tasks.reduce((sum, task) => sum + task.chapterParts.reduce((bytes, part) => bytes + (bodyCharacters(part.text) ? Buffer.byteLength(part.text) : 0), 0), 0) <= 12288
      && tasks.reduce((sum, task) => sum + 128 + JSON.parse(task.coverageInput).point_limit * 512, 0) <= outputLimit
      && Buffer.byteLength(coverageBatchPrompt + batchInput(tasks)) <= inputLimit
    const batches: CoverageTask[][] = []
    let batch: CoverageTask[] = []
    // 一次性按章节顺序固定边界；并发数、返回先后和失败回退不参与划包。
    for (const task of coverageTasks) {
      if (batch.length && !fitsCoverageBatch([...batch, task])) { batches.push(batch); batch = [] }
      batch.push(task)
      if (!fitsCoverageBatch(batch)) { batches.push(batch); batch = [] }
    }
    if (batch.length) batches.push(batch)
    await mapConcurrent(batches, concurrency, signal, async batch => {
      const pending: CoverageTask[] = []
      for (const task of batch) {
        const saved = task.state.progress!.coverage_outputs?.[task.coverageKey]
        if (saved !== undefined) {
          try {
            task.extra = groupSchema.parse(parseModelJson(saved, schemaJSON(wireOutput)))
            task.models = mergeModels(task.state.progress!.coverage_models?.[task.coverageKey])
          } catch { delete task.state.progress!.coverage_outputs![task.coverageKey]; pending.push(task) }
        } else pending.push(task)
      }
      if (pending.length <= 1) return
      try {
        const response = await callFor(pending[0]!.state, pending.flatMap(task => task.chapterParts))(coverageBatchPrompt, batchInput(pending), coverageBatchOutput)
        const output = z.object({ chapters: z.array(z.unknown()) }).parse(parseModelJson(response.raw, schemaJSON(coverageBatchOutput)))
        for (const task of pending) {
          const matches = output.chapters.filter(item => object(item)?.chapter_id === task.chapter.id)
          if (matches.length !== 1) continue
          const chapter = coverageBatchOutput.shape.chapters.element.safeParse(matches[0])
          if (!chapter.success || chapter.data.points.some(point => !task.chapter.paragraph_ids.includes(point.paragraph_id))) continue
          task.extra = groupSchema.parse({ ...task.state.output, points: chapter.data.points, terms: [], summary_point_indices: [] })
          task.models = response.models
          ;(task.state.progress!.coverage_outputs ??= {})[task.coverageKey] = JSON.stringify(task.extra)
          ;(task.state.progress!.coverage_models ??= {})[task.coverageKey] = response.models
        }
        await checkpoint()
      } catch (error) { if (globalFailure(error, signal)) throw error }
    })
    // 仅有效章（包括明确空数组）消耗机会；遗漏、重复或无效章逐一回退。
    await mapConcurrent(coverageTasks.filter(task => !task.extra), concurrency, signal, singleCoverage)
    const coverageCorrections: { state: ChunkState; batch: CorrectionEntry[] }[] = []
    reserved = batchCounts.structure ?? 0
    for (const task of coverageTasks) if (task.extra && !task.error) {
      const state = task.state
      task.candidates = task.extra.points.map((item, index) => ({ kind: 'point', item, key: task.coverageKey + ':' + index, index }))
      for (const candidate of task.candidates) state.itemModels[candidate.key] ??= mergeModels(task.models)
      state.progress!.item_models = state.itemModels
      const failed = collectCorrections(state, task.candidates, contextFor(state, task.chapterParts), task.chapterParts)
      const { batches, overflow } = correctionBatches(failed, batch => fitsCorrection(state, batch), Math.max(0, 2 - reserved))
      for (const entry of overflow) { entry.reasons.push(rejected('correction-budget', '至多两批且每批不超过输入预算', String(inputLimit))); gapFor(state, entry) }
      reserved += batches.length
      coverageCorrections.push(...batches.map(batch => ({ state, batch })))
    }
    await mapConcurrent(coverageCorrections, concurrency, signal, async ({ state, batch }) => { await runCorrectionBatch(state, batch) })
    const identity = (point: { text: string; evidence: { quote: string }[] }) => JSON.stringify([
      normalizeQuotation(point.text), [...new Set(point.evidence.map(item => normalizeQuotation(item.quote)))].sort()])
    for (const task of coverageTasks) {
      signal.throwIfAborted()
      const state = task.state, chapter = task.chapter, progress = state.progress!
      state.finalized = false
      const existing = pointsInChapter(chapter).length
      if (existing < task.target && !task.error && task.extra) {
        const missing = task.target - existing, known = new Set(result.segments.flatMap(segment => segment.points).map(identity))
        let added = 0
        for (const candidate of task.candidates ?? []) {
          if (added >= missing) break
          const point = state.accepted.get(candidate.key) as PointOutput | undefined
          if (!point || !chapter.paragraph_ids.includes(point.paragraph_id) || known.has(identity(point))) continue
          known.add(identity(point)); added++
          const key = 'point:' + state.output!.points.length
          const models = mergeModels(state.itemModels[candidate.key] ?? task.models)
          state.itemModels[key] = models
          progress.item_models = state.itemModels
          state.output!.points.push(point)
          progress.completed_items.push(key)
          preservePointFor(state, point, state.output!.points.length - 1, models)
        }
        progress.raw = JSON.stringify(state.output)
      }
      if (task.extra && !task.error) progress.completed_items.push(task.coverageKey)
      if (pointsInChapter(chapter).length < task.floor) {
        const gap: ExtractionGap = { kind: 'point', segment_hashes: task.chapterParts.map(part => part.text_hash), item: { chapter: chapter.title, chapter_id: chapter.id },
          reasons: [rejected('chapter-coverage', '本章至少 ' + task.floor + ' 个要点', task.error ? String(task.error) : '补提一次后未达底线')] }
        result.gaps!.push(gap); state.ownGaps.push(gap)
      }
    }
    await mapConcurrent(chunks, concurrency, signal, async parts => {
      const state = states.get(keyFor(parts)); if (state) await finalizeState(state)
    })
  } catch (error) { await Promise.all(correctionTasks); await checkpoint(); throw error }
  refresh()
  // 完成顺序不参与成果编号；按原段、组序和模型条目序稳定合并。
  const counters = new Map<string, number>()
  const orders = new Map(chunks.map((parts, index) => [String(parseInt(hashName(hash(keyFor(parts))).slice(0, 10), 16)), index]))
  const comparePoints = (a: Extraction['segments'][number]['points'][number], b: Extraction['segments'][number]['points'][number]) => {
    const left = a.point_id.split(':').at(-1)!, right = b.point_id.split(':').at(-1)!
    return (orders.get(left.split('.')[0]!) ?? -1) - (orders.get(right.split('.')[0]!) ?? -1) || left.localeCompare(right)
  }
  for (const segment of result.segments) segment.points.sort(comparePoints)
  const allPoints = result.segments.flatMap(segment => segment.points)
  // 先兑现已分配的章节名额，补提不挤占其他章名额；余量保留首提的有效事实。
  const selected = selectSourcePoints(allPoints, selectLimit, allocation.chapters.map(chapter => ({
    ids: new Set(pointsInChapter(chapter).map(point => point.point_id)),
    minimum: Math.max(chapter.quota, chapterMinimum(chapter, whole, settings)),
  })))
  const droppedPoints = allPoints.filter(point => !selected.has(point.point_id))
  const overflow = allPoints.length - selected.size
  const pointIds = new Map<string, string>()
  for (const segment of result.segments) {
    segment.terms.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
    segment.points.sort(comparePoints)
    segment.points = segment.points.filter(point => selected.has(point.point_id))
    for (const point of segment.points) {
      const number = (counters.get(segment.text_hash) ?? 0) + 1; counters.set(segment.text_hash, number)
      const old = point.point_id
      const stable = chunks.length > 1 ? String(parseInt(hashName(hash(old.split(':').at(-1)!)).slice(0, 12), 16)).padStart(2, '0') : String(number).padStart(2, '0')
      point.point_id = sourceId + ':' + segment.text_hash + ':' + stable
      pointIds.set(old, point.point_id)
    }
  }
  if (overflow) {
    result.truncations!.push({ chunk: 'source', count: overflow })
    await writeJson(root, 'logs/failures/' + sourceId + '/quota-' + randomUUID() + '.json', { source_id: sourceId, rule: 'source-quota', truncated_points: overflow,
      details: { truncated_points: overflow, points: droppedPoints } })
  }
  for (const chapter of allocation.chapters) {
    if (!chapter.quota && !pointsInChapter(chapter).length && coveragePurpose(chapter.title, '') === '研究内容'
      && whole.some(part => chapter.paragraph_ids.includes(part.paragraph_id) && bodyCharacters(part.text) > 0)) result.gaps!.push({
      kind: 'point', segment_hashes: chapter.paragraph_ids.map(id => source.segments[id]!.text_hash), item: { chapter: chapter.title, chapter_id: chapter.id },
      reasons: [{ rule: 'chapter-quota', expected: '本章至少分配 1 个名额', actual: '章节配额不足：篇级上限已分完' }],
    })
    const floor = chapterMinimum(chapter, plan.flat(), settings), count = pointsInChapter(chapter).length
    if (count < floor && !result.gaps!.some(gap => (gap.item as { chapter_id?: string } | null)?.chapter_id === chapter.id)) result.gaps!.push({ kind: 'point',
      segment_hashes: chapter.paragraph_ids.map(id => source.segments[id]!.text_hash), item: { chapter: chapter.title, chapter_id: chapter.id },
      reasons: [{ rule: 'chapter-coverage', expected: '本章至少 ' + floor + ' 个要点', actual: '硬上限保留后为 ' + count + ' 个' }] })
  }
  result.truncations!.sort((a, b) => a.chunk.localeCompare(b.chunk))
  if (result.truncations!.length) await appendLog(root, '\n### 提取要点截断\n- 来源：' + sourceId + '\n- 截断条数：' + result.truncations!.reduce((sum, item) => sum + item.count, 0) + '\n')
  result.gaps!.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
  for (const segment of result.segments) segment.processing_fingerprint = processingFingerprint(result.processing, segment.resource_hashes)
  if (options.defaultCredibility) { result.metadata.credibility = options.defaultCredibility; result.metadata.credibility_reason = '库配置覆盖：' + options.defaultCredibility }
  for (const summary of Object.values(result.group_summaries!)) summary.point_ids = summary.point_ids.flatMap(id => pointIds.has(id) ? [pointIds.get(id)!] : [])
  // 旧短文只复用段落时，直接用本次仍有效的要点构成可回源摘要。
  if (!chunks.length && result.segments.some(segment => segment.points.length)) {
    const id = 'body/reused'
    const points = result.segments.flatMap(segment => segment.points).slice(0, settings.sourceSummaryMaxPoints)
    result.group_summaries![id] = { id, models: mergeModels(...points.map(point => point.models)), point_ids: points.map(point => point.point_id), missing: [], level: 0, children: [], fingerprint: hash(source.contentHash) }
  }
  const leafKeys = (key: string): string[] => result.chunk_splits?.[key]?.flatMap(leafKeys) ?? [key]
  const summaryKeys = chunks.length ? chunks.flatMap(parts => leafKeys(keyFor(parts))) : Object.keys(result.group_summaries!)
  if (reused.size && chunks.length === 1) {
    const summary = result.group_summaries![summaryKeys[0]!]
    if (summary) summary.point_ids = [...new Set([...summary.point_ids, ...[...reused.values()].flatMap(segment => segment.points).map(point => point.point_id)])].slice(0, settings.sourceSummaryMaxPoints)
  }
  const currentKeys = new Set(summaryKeys)
  result.group_cache = Object.fromEntries(Object.entries(result.group_cache!).filter(([key]) => currentKeys.has(key)))
  result.chunk_splits = Object.fromEntries(Object.entries(result.chunk_splits!).filter(([key]) => chunks.some(parts => key.startsWith(keyFor(parts)))))
  result.summary_pending = summaryKeys
  try { if (longdoc || summaryKeys.length <= 1) await synthesizeSourceSummary(result, summaryKeys, options, settings, inputLimit, checkpoint, globalFailure) }
  catch (error) { await checkpoint(); throw error }
  return finish(result)
}
export function renderSource(entry: SourceEntry, extraction: Extraction): string {
  const metadata = entry.metadata
  const sourcePaths = [...new Set([entry.current_path, ...(entry.alias_paths ?? [])])]
  const frontmatter = stringify({ id: entry.source_id, page_type: 'source', type: 'source', created: entry.created_at ?? entry.updated_at,
    aliases: [...new Set([metadata.title, ...sourcePaths.map(value => path.posix.parse(value.replaceAll('\\', '/')).name)])],
    current_path: entry.current_path, alias_paths: sourcePaths.filter(value => value !== entry.current_path),
    models: mergeModels(entry.models, extraction.models).map(model => `${model.provider}/${model.model}`),
    tags: entry.tags ?? canonicalTags(extraction.tag_candidates ?? extraction.tags ?? [], extraction.segments.flatMap(segment => segment.terms)), title: metadata.title, source_type: metadata.source_type,
    credibility: metadata.credibility, source_date: metadata.source_date, sources: [entry.source_id], source_version: entry.source_version, updated: entry.updated_at }).trimEnd()
  const points = extraction.segments.flatMap(segment => segment.points), anchors = evidenceBlockIds(points)
  const blocks = [`---\n${frontmatter}\n---\n\n# ${metadata.title}`, '## 概览\n\n' + sourceOverview(extraction, anchors), `可信度依据：${metadata.credibility_reason?.trim() || '未提供依据'}。资料日期依据：${metadata.source_date_basis}。`]
  blocks.push('## 来源路径\n\n' + sourcePaths.map(value => '- ' + value).join('\n'))
  const unverified = points.filter(point => point.verification?.status === 'unverified')
  if (entry.pending_topic_points?.length) blocks.push('## 待归属主题\n\n主题归属需要向量；以下要点已保留，向量服务恢复后按正常流程归属。\n\n'
    + points.filter(point => entry.pending_topic_points!.includes(point.point_id)).map(point => `- ${point.text} [证据](#^${anchors.get(point.point_id)![0]})`).join('\n'))
  if (unverified.length) blocks.push('## 未核实\n\n' + unverified.map(point => `- ${point.text} —— ${point.verification!.missing} [证据](#^${anchors.get(point.point_id)![0]})`).join('\n'))
  if (extraction.summary) {
    const summary = extraction.summary
    blocks.push('## 全篇摘要\n\n' + (summary.point_ids.map(id => {
      const point = points.find(point => point.point_id === id)
      return point && point.verification?.status !== 'unverified' ? `- ${point.text} [回源](#^${anchors.get(id)![0]})` : ''
    }).filter(Boolean).join('\n') || '暂无通过校验的摘要要点。')
      + (summary.missing.length ? '\n\n摘要覆盖缺口：' + [...new Set(summary.missing.map(id => extraction.chapters?.find(chapter => id.startsWith(chapter.id))?.title ?? id))].join('、') + '。' : ''))
  }
  const summaryExclusions = Object.values(extraction.group_cache ?? {}).filter(group => group.summary_excluded_reason)
  if (summaryExclusions.length) blocks.push(`摘要补缺排除：${summaryExclusions.length} 组无可用摘要依据，原组在现有已校验要点中没有匹配成员。已有要点保留。`)
  if (extraction.chapters?.length) {
    const label = (title: string) => title.replace(/[\[\]<>]/g, '')
    blocks.push('## 章节导航\n\n' + extraction.chapters.map(chapter => `- [${label(chapter.title)}](#^${chapterBlockId(chapter.id)})`).join('\n'))
    for (const chapter of extraction.chapters) {
      const selected = chapter.paragraph_ids.flatMap(id => extraction.segments[id]?.points ?? [])
      blocks.push(`## ${label(chapter.title)} ^${chapterBlockId(chapter.id)}\n\n` + (selected.map(point => `- ${point.verification?.status === 'unverified' ? '【未核实】' : ''}${point.text} [证据](#^${anchors.get(point.point_id)![0]})`).join('\n') || '本节无独立要点。'))
    }
  }
  if (entry.siyuan) blocks.push('## 思源回源\n\n请走 keeper_notes 回源，action="read"；target 与 revision 按具体块使用：\n\n'
    + entry.siyuan.source_refs.map(reference => `- ${reference.locator}：${JSON.stringify(reference)}`).join('\n'))
  if (extraction.gaps?.length) blocks.push(`## 提取缺口\n\n${extraction.gaps.map(gap => `- ${gap.kind === 'unverified_claim' ? '要点未核实' : (gap.kind === 'point' ? '要点' : gap.kind === 'group' ? '提取组' : gap.kind === 'summary' ? '摘要' : '术语') + '未保留'}${retryableExtractionGap(gap) ? '（可重试，下次建库自动重提）' : ''}：${gap.reasons.map(reason => `${reason.rule}（期望：${reason.expected}；实际：${reason.actual}）`).join('；')}`).join('\n')}`)
  for (const section of sections) {
    const content = section === '证据位置' ? points.flatMap(point => point.evidence.map((evidence, index) => renderEvidence(`${index === 0 && point.section === '证据位置' ? point.text + ' ' : ''}${point.point_id}：[${evidence.source_id}@${evidence.source_version}#${evidence.locator}]`, evidence.quote, anchors.get(point.point_id)![index]!)))
      : points.filter(point => point.section === section).map(point => `- ${point.verification?.status === 'unverified' ? '【未核实】' : ''}${point.text} ${point.evidence.map(evidence => `[${evidence.source_id}@${evidence.source_version}#${evidence.locator}]`).join('；')}`)
    if (section === '证据位置') for (const asset of entry.files.assets) content.push(`- 附件：${asset.original_path} → ${asset.path}（${asset.hash}）`)
    blocks.push(`## ${section}\n\n${content.length ? content.join('\n') : section === '对象与条件' && extraction.processing.tier >= 25 ? '未说明' : '未提取'}`)
  }
  const terms = extraction.segments.flatMap(segment => segment.terms).map(term => `- ${term.name}（${term.category}）${term.aliases.length ? '；别称：' + term.aliases.join('、') : ''}：${term.note?.trim() || '未提供依据'} [${entry.source_id}@${entry.source_version}#${term.locator}]`)
  blocks.push(`## 术语清单\n\n${terms.length ? terms.join('\n') : '未提取'}`)
  return blocks.join('\n\n') + '\n'
}
