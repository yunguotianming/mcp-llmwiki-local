import { copyFile, mkdir, readFile, readdir, rename, stat } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { parse } from 'yaml'
import { safePath } from '../storage/paths.js'
import { withLibraryLock } from '../storage/lock.js'
import { policySchema } from '../domain/policy-schema.js'
import { appendLog, atomicWrite, hash } from './files.js'
import { canonicalJson, legacyProvenance, protocolDigest, protocolError, readProtocol, sortedUnique, writeProtocol, writeProvenance, artifactId, readProvenance } from './models.js'
import { createExecutionLedger, readRunCosts, readVersionCosts, usageTokens, writeVersionCosts } from './costs.js'
import type { AcceptedRef, ExecutionHooks, SnapshotManifest, StageId } from './schema.js'
import { storageJson } from './vectors.js'
import { executeAccepted, makeTaskIdentity, readAccepted, recoverAccepted, withRecovery } from './accepted.js'
import type { AcceptanceBindings, RecoveryPending } from './accepted.js'
import type { BuildLayeredOptions, Extraction, PageDependencies, Point, SourceEntry, TaskIdentity } from './schema.js'
import { extractionReviewRequests, reviewExtraction, reviewPromptHash } from './review.js'
import { reviewTopicContent, topicReviewFingerprint, topicReviewRequests, topicReviewVersion } from './topic-review.js'
import type { TopicEvidenceSource } from './topic-metadata.js'
import { topicClaimText, topicEvidenceContext } from './topic-metadata.js'
import { layeredSettings } from '../domain/config.js'
import { topicBudget } from './input-budget.js'
import { readRetentionRoots } from './retention.js'

const checkpoint = 'work/upgrade-0.3.0.json'
const backupMetadata = '.llmwiki-upgrade-backup.json'
export interface UpgradeStep {
  id: string; kind: 'summary' | 'review' | 'gap' | 'metadata'; stage: StageId
  unitIds: string[]; inputDigest: string; estimatedInputTokens: number; maxOutputTokens: number
  /** 初轮请求合计；输入窗口检查仍使用上面的单包最大值。 */
  estimate?: UpgradeEstimate
  /** 收缩分组时保留单对象原身份；外层按实际子集另建身份，不迁签旧接受。 */
  reviewOrigin?: { id: string; inputDigest: string; revocationGeneration: number }
}
export interface UpgradeEstimate { calls: number; inputTokens: number; outputTokens: number }
interface ReuseItem { path: string; digest: string; kind: 'extraction' | 'page' | 'vector' | 'checkpoint'; after: string }
interface UpgradeReviewExclusion {
  rule: 'archived-topic-placeholder-v1'; reason: string; objectDigest: string; dependencyDigests: string[]; pagePaths: string[]
}
export interface UpgradeStatus {
  id: string; status: 'prepared' | 'paused' | 'complete'; reason: string | null; backupPath: string
  originalFormat: '0.2.x'; inputDigest: string; files: Record<string, string>; reuse: ReuseItem[]
  steps: UpgradeStep[]; accepted: Record<string, AcceptedRef>
  /** 逐对象本地排除依据；不表示模型核对通过，也不产生接受记录。 */
  reviewExclusions?: Record<string, UpgradeReviewExclusion>
  estimate: UpgradeEstimate
  limits: { maxCalls?: number; maxTokens?: number }
  actual: { calls: number; tokens: number; unknownUsage: number }
  reuseRates: Record<ReuseItem['kind'], number | null>
}
interface BackupMetadata { id: string; root: string; libraryId: string | null; inputDigest: string; files: Record<string, string>; complete: boolean; upgrade: UpgradeStatus }
export interface UpgradeOptions {
  /** 新建库使用本轮已校验的策略；旧库仍通过备份升级提交格式。 */
  initialPolicy?: import('../domain/policy.js').LibraryPolicy
  /** B2 校验后的可选升级总额；省略不设默认上限。 */
  upgrade?: { maxCalls?: number; maxTokens?: number }
  /** 宿主补充简介及必需元数据清单；本地核对单元由预检产生。 */
  steps?: UpgradeStep[]
  /** 与执行共用制包和阶段配置；不派发模型。 */
  estimateReview?: (step: UpgradeStep, root: string) => Promise<UpgradeEstimate & { maxInputTokens: number; maxOutputTokens: number }>
  inputLimitTokens?: number
  onStatus?: (status: UpgradeStatus) => void | Promise<void>
  runStep?: (step: UpgradeStep, context: { root: string; runId: string; hooks: ExecutionHooks; replayOnly: boolean }) => Promise<AcceptedRef>
  signal?: AbortSignal
}

function reviewSources(versions: Awaited<ReturnType<typeof manifests>>, step: UpgradeStep) {
  return sortedUnique(versions.flatMap(({ manifest }) => manifest.sources.filter(source => step.stage === 'extractionReview'
    ? step.unitIds.includes(source.extract.path) : Object.entries(manifest.pages ?? {}).some(([page, digest]) =>
      step.unitIds.includes(`objects/pages/${digest.slice(7)}.md`) && manifest.deps?.pages[page]?.sources.includes(source.source_id)))))
}
async function upgradeExtraction(root: string, source: SourceEntry) {
  const extraction = JSON.parse(await readFile(await safePath(root, source.extract.path), 'utf8')) as Extraction
  const inputPath = source.siyuan?.input ?? source.files.source
  const bytes = await readFile(await safePath(root, inputPath))
  if (source.siyuan) {
    const objects = source.siyuan.objects.filter(object => object.path === inputPath)
    if (objects.length !== 1 || hash(bytes) !== objects[0]!.hash) throw protocolError('UPGRADE_SOURCE_CHANGED', '升级核对来源投影缺失或摘要不符。')
  } else if (hash(bytes) !== source.content_hash) throw protocolError('UPGRADE_SOURCE_CHANGED', '升级核对来源快照摘要不符。')
  return { extraction, source: { path: source.current_path, bytes, text: bytes.toString('utf8'), contentHash: source.content_hash,
    sourceId: source.source_id, sourceVersion: source.source_version, segments: source.segments, metadata: source.metadata } }
}
function topicOwners(versions: Awaited<ReturnType<typeof manifests>>, id: string) {
  return versions.flatMap(({ manifest }) => Object.entries(manifest.pages ?? {}).filter(([, digest]) => id === `objects/pages/${digest.slice(7)}.md`)
    .map(([page]) => ({ manifest, page, dependency: manifest.deps?.pages[page] })))
}
/** 只识别 renderTopic 的无来源归档占位；任意额外事实、导航或依赖均保留模型核对。 */
async function topicReviewExclusion(root: string, versions: Awaited<ReturnType<typeof manifests>>, id: string): Promise<UpgradeReviewExclusion | undefined> {
  const owners = topicOwners(versions, id), content = await readFile(await safePath(root, id), 'utf8')
  if (!owners.length || hash(content) !== 'sha256:' + path.basename(id, '.md')) return
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(content)
  if (!match) return
  let header: Record<string, unknown>
  try { header = parse(match[1]!) } catch { return }
  if (!header || typeof header !== 'object' || Array.isArray(header)) return
  const empty = (value: unknown) => Array.isArray(value) && value.length === 0
  const fields = ['id', 'page_type', 'aliases', 'title', 'source_type', 'credibility', 'source_date', 'sources', 'models', 'archived', 'updated',
    'generation_hash', 'input_fingerprint', 'generation_input_fingerprint', 'type', 'created', 'tags']
  if (Object.keys(header).some(key => !fields.includes(key)) || header.archived !== true || header.page_type !== 'topic'
    || typeof header.title !== 'string' || !header.title || !empty(header.aliases) || !empty(header.sources) || !empty(header.models)
    || header.source_type !== '综合' || header.credibility !== 'mixed' || header.source_date !== 'unknown' || header.updated !== 'unknown'
    || header.type !== undefined && header.type !== 'topic' || header.tags !== undefined && !empty(header.tags)
    || header.created !== undefined && (typeof header.created !== 'string' || !Number.isFinite(Date.parse(header.created)))
    || ['generation_hash', 'input_fingerprint', 'generation_input_fingerprint'].some(key => header[key] !== undefined && !/^sha256:[a-f0-9]{64}$/.test(String(header[key])))) return
  for (const { manifest, page, dependency } of owners) {
    const topic = manifest.topics?.topics.find(topic => topic.path === page)
    if (!page.startsWith('topics/') || header.id !== path.basename(page, '.md') || !dependency
      || dependency.sources.length || dependency.points.length || dependency.children?.length || dependency.models?.length
      || topic && (!topic.archived || topic.point_ids.length || topic.direct_point_ids?.length || topic.sources.length)) return
  }
  // 83b2384 前原样转义标题；此后先清理临时引用。两版都按完整正文精确匹配。
  const titles = [header.title, topicClaimText(header.title)].map(title => title.replace(/[\r\n]+/g, ' ').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('[', '\\[').replaceAll(']', '\\]'))
  const body = match[2]!.replaceAll('\r\n', '\n').trimEnd()
  if (!titles.some(title => body === `\n# ${title}\n\n范围：旧主题保留；当前来源已无可引用的原要点。\n\n## 共识\n\n未提取\n\n## 分歧\n\n未提取\n\n## 适用条件\n\n未提取\n\n## 来源导航`)) return
  return { rule: 'archived-topic-placeholder-v1', reason: '无来源、成员或子页，正文完全匹配程序生成的归档保留占位；不作研究事实核对。',
    objectDigest: hash(content), dependencyDigests: sortedUnique(owners.map(owner => protocolDigest(owner.dependency))), pagePaths: sortedUnique(owners.map(owner => owner.page)) }
}
async function reviewExclusions(root: string, versions: Awaited<ReturnType<typeof manifests>>, steps: UpgradeStep[]) {
  const result: Record<string, UpgradeReviewExclusion> = {}
  for (const id of sortedUnique(steps.filter(step => step.kind === 'review' && step.stage === 'topicReview').flatMap(step => step.unitIds))) {
    const exclusion = await topicReviewExclusion(root, versions, id)
    if (exclusion) result[id] = exclusion
  }
  return result
}
const reviewUnitIds = (step: UpgradeStep, exclusions: Record<string, UpgradeReviewExclusion>) => step.unitIds.filter(id => !exclusions[id])
/** 父页依赖只保存 direct points；核对成员与正常 checkTopic 一样包含显式子树的成员。 */
async function topicReviewPoints(root: string, owner: ReturnType<typeof topicOwners>[number], physical: Awaited<ReturnType<typeof manifests>>) {
  const points = new Map<string, string>(), active = new Set<string>(), completed = new Set<string>()
  const incomplete = (message: string) => protocolError('UPGRADE_ROOT_INCOMPLETE', '有效主题根的子树证据不完整：' + message)
  const visit = async (manifest: SnapshotManifest, page: string, dependency: PageDependencies) => {
    const key = `${manifest.version ?? 'pending'}:${page}`
    if (active.has(key)) throw incomplete('子页依赖成环：' + page)
    if (completed.has(key)) return
    active.add(key)
    for (const sourceId of dependency.sources) {
      const source = manifest.sources.find(source => source.source_id === sourceId)
      const parent = owner.manifest.sources.find(source => source.source_id === sourceId)
      if (!owner.dependency!.sources.includes(sourceId) || !source || !parent || protocolDigest(source) !== protocolDigest(parent))
        throw incomplete('子页来源与父页绑定版本不符：' + page)
    }
    for (const point of dependency.points) {
      if (points.has(point.point_id) && points.get(point.point_id) !== point.text_hash) throw incomplete('同成员出现不同摘要：' + point.point_id)
      points.set(point.point_id, point.text_hash)
    }
    for (const child of dependency.children ?? []) {
      const version = child.version || manifest.version
      const childManifest = version === manifest.version && manifest.pages?.[child.page] ? manifest
        : physical.find(item => item.manifest.version === version)?.manifest
      const digest = childManifest?.pages?.[child.page], childDependency = childManifest?.deps?.pages[child.page]
      if (!child.page.startsWith('topics/') || !childManifest || !digest || !childDependency
        || hash(await readFile(await safePath(root, `objects/pages/${digest.slice(7)}.md`)).catch(error => {
          if (error.code === 'ENOENT') return Buffer.alloc(0)
          throw error
        })) !== digest) throw incomplete('子页版本、对象或依赖缺失：' + child.page)
      await visit(childManifest, child.page, childDependency)
    }
    active.delete(key); completed.add(key)
  }
  await visit(owner.manifest, owner.page, owner.dependency!)
  return [...points].sort(([a], [b]) => a.localeCompare(b)).map(([point_id, text_hash]) => ({ point_id, text_hash }))
}
async function upgradeTopic(root: string, versions: Awaited<ReturnType<typeof manifests>>, id: string) {
  const owners = topicOwners(versions, id)
  if (!owners.length || owners.some(owner => !owner.dependency)) throw protocolError('UPGRADE_ROOT_INCOMPLETE', '有效主题根缺少依赖上下文：' + id)
  const physical = owners.some(owner => owner.dependency!.children?.length) ? await manifests(root) : []
  const inputs = await Promise.all(owners.map(async owner => ({ page: owner.page, sources: owner.dependency!.sources,
    points: await topicReviewPoints(root, owner, physical), entries: owner.manifest.sources.filter(source => owner.dependency!.sources.includes(source.source_id)) })))
  if (new Set(inputs.map(input => protocolDigest(input))).size !== 1) throw protocolError('UPGRADE_ROOT_INCOMPLETE', '有效主题根的来源上下文不唯一：' + id)
  const { manifest, page, dependency } = owners[0]!, contexts = new Map<string, TopicEvidenceSource>()
  if (dependency!.sources.some(id => !manifest.sources.some(source => source.source_id === id))) throw protocolError('UPGRADE_ROOT_INCOMPLETE', '有效主题根的来源缺失。')
  const points: Point[] = []
  const expected = new Map(inputs[0]!.points.map(point => [point.point_id, point.text_hash]))
  for (const source of manifest.sources.filter(source => dependency!.sources.includes(source.source_id))) {
    const { extraction, source: input } = await upgradeExtraction(root, source)
    if (extraction.source_id !== source.source_id || extraction.source_hash !== source.content_hash)
      throw protocolError('UPGRADE_ROOT_INCOMPLETE', '有效主题根的提取对象与原文来源不符。')
    const evidenceSource = { title: source.metadata.title, source_version: source.source_version, text: input.text, segments: source.segments }
    for (const segment of extraction.segments) for (const point of segment.points.filter(point => expected.has(point.point_id))) {
      if (expected.get(point.point_id) !== point.text_hash || point.source_version !== source.source_version)
        throw protocolError('UPGRADE_ROOT_INCOMPLETE', '有效主题根的成员摘要或来源版本不符。')
      const original = source.segments.find(item => item.locator === segment.locator && item.start === segment.start && item.end === segment.end)
      if (point.text_hash !== segment.text_hash || !original || original.text_hash !== segment.text_hash
        || hash(input.text.slice(segment.start, segment.end)) !== segment.text_hash)
        throw protocolError('UPGRADE_ROOT_INCOMPLETE', '有效主题根的成员所属原段摘要不符。')
      if (!point.evidence.length || point.evidence.some(evidence => evidence.source_id !== source.source_id || evidence.source_version !== source.source_version))
        throw protocolError('UPGRADE_ROOT_INCOMPLETE', '有效主题根的成员证据来源或版本不符。')
      try { for (const evidence of point.evidence) topicEvidenceContext(evidence, evidenceSource) }
      catch (error) { throw protocolError('UPGRADE_ROOT_INCOMPLETE', '有效主题根的成员证据无效：' + String(error)) }
      points.push(point)
    }
    contexts.set(source.source_id, evidenceSource)
  }
  if (points.length !== expected.size || new Set(points.map(point => point.point_id)).size !== expected.size)
    throw protocolError('UPGRADE_ROOT_INCOMPLETE', '有效主题根的成员缺失或不唯一。')
  return { topicId: path.basename(page, '.md'), content: await readFile(await safePath(root, id), 'utf8'), points, contexts }
}
function upgradeReviewIdentity(bindings: AcceptanceBindings, versions: Awaited<ReturnType<typeof manifests>>, step: UpgradeStep, sources: SourceEntry[]): TaskIdentity {
  return { version: 1, scope: { libraryId: bindings.libraryId, unitId: step.id,
    sourceRefs: sortedUnique(sources.map(source => ({ sourceId: source.source_id, sourceVersion: source.source_version }))) },
    stage: step.stage, operation: 'review', inputDigest: step.inputDigest,
    promptDigest: step.stage === 'extractionReview' ? reviewPromptHash() : topicReviewVersion,
    schemaDigest: protocolDigest(['upgrade-review-v1', step.stage]), validatorVersion: 'upgrade-review-v1', semanticVersion: 'upgrade-review-v1',
    groupPlanDigest: protocolDigest(step.unitIds), revocationGeneration: versions[0]?.manifest.revocation_generation ?? 0, reextractGeneration: 0 }
}
interface UpgradeUnitResult { id: string; result: unknown }
const validReviewStep = (step: UpgradeStep, exclusions: Record<string, UpgradeReviewExclusion> = {}) => (value: { units: UpgradeUnitResult[] }) => {
  const matches = (ids: string[]) => value.units.length === ids.length && ids.every(id => value.units.some(unit => unit.id === id))
  // 原版本已由模型接受的完整输出仍可回放；新执行只接受需要模型核对的对象。
  return matches(reviewUnitIds(step, exclusions)) || matches(step.unitIds)
}
async function upgradeReviewUnit(root: string, versions: Awaited<ReturnType<typeof manifests>>, sources: SourceEntry[], parent: TaskIdentity, id: string) {
  const candidates = sources.filter(source => source.extract.path === id)
  if (parent.stage === 'extractionReview' && (candidates.length === 0 || new Set(candidates.map(source => protocolDigest(source))).size !== 1))
    throw protocolError('UPGRADE_ROOT_INCOMPLETE', '有效提取根的来源上下文缺失或不唯一：' + id)
  const unit = parent.stage === 'extractionReview'
    ? { kind: 'extraction' as const, ...await upgradeExtraction(root, candidates[0]!) }
    : { kind: 'topic' as const, ...await upgradeTopic(root, versions, id) }
  const input = unit.kind === 'extraction'
    ? { extraction: unit.extraction, source: { path: unit.source.path, text: unit.source.text, contentHash: unit.source.contentHash,
      sourceId: unit.source.sourceId, sourceVersion: unit.source.sourceVersion, segments: unit.source.segments, metadata: unit.source.metadata } }
    : { topicId: unit.topicId, content: unit.content, points: unit.points, sources: [...unit.contexts] }
  const sourceRefs = unit.kind === 'extraction' ? [{ sourceId: unit.source.sourceId, sourceVersion: unit.source.sourceVersion }]
    : [...unit.contexts].map(([sourceId, source]) => ({ sourceId, sourceVersion: source.source_version! }))
  const identity: TaskIdentity = { ...parent, scope: { libraryId: parent.scope.libraryId, unitId: parent.scope.unitId + ':object:' + id, sourceRefs: sortedUnique(sourceRefs) },
    inputDigest: protocolDigest([parent.inputDigest, id, input]), schemaDigest: protocolDigest(['upgrade-review-unit-v1', parent.stage]),
    validatorVersion: 'upgrade-review-unit-v1', semanticVersion: 'upgrade-review-unit-v1', groupPlanDigest: protocolDigest([id]) }
  const valid = (value: UpgradeUnitResult) => value?.id === id && (unit.kind === 'extraction'
    ? Array.isArray(value.result) && value.result.length === unit.extraction.segments.flatMap(segment => segment.points).length
      && unit.extraction.segments.flatMap(segment => segment.points).every(point => value.result instanceof Array
        && value.result.some(item => item?.point_id === point.point_id && item.verification?.status === 'verified'))
    : Boolean(value.result && typeof value.result === 'object' && 'fingerprint' in value.result && typeof value.result.fingerprint === 'string'
      && 'removed' in value.result && Array.isArray(value.result.removed) && !value.result.removed.length))
  return { id, unit, identity, valid }
}
function assertReviewEvidence(value: { units: UpgradeUnitResult[] }, plans: Awaited<ReturnType<typeof upgradeReviewUnit>>[], options: BuildLayeredOptions) {
  const settings = layeredSettings(options.topics || {}, options.tier)
  for (const { id, unit } of plans) {
    if (unit.kind !== 'topic') continue
    const result = value.units.find(item => item.id === id)?.result as { fingerprint?: unknown; removed?: unknown } | undefined
    if (result?.fingerprint !== topicReviewFingerprint(unit.content, unit.points, settings.contradictionReview, unit.contexts)
      || !Array.isArray(result.removed) || result.removed.length)
      throw protocolError('UPGRADE_REVIEW_EVIDENCE_CHANGED', '升级主题核对证据已变化，原接受不适用于当前对象：' + id)
  }
}

/** 统计当前证据和窗口已确定的初轮包；后续合并、纠正和重试由实际账本累计。 */
export function upgradeReviewEstimator(bind: (hooks?: ExecutionHooks) => AcceptanceBindings, options: BuildLayeredOptions): NonNullable<UpgradeOptions['estimateReview']> {
  return async (step, root) => {
    const estimate = { calls: 0, inputTokens: 0, outputTokens: 0, maxInputTokens: 0, maxOutputTokens: 0 }
    const physical = await manifests(root), versions = await reviewManifests(root, physical)
    const active = await narrowReviewStep(root, step, versions, physical)
    if (!active) return estimate
    step = active
    const exclusions = await reviewExclusions(root, versions, [step])
    const sources = reviewSources(versions, step), bindings = bind()
    const identity = upgradeReviewIdentity(bindings, physical, step, sources)
    const unitParent = reviewUnitParent(step, identity)
    const plans = await Promise.all(reviewUnitIds(step, exclusions).map(id => upgradeReviewUnit(root, versions, sources, unitParent, id)))
    const saved = await readAccepted(root, bindings, identity, validReviewStep(step, exclusions))
    if (saved) { assertReviewEvidence(saved.value, plans, options); return estimate }
    const pending = []
    for (const planned of plans) {
      if (!await readAccepted(root, bindings, planned.identity, planned.valid)) pending.push(planned.unit)
    }
    if (!pending.length) return estimate
    const settings = layeredSettings(options.topics || {}, options.tier)
    const initial = (await bindings.stageInputBudgets(step.stage, { system: '', input: '' }))[0]!
    const inputLimit = step.stage === 'extractionReview'
      ? Math.min(initial.inputLimitBytes, settings.extractMaxInputBytes, options.maxInputBytes ?? Infinity)
      : await topicBudget(options, 'topicReview', settings.topicReviewInputBudget)
    for (const unit of pending) {
      let requests: ReturnType<typeof topicReviewRequests>
      if (unit.kind === 'extraction') {
        requests = extractionReviewRequests(unit.extraction, unit.source, { ...options, topics: { ...options.topics || {}, extractionReview: 'all' } }, inputLimit)
        if (requests.some(request => Buffer.byteLength(request.system + request.input) > Math.floor(inputLimit * settings.extractCeilingRatio)))
          throw protocolError('UPGRADE_INPUT_LIMIT', '完整证据超出候选输入窗口。')
      } else {
        requests = topicReviewRequests(unit.topicId, unit.content, unit.points, { ...options, topics: { ...options.topics || {}, topicReview: true } }, inputLimit, unit.contexts)
      }
      for (const request of requests) {
        if (request.acceptance && await readAccepted(root, bindings,
          await makeTaskIdentity(step.stage, request.acceptance.spec, { root, pending: {}, bindings }), request.acceptance.valid)) continue
        const budget = (await bindings.stageInputBudgets(step.stage, request))[0]!
        if (!Number.isSafeInteger(budget.estimatedInputTokens) || budget.estimatedInputTokens! < 0
          || !Number.isSafeInteger(budget.maxOutputTokens) || budget.maxOutputTokens! <= 0)
          throw protocolError('UPGRADE_ESTIMATE_UNBOUND', '升级核对缺少阶段输入估算或输出额度。')
        estimate.calls++; estimate.inputTokens += budget.estimatedInputTokens!; estimate.outputTokens += budget.maxOutputTokens!
        estimate.maxInputTokens = Math.max(estimate.maxInputTokens, budget.estimatedInputTokens!)
        estimate.maxOutputTokens = Math.max(estimate.maxOutputTokens, budget.maxOutputTokens!)
      }
    }
    return estimate
  }
}

/** 核对补齐复用业务接受流程，产出只写新增元数据，保留旧成果原字节。 */
export function upgradeReviewRunner(bind: (hooks: ExecutionHooks) => AcceptanceBindings, options: BuildLayeredOptions): NonNullable<UpgradeOptions['runStep']> {
  return async (step, context) => {
    if (step.kind !== 'review') throw protocolError('UPGRADE_STEP_UNBOUND', '该补齐步骤需要对应业务服务：' + step.kind)
    const physical = await manifests(context.root), versions = await reviewManifests(context.root, physical)
    const state = await readUpgradeStatus(context.root)
    if (state?.id === context.runId) await assertReviewPlan(context.root, versions, state.steps)
    const activeStep = await narrowReviewStep(context.root, step, versions, physical)
    if (!activeStep || activeStep.id !== step.id) throw protocolError('UPGRADE_ROOT_CHANGED', '核对范围已变化，请重新进行升级预检。')
    const sources = reviewSources(versions, step)
    const exclusions = await reviewExclusions(context.root, versions, [step])
    const bindings = bind(context.hooks)
    const identity = upgradeReviewIdentity(bindings, physical, step, sources)
    const unitParent = reviewUnitParent(step, identity)
    const plans = await Promise.all(reviewUnitIds(step, exclusions).map(id => upgradeReviewUnit(context.root, versions, sources, unitParent, id)))
    const pending = { runId: context.runId, acceptedProtocol: 1 } as RecoveryPending
    return withRecovery(context.root, pending, { ...options, recovery: bindings, automaticRecovery: true, replayOnly: context.replayOnly }, async active => {
      const valid = validReviewStep(step, exclusions)
      const previous = await readAccepted(context.root, bindings, identity, valid)
      if (previous) assertReviewEvidence(previous.value, plans, active)
      const recovered = previous ? await recoverAccepted(identity, valid) : undefined
      const accepted = recovered ?? await executeAccepted(identity, async () => {
        const units: UpgradeUnitResult[] = []
        for (const [index, id] of reviewUnitIds(step, exclusions).entries()) {
          const planned = plans[index]!
          const saved = await recoverAccepted(planned.identity, planned.valid)
          const result = saved ?? await executeAccepted(planned.identity, async () => {
            const unit = planned.unit
            if (unit.kind === 'extraction') {
              const inputLimit = (await bindings.stageInputBudgets(step.stage, { system: '', input: '' }))[0]!.inputLimitBytes
              await reviewExtraction(unit.extraction, unit.source,
                { ...active, topics: { ...active.topics || {}, extractionReview: 'all' } }, inputLimit)
              const points = unit.extraction.segments.flatMap(segment => segment.points)
              if (points.some(point => point.verification?.status !== 'verified')) throw protocolError('UPGRADE_REVIEW_PAUSED', '升级提取核对尚未全部通过。')
              return { id, result: points.map(point => ({ point_id: point.point_id, verification: point.verification })) }
            }
            const reviewed = await reviewTopicContent(unit.topicId, unit.content, unit.points, { ...active, topics: { ...active.topics || {}, topicReview: true } }, undefined, false, unit.contexts)
            if (reviewed.failure || !reviewed.review || reviewed.review.removed.length || reviewed.content !== unit.content) throw protocolError('UPGRADE_REVIEW_PAUSED', '升级主题核对未通过；旧正文保持。')
            return { id, result: reviewed.review }
          }, planned.valid)
          units.push(result.value)
        }
        return { units }
      }, valid)
      if (!accepted.acceptedRef) throw protocolError('ACCEPTED_MISSING', '升级核对未形成可追溯的接受结果。')
      return accepted.acceptedRef
    }, false)
  }
}
const volatile = (file: string) => /(?:^|\/)(?:write\.lock|inventory-lock\.sqlite(?:-wal|-shm)?|readers\/[^/]+|[^/]+\.tmp)$/.test(file)
async function inventory(root: string, allFiles = false): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const entry of await readdir(root, { recursive: true, withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('升级备份不接受库内符号链接。')
    if (!entry.isFile()) continue
    const relative = path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/')
    if (allFiles || !volatile(relative)) files[relative] = hash(await readFile(await safePath(root, relative)))
  }
  return files
}
async function manifests(root: string): Promise<{ manifest: SnapshotManifest; checksum: string }[]> {
  const directory = await safePath(root, 'versions')
  const names = await readdir(directory).catch(error => { if (error.code === 'ENOENT') return []; throw error })
  const result: { manifest: SnapshotManifest; checksum: string }[] = []
  for (const name of names.filter(name => /^v\d{6,}\.json$/.test(name)).sort()) {
    const value = JSON.parse(await readFile(await safePath(root, `versions/${name}`), 'utf8'))
    if (!value.manifest || value.manifest.version !== name.slice(0, -5) || value.checksum !== hash(storageJson(value.manifest))) throw new Error('升级前主清单校验失败。')
    result.push(value)
  }
  return result
}
/** 物理清单仍完整保留；只投影读取、恢复发布所需的语义对象及其原上下文。 */
async function reviewManifests(root: string, physical: Awaited<ReturnType<typeof manifests>>) {
  try {
    const roots = await readRetentionRoots(root), result: typeof physical = []
    if (physical.length && !roots.versions.size && !roots.manifests.length && !roots.files.size) throw new Error('物理版本存在但读取和发布根全部缺失。')
    const add = (manifest: SnapshotManifest, building = false) => {
      if (building && !manifest.pages && !manifest.deps) manifest = { ...manifest, pages: {}, deps: { pages: {}, reverse: {} } }
      if (!Array.isArray(manifest.sources) || !manifest.deps || !manifest.pages) throw new Error('有效根缺少页面、来源或依赖清单。')
      const checksum = hash(storageJson(manifest))
      if (!result.some(value => value.checksum === checksum)) result.push({ manifest, checksum })
    }
    for (const version of roots.versions) {
      const value = physical.find(value => value.manifest.version === version) ?? roots.manifests.find(manifest => manifest.version === version)
      if (!value) throw new Error('有效根指向缺失版本：' + version)
      add('manifest' in value ? value.manifest : value, !('manifest' in value))
    }
    for (const manifest of roots.manifests) add(manifest, true)
    for (const file of roots.files) {
      const page = /^objects\/pages\/[a-f0-9]{64}\.md$/.test(file), snapshot = file.startsWith('objects/snapshots/')
      if (!page && !snapshot) continue
      const ownsSource = (source: SourceEntry) => source.extract.path === file || source.files.source === file
        || source.files.assets.some(asset => asset.path === file) || source.siyuan?.objects.some(object => object.path === file)
      const ownsPage = (digest: string) => file === `objects/pages/${digest.slice(7)}.md`
      const owners = roots.objectVersions.get(file)
      if (!owners && result.some(({ manifest }) => page ? Object.values(manifest.pages!).some(ownsPage) : manifest.sources.some(ownsSource))) continue
      let found = false
      for (const { manifest } of physical) {
        if (owners && !owners.has(manifest.version!)) continue
        const pages = Object.fromEntries(Object.entries(manifest.pages ?? {}).filter(([, digest]) => page && ownsPage(digest)))
        const dependencies = Object.fromEntries(Object.keys(pages).map(name => {
          const dependency = manifest.deps?.pages[name]
          if (!dependency) throw new Error('保留页面缺少依赖：' + name)
          return [name, dependency]
        }))
        const sourceIds = new Set(Object.values(dependencies).flatMap(dependency => dependency.sources))
        const sources = manifest.sources.filter(source => sourceIds.has(source.source_id) || !page && ownsSource(source))
        if (!Object.keys(pages).length && !sources.length) continue
        if ([...sourceIds].some(id => !sources.some(source => source.source_id === id))) throw new Error('保留页面缺少来源。')
        add({ ...manifest, pages, sources, deps: { ...manifest.deps!, pages: dependencies } }); found = true
      }
      if (!found) throw new Error('保留对象缺少完整来源上下文：' + file)
    }
    return result
  } catch (error) {
    throw protocolError('UPGRADE_ROOT_INCOMPLETE', '升级语义根不完整：' + (error instanceof Error ? error.message : String(error)))
  }
}
function reviewUnitParent(step: UpgradeStep, identity: TaskIdentity): TaskIdentity {
  const origin = step.reviewOrigin
  return origin ? { ...identity, scope: { ...identity.scope, unitId: origin.id }, inputDigest: origin.inputDigest,
    revocationGeneration: origin.revocationGeneration } : identity
}
async function narrowReviewStep(root: string, step: UpgradeStep, active: Awaited<ReturnType<typeof manifests>>, physical: Awaited<ReturnType<typeof manifests>>) {
  if (step.kind !== 'review') return step
  const eligible = new Set(active.flatMap(({ manifest }) => step.stage === 'extractionReview' ? manifest.sources.map(source => source.extract.path)
    : Object.entries(manifest.pages ?? {}).filter(([page]) => page.startsWith('topics/')).map(([, digest]) => `objects/pages/${digest.slice(7)}.md`)))
  const unitIds = step.unitIds.filter(id => eligible.has(id))
  if (!unitIds.length) return undefined
  if (unitIds.length === step.unitIds.length) return step
  const reviewOrigin = step.reviewOrigin ?? { id: step.id, inputDigest: step.inputDigest, revocationGeneration: physical[0]?.manifest.revocation_generation ?? 0 }
  const inputDigest = protocolDigest([reviewOrigin, await Promise.all(unitIds.map(async id => [id, hash(await readFile(await safePath(root, id)))]))])
  return { ...step, id: `${step.stage}:${inputDigest}`, unitIds, inputDigest, reviewOrigin }
}
const stepEstimate = (step: UpgradeStep): UpgradeEstimate => step.estimate ?? {
  calls: step.kind === 'review' ? step.unitIds.length : step.maxOutputTokens > 0 ? 1 : 0,
  inputTokens: step.estimatedInputTokens, outputTokens: step.maxOutputTokens * (step.kind === 'review' ? step.unitIds.length : 1),
}
function totalEstimate(steps: UpgradeStep[]): UpgradeEstimate {
  return steps.reduce((sum, step) => { const estimate = stepEstimate(step)
    return { calls: sum.calls + estimate.calls, inputTokens: sum.inputTokens + estimate.inputTokens, outputTokens: sum.outputTokens + estimate.outputTokens }
  }, { calls: 0, inputTokens: 0, outputTokens: 0 })
}
async function refreshReviewEstimates(root: string, steps: UpgradeStep[], options: UpgradeOptions, accepted: UpgradeStatus['accepted'] = {}) {
  if (!options.estimateReview) return
  for (const step of steps.filter(step => step.kind === 'review' && !accepted[step.id])) {
    const { maxInputTokens, maxOutputTokens, ...estimate } = await options.estimateReview(step, root)
    if ([maxInputTokens, maxOutputTokens, ...Object.values(estimate)].some(value => !Number.isSafeInteger(value) || value < 0))
      throw new Error('升级初轮请求估计无效。')
    step.estimatedInputTokens = maxInputTokens; step.maxOutputTokens = maxOutputTokens; step.estimate = estimate
  }
}
async function reviewCandidates(root: string, active: Awaited<ReturnType<typeof manifests>>) {
  const stages = new Map<StageId, { id: string; digest: string; tokens: number }[]>()
  const seen = new Set<string>()
  for (const { manifest } of active) {
    for (const source of manifest.sources) {
      const raw = await readFile(await safePath(root, source.extract.path), 'utf8'), extraction = JSON.parse(raw)
      // 已有结构可本地核验；缺少核对结果的单元才进入补齐清单。
      const missing = extraction.segments?.some((s: { points: { verification?: { status?: string } }[] }) => s.points.some(p => !p.verification))
      const digest = hash(raw)
      if (missing && !seen.has(digest)) {
        seen.add(digest)
        const values = stages.get('extractionReview') ?? []
        values.push({ id: source.extract.path, digest, tokens: Math.ceil(Buffer.byteLength(raw) / 4) }); stages.set('extractionReview', values)
      }
    }
    for (const [page, digest] of Object.entries(manifest.pages ?? {})) {
      const object = `objects/pages/${digest.slice(7)}.md`
      if (hash(await readFile(await safePath(root, object))) !== digest) throw new Error('有效页面对象摘要不符。')
      if (page.startsWith('topics/') && !manifest.deps?.pages[page]?.review && !seen.has(digest)) {
        seen.add(digest)
        const values = stages.get('topicReview') ?? []
        const evidenceBytes = (await Promise.all((manifest.deps?.pages[page]?.sources ?? []).map(async id => {
          const source = manifest.sources.find(source => source.source_id === id)
          if (!source) throw new Error('主题核对缺少来源证据：' + id)
          return (await stat(await safePath(root, source.extract.path))).size
        }))).reduce((sum, size) => sum + size, 0)
        values.push({ id: object, digest, tokens: Math.ceil(((await stat(await safePath(root, object))).size + evidenceBytes) / 4) }); stages.set('topicReview', values)
      }
    }
  }
  return stages
}
async function assertReviewPlan(root: string, active: Awaited<ReturnType<typeof manifests>>, steps: UpgradeStep[]) {
  const planned = new Set(steps.filter(step => step.kind === 'review').flatMap(step => step.unitIds.map(id => step.stage + ':' + id)))
  for (const [stage, units] of await reviewCandidates(root, active)) for (const unit of units) if (!planned.has(stage + ':' + unit.id))
    throw protocolError('UPGRADE_ROOT_CHANGED', '升级期间出现新的有效核对对象，请先核对范围：' + unit.id)
}
async function preflight(root: string, options: UpgradeOptions): Promise<Omit<UpgradeStatus, 'id' | 'backupPath'>> {
  const files = await inventory(root), reuse: ReuseItem[] = []
  const addReuse = async (logical: string, kind: ReuseItem['kind']) => {
    const physical = path.relative(root, await safePath(root, logical)).replaceAll('\\', '/')
    const digest = files[physical]
    if (!digest) throw new Error('升级前成果缺失：' + logical)
    if (!reuse.some(item => item.path === logical)) reuse.push({ path: logical, digest, kind, after: logical })
  }
  const physical = await manifests(root)
  for (const { manifest } of physical) {
    for (const source of manifest.sources) {
      await addReuse(source.extract.path, 'extraction')
    }
    for (const digest of Object.values(manifest.pages ?? {})) {
      const object = `objects/pages/${digest.slice(7)}.md`
      await addReuse(object, 'page')
      if (hash(await readFile(await safePath(root, object))) !== digest) throw new Error('旧页面对象摘要不符。')
    }
  }
  const stages = await reviewCandidates(root, await reviewManifests(root, physical))
  for (const file of Object.keys(files)) {
    if (/(?:^|\/)objects\/vectors\//.test(file)) await addReuse(file, 'vector')
    if (/(?:^|\/)work\/(?:pending\.json|extractions\/)/.test(file)) await addReuse(file, 'checkpoint')
  }
  const steps: UpgradeStep[] = structuredClone(options.steps ?? [])
  for (const [stage, units] of stages) {
    let batch: typeof units = [], tokens = 0
    const flush = () => {
      if (!batch.length) return
      const inputDigest = protocolDigest(batch.map(unit => [unit.id, unit.digest]))
      if (!options.estimateReview) throw protocolError('UPGRADE_ESTIMATE_UNBOUND', '升级核对需要与执行共用的阶段预估器。')
      steps.push({ id: `${stage}:${inputDigest}`, kind: 'review', stage, unitIds: batch.map(unit => unit.id), inputDigest, estimatedInputTokens: 0, maxOutputTokens: 0 })
      batch = []; tokens = 0
    }
    for (const unit of units) {
      if (batch.length >= 20 || tokens + unit.tokens + 1000 > (options.inputLimitTokens ?? Infinity)) flush()
      batch.push(unit); tokens += unit.tokens
    }
    flush()
  }
  await refreshReviewEstimates(root, steps, options)
  if (steps.filter(step => step.kind === 'summary').length > 1 || new Set(steps.filter(step => step.kind === 'gap').flatMap(step => step.unitIds)).size > 5
    || new Set(steps.map(step => step.id)).size !== steps.length) throw new Error('升级补齐清单超出 IF-53 边界。')
  for (const step of steps) {
    if (!['summary', 'review', 'gap', 'metadata'].includes(step.kind) || !step.unitIds.length || step.kind === 'review' && step.unitIds.length > 20
      || !Number.isSafeInteger(step.estimatedInputTokens) || step.estimatedInputTokens < 0 || !Number.isSafeInteger(step.maxOutputTokens) || step.maxOutputTokens < 0) throw new Error('升级预检步骤无效。')
  }
  return { status: 'prepared', reason: null, originalFormat: '0.2.x', inputDigest: protocolDigest(files), files, reuse, steps, accepted: {},
    estimate: totalEstimate(steps),
    limits: { ...options.upgrade }, actual: { calls: 0, tokens: 0, unknownUsage: 0 }, reuseRates: { extraction: null, page: null, vector: null, checkpoint: null } }
}
export async function verifyUpgradeBackup(backupPath: string): Promise<BackupMetadata> {
  const meta = await readProtocol<BackupMetadata>(backupPath, backupMetadata, 'UPGRADE_BACKUP_CORRUPT')
  if (!meta?.complete) throw protocolError('UPGRADE_BACKUP_CORRUPT', '备份未完成，不能恢复。')
  for (const [file, digest] of Object.entries(meta.files)) if (hash(await readFile(await safePath(backupPath, file))) !== digest) throw protocolError('UPGRADE_BACKUP_CORRUPT', '备份校验失败：' + file)
  if (protocolDigest(meta.files) !== meta.inputDigest) throw protocolError('UPGRADE_BACKUP_CORRUPT', '备份清单摘要不符。')
  return meta
}
function verifyBackupIdentity(root: string, backupPath: string, meta: BackupMetadata | undefined, libraryId: string | null): asserts meta is BackupMetadata {
  const corrupt = () => protocolError('UPGRADE_BACKUP_CORRUPT', '升级备份身份或清单无效：' + backupPath)
  if (!meta || typeof meta.id !== 'string' || !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(meta.id)
    || meta.root !== root || meta.libraryId !== libraryId || typeof meta.complete !== 'boolean'
    || !path.basename(backupPath).endsWith('-' + meta.id) || !meta.upgrade || meta.upgrade.id !== meta.id
    || meta.upgrade.backupPath !== backupPath || !meta.files || typeof meta.files !== 'object' || Array.isArray(meta.files)) throw corrupt()
  for (const [file, digest] of Object.entries(meta.files)) if (path.isAbsolute(file) || file.includes('\\') || file.includes('\0')
    || file.split('/').some(part => !part || part === '.' || part === '..') || !/^sha256:[a-f0-9]{64}$/.test(digest)) throw corrupt()
  if (protocolDigest(meta.files) !== meta.inputDigest || meta.upgrade.inputDigest !== meta.inputDigest
    || !meta.upgrade.files || canonicalJson(meta.upgrade.files) !== canonicalJson(meta.files)) throw corrupt()
}
async function finishBackup(root: string, backupPath: string, meta: BackupMetadata, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  const copied = await inventory(backupPath, true)
  delete copied[backupMetadata]
  if (Object.keys(copied).some(file => !(file in meta.files))) throw protocolError('UPGRADE_BACKUP_CORRUPT', '未完成备份含清单外文件。')
  for (const [file, digest] of Object.entries(copied)) if (digest !== meta.files[file]) throw protocolError('UPGRADE_BACKUP_CORRUPT', '备份校验失败：' + file)
  for (const [file, digest] of Object.entries(meta.files)) {
    signal?.throwIfAborted()
    if (copied[file]) continue
    const source = await safePath(root, file), target = await safePath(backupPath, file)
    if (hash(await readFile(source)) !== digest) throw protocolError('UPGRADE_INPUT_CHANGED', '备份期间源文件变化：' + file)
    await mkdir(path.dirname(target), { recursive: true }); await copyFile(source, target)
    if (hash(await readFile(target)) !== digest) throw protocolError('UPGRADE_INPUT_CHANGED', '备份期间源文件变化：' + file)
  }
  // 已复用的文件和复制期间新增、删除的输入也必须复核，完整标记不能先于原库校验。
  if (protocolDigest(await inventory(root)) !== meta.inputDigest) throw protocolError('UPGRADE_INPUT_CHANGED', '备份期间原库清单变化。')
  signal?.throwIfAborted()
  meta.complete = true
  await writeProtocol(backupPath, backupMetadata, meta)
  await verifyUpgradeBackup(backupPath)
}
export async function readUpgradeStatus(root: string): Promise<UpgradeStatus | undefined> { return readProtocol(root, checkpoint, 'UPGRADE_CHECKPOINT_CORRUPT') }
async function completeUpgrade(root: string, state: UpgradeStatus): Promise<UpgradeStatus> {
  const total = (await readRunCosts(root, state.id)).total
  state.actual = { calls: total.calls, tokens: usageTokens(total.usage) + total.reservedTokens, unknownUsage: total.unknownUsage }
  const position = '；备份：' + state.backupPath
  const previous = await readFile(await safePath(root, 'logs/build.md'), 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error))
  // 备份路径含稳定升级身份；兼容旧收尾行，日志成功而检查点失败时不重复追加。
  if (!previous.split(/\r?\n/).some(line => line.endsWith(position) && (line.startsWith('- 升级 complete；') || line.startsWith('- 升级收尾完成；'))))
    await appendLog(root, `\n- 升级 complete；${state.steps.length} 个接受步骤；初轮请求估计 ${state.estimate.calls} 次、输入 ${state.estimate.inputTokens}/输出额度 ${state.estimate.outputTokens} token（含已确定分块，不含依赖输出的合并、纠正和重试）；实际 ${total.calls} 次${position}\n`)
  if (state.status !== 'complete' || state.reason !== null) {
    state.status = 'complete'; state.reason = null
    await writeProtocol(root, checkpoint, state)
  }
  return state
}
export async function upgradeLibrary(root: string, options: UpgradeOptions = {}): Promise<UpgradeStatus | undefined> {
  root = path.resolve(root)
  const policyFile = await safePath(root, '.llmwiki/policy.json')
  const rawPolicy = await readFile(policyFile, 'utf8'), policy = JSON.parse(rawPolicy)
  if (policy.libraryFormat === '0.3.0') {
    const state = await readUpgradeStatus(root)
    if (state && state.status !== 'complete') {
      for (const { manifest, checksum } of await manifests(root)) {
        await readProvenance(root, manifest.version!, checksum)
        await readVersionCosts(root, manifest.version!, checksum)
      }
    }
    return state ? completeUpgrade(root, state) : state
  }
  policySchema.parse(policy)
  for (const value of Object.values(options.upgrade ?? {})) if (!Number.isSafeInteger(value) || value < 0) throw new Error('升级上限必须为非负整数。')
  let state = await readUpgradeStatus(root)
  if (state) state.estimate = totalEstimate(state.steps)
  const initial = state ?? { ...await preflight(root, options), id: '', backupPath: '' }
  if (state) await options.onStatus?.(structuredClone(initial))
  return withLibraryLock(root, 'upgrade-0.3.0', async () => {
    if (!state) {
      const current = await preflight(root, options)
      if (current.inputDigest !== initial.inputDigest) throw protocolError('UPGRADE_INPUT_CHANGED', '升级预检后输入变化，请重新估算。')
      const prefix = path.basename(root) + '.backup-before-0.3.0-'
      const identity = JSON.parse(await readFile(await safePath(root, '.llmwiki/library.json'), 'utf8').catch(error => { if (error.code === 'ENOENT') return '{}'; throw error }))
      const candidates: { path: string; meta: BackupMetadata }[] = []
      for (const entry of await readdir(path.dirname(root), { withFileTypes: true })) {
        if (!entry.name.startsWith(prefix)) continue
        if (!entry.isDirectory() || entry.isSymbolicLink()) throw protocolError('UPGRADE_BACKUP_CORRUPT', '升级备份目录无效：' + entry.name)
        const candidate = path.join(path.dirname(root), entry.name)
        const meta = await readProtocol<BackupMetadata>(candidate, backupMetadata, 'UPGRADE_BACKUP_CORRUPT')
        verifyBackupIdentity(root, candidate, meta, identity.libraryId ?? null)
        if (meta.complete) {
          const unchanged = await Promise.all(Object.entries(meta.files).filter(([file]) => !/(?:^|\/)logs\/build\.md$/.test(file))
            .map(async ([file, digest]) => hash(await readFile(await safePath(root, file)).catch(() => Buffer.alloc(0))) === digest))
          if (!unchanged.every(Boolean)) continue
          await verifyUpgradeBackup(candidate)
        } else {
          if (meta.inputDigest !== current.inputDigest || canonicalJson(meta.files) !== canonicalJson(current.files))
            throw protocolError('UPGRADE_INPUT_CHANGED', '未完成升级备份的原库输入已变化。')
          const { id: _id, backupPath: _path, limits, ...saved } = meta.upgrade
          const { limits: _limits, ...fresh } = current
          if (!limits || typeof limits !== 'object' || Array.isArray(limits)
            || Object.entries(limits).some(([key, value]) => !['maxCalls', 'maxTokens'].includes(key) || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
            || canonicalJson(saved) !== canonicalJson(fresh)) throw protocolError('UPGRADE_BACKUP_CORRUPT', '未完成备份的升级计划或零调用状态不符。')
        }
        candidates.push({ path: candidate, meta })
      }
      if (candidates.length > 1) throw protocolError('UPGRADE_BACKUP_AMBIGUOUS', '存在多个可承接的升级备份，请先核对原升级身份。')
      let meta = candidates[0]?.meta
      if (meta) Object.assign(initial, structuredClone(meta.upgrade))
      else {
        initial.id = randomUUID()
        initial.backupPath = path.join(path.dirname(root), prefix + new Date().toISOString().replace(/[:.]/g, '-') + '-' + initial.id)
      }
      // 原身份已确定；预检通知仍不把尚未提交检查点的备份宣告为就绪。
      await options.onStatus?.({ ...structuredClone(initial), backupPath: '' })
      options.signal?.throwIfAborted()
      if (!meta) {
        await mkdir(initial.backupPath)
        meta = { id: initial.id, root, libraryId: identity.libraryId ?? null, inputDigest: current.inputDigest, files: current.files, complete: false, upgrade: structuredClone(initial) }
        await writeProtocol(initial.backupPath, backupMetadata, meta)
      }
      if (!meta.complete) await finishBackup(root, initial.backupPath, meta, options.signal)
      options.signal?.throwIfAborted()
      state = initial
      await writeProtocol(root, checkpoint, state)
    }
    const currentState = state
    await verifyUpgradeBackup(currentState.backupPath)
    if (options.upgrade !== undefined) currentState.limits = { ...options.upgrade }
    const report = async (status: UpgradeStatus['status'], reason: string | null) => {
      if (status === 'complete') {
        await completeUpgrade(root, currentState)
        await options.onStatus?.(structuredClone(currentState))
        return currentState
      }
      const total = (await readRunCosts(root, currentState.id)).total
      currentState.status = status; currentState.reason = reason
      currentState.actual = { calls: total.calls, tokens: usageTokens(total.usage) + total.reservedTokens, unknownUsage: total.unknownUsage }
      await writeProtocol(root, checkpoint, currentState)
      await appendLog(root, `\n- 升级 ${status}；${currentState.steps.length} 个接受步骤；初轮请求估计 ${currentState.estimate.calls} 次、输入 ${currentState.estimate.inputTokens}/输出额度 ${currentState.estimate.outputTokens} token（含已确定分块，不含依赖输出的合并、纠正和重试）；实际 ${total.calls} 次；备份：${currentState.backupPath}${reason ? '；' + reason : ''}\n`)
      await options.onStatus?.(structuredClone(currentState))
      return currentState
    }
    await report('prepared', '升级开始或重入')
    const hooks = createExecutionLedger(root, currentState.limits)
    try {
      const physical = await manifests(root), active = await reviewManifests(root, physical)
      for (const [file, digest] of Object.entries(currentState.files)) if (/(?:^|\/)(?:state\/(?:current|reading-copy)\.json|work\/(?:pending|preview)\.json|conflicts\/.*\.json)$/.test(file)
        && hash(await readFile(await safePath(root, file))) !== digest) throw protocolError('UPGRADE_ROOT_CHANGED', '升级期间读取或发布根发生变化：' + file)
      await assertReviewPlan(root, active, currentState.steps)
      const narrowed = await Promise.all(currentState.steps.map(step => narrowReviewStep(root, step, active, physical)))
      // 计划收缩只改变剩余核对；原升级、备份、接受记录与尝试账本保持。
      currentState.steps = narrowed.filter((step): step is UpgradeStep => step !== undefined)
      const exclusions = await reviewExclusions(root, active, currentState.steps)
      for (const [id, previous] of Object.entries(currentState.reviewExclusions ?? {})) if (currentState.steps.some(step => step.unitIds.includes(id))
        && (!exclusions[id] || canonicalJson(previous) !== canonicalJson(exclusions[id]))) throw protocolError('UPGRADE_ROOT_CHANGED', '归档占位排除依据发生变化：' + id)
      if (Object.keys(exclusions).length) currentState.reviewExclusions = { ...currentState.reviewExclusions, ...exclusions }
      currentState.estimate = totalEstimate(currentState.steps)
      await writeProtocol(root, checkpoint, currentState)
      // 新协议显式保存单元身份及输入摘要；接受提交早于升级检查点时精确恢复。
      const acceptanceNames = await readdir(await safePath(root, 'logs/model-accepts')).catch(error => { if (error.code === 'ENOENT') return []; throw error })
      for (const name of acceptanceNames.filter(name => /^[a-f0-9]{64}\.json$/.test(name))) {
        const accepted = await hooks.readAcceptance('t:' + name.slice(0, -5))
        if (accepted.status === 'missing' || !accepted.acceptedAttemptIds.every(id => id.startsWith(`a:${currentState.id}:`))) continue
        const step = currentState.steps.find(s => s.id === accepted.record.identity.scope.unitId && s.inputDigest === accepted.record.identity.inputDigest && s.stage === accepted.record.identity.stage)
        if (!step) continue
        if (accepted.status === 'prepared') {
          if (!options.runStep) return report('paused', '接受准备已保存，等待接受端恢复提交。')
          const replayHooks: ExecutionHooks = { ...hooks, beforeAttempt: async () => ({ status: 'paused', reason: '升级恢复禁止重新调用模型。' }), onDispatch: async () => { throw new Error('升级恢复禁止派发。') } }
          await options.runStep(step, { root, runId: currentState.id, hooks: replayHooks, replayOnly: true })
        }
        const bound = await hooks.readAcceptance(accepted.taskId)
        if (bound.status !== 'bound') throw new Error('升级准备结果尚未恢复接受提交。')
        await hooks.onAccepted({ prepareId: bound.prepareId, taskId: bound.taskId, acceptedDigest: bound.acceptedDigest! })
        currentState.accepted[step.id] = { taskId: bound.taskId, path: `work/accepted/tasks/${bound.taskId.slice(2)}.json`, digest: bound.acceptedDigest! }
      }
      for (const step of currentState.steps.filter(step => step.kind === 'review' && currentState.accepted[step.id])) {
        if (!options.runStep) throw protocolError('UPGRADE_STEP_UNBOUND', '升级核对接受结果需要业务校验。')
        const ref = await options.runStep(step, { root, runId: currentState.id, hooks, replayOnly: true })
        if (canonicalJson(ref) !== canonicalJson(currentState.accepted[step.id])) throw protocolError('ACCEPT_CONFLICT', '升级核对接受引用不符。')
      }
      await refreshReviewEstimates(root, currentState.steps, options, currentState.accepted)
      currentState.estimate = totalEstimate(currentState.steps)
      await writeProtocol(root, checkpoint, currentState)
      const localOnly = (step: UpgradeStep) => step.kind === 'review' && !reviewUnitIds(step, exclusions).length
      const remaining = currentState.steps.filter(step => !currentState.accepted[step.id] && !localOnly(step))
      const remainingEstimate = totalEstimate(remaining)
      if (currentState.limits.maxCalls !== undefined && currentState.actual.calls + remainingEstimate.calls > currentState.limits.maxCalls
        || currentState.limits.maxTokens !== undefined && currentState.actual.tokens + remainingEstimate.inputTokens + remainingEstimate.outputTokens > currentState.limits.maxTokens) return report('paused', '初轮预计用量超过用户设置的升级上限。')
      for (const step of currentState.steps) {
        options.signal?.throwIfAborted()
        if (currentState.accepted[step.id] || localOnly(step)) continue
        if (step.estimatedInputTokens > (options.inputLimitTokens ?? Infinity)) return report('paused', '完整证据超出候选输入窗口。')
        if (!options.runStep) return report('paused', '升级补齐执行器尚未提供，旧版本继续可读。')
        const stepHooks: ExecutionHooks = { ...hooks, beforeAttempt: async request => {
          if (request.runId !== currentState.id || request.stage !== step.stage) throw new Error('升级请求不属于预检步骤或累计预算。')
          return hooks.beforeAttempt(request)
        } }
        const ref = await options.runStep(step, { root, runId: currentState.id, hooks: stepHooks, replayOnly: false })
        const prepared = await hooks.readAcceptance(ref.taskId)
        if (prepared.status !== 'bound' || prepared.acceptedDigest !== ref.digest) throw new Error('升级补齐尚未通过 IF-50/51 接受。')
        if (prepared.record.identity.scope.unitId !== step.id || prepared.record.identity.inputDigest !== step.inputDigest || prepared.record.identity.stage !== step.stage) throw new Error('补齐接受记录不属于预检单元。')
        currentState.accepted[step.id] = ref
        await writeProtocol(root, checkpoint, currentState)
      }
      for (const { manifest, checksum } of await manifests(root)) {
        const provenance = await legacyProvenance(root, manifest, checksum)
        for (const [id, exclusion] of Object.entries(exclusions)) {
          if (!Object.values(manifest.pages ?? {}).includes(exclusion.objectDigest)) continue
          const metadata = { target: id, fields: ['review-exclusion'], value: exclusion }
          const artifact = { kind: 'metadata' as const, objectPath: null, objectDigest: protocolDigest(metadata), pagePath: null,
            sourceRefs: [], status: 'local-derived' as const, productionIds: [], inheritedFrom: null, metadata }
          provenance.artifacts[artifactId(artifact)] = artifact
        }
        for (const [stepId, ref] of Object.entries(currentState.accepted)) {
          const step = currentState.steps.find(s => s.id === stepId)
          if (!step) continue
          const accepted = await hooks.readAcceptance(ref.taskId)
          if (accepted.status !== 'bound' || accepted.acceptedDigest !== ref.digest) throw new Error('升级接受结果损坏。')
          if (step.kind === 'gap') continue
          const raw = await readFile(await safePath(root, accepted.record.output.path))
          if (hash(raw) !== accepted.record.output.digest) throw new Error('升级补齐输出摘要不符。')
          const value = accepted.record.output.encoding === 'utf8-json' ? JSON.parse(raw.toString('utf8')) : raw.toString('utf8')
          const targets = step.kind === 'review' ? (value as { units: UpgradeUnitResult[] }).units.map(unit => unit.id) : step.unitIds
          const metadata = { target: targets.join(','), fields: [step.kind], value }
          const artifact = { kind: 'metadata' as const, objectPath: null, objectDigest: protocolDigest(metadata), pagePath: null,
            sourceRefs: sortedUnique(accepted.record.identity.scope.sourceRefs), status: 'recorded' as const, productionIds: sortedUnique(Object.keys(accepted.record.productions)), inheritedFrom: null, metadata }
          provenance.artifacts[artifactId(artifact)] = artifact; Object.assign(provenance.records, accepted.record.productions)
        }
        await writeProvenance(root, provenance)
        await writeVersionCosts(root, manifest.version!, checksum, [currentState.id], null, manifest.cost_report ?? '旧用量未知')
        await readProvenance(root, manifest.version!, checksum); await readVersionCosts(root, manifest.version!, checksum)
      }
      for (const item of currentState.reuse) if (hash(await readFile(await safePath(root, item.after))) !== item.digest) throw new Error('升级复用成果变化：' + item.path)
      for (const [file, digest] of Object.entries(currentState.files)) {
        if (/(?:^|\/)logs\/build\.md$/.test(file)) continue
        if (hash(await readFile(await safePath(root, file))) !== digest) throw protocolError('UPGRADE_INPUT_CHANGED', '升级期间原库文件变化：' + file)
      }
      for (const kind of Object.keys(currentState.reuseRates) as ReuseItem['kind'][]) currentState.reuseRates[kind] = currentState.reuse.some(item => item.kind === kind) ? 1 : null
      if (await readFile(policyFile, 'utf8') !== rawPolicy) throw protocolError('UPGRADE_INPUT_CHANGED', '升级期间策略发生变化。')
      await atomicWrite(root, '.llmwiki/policy.json', canonicalJson({ ...policy, libraryFormat: '0.3.0' }) + '\n')
      return report('complete', null)
    } catch (error) {
      await report('paused', error instanceof Error ? error.message : String(error))
      throw error
    }
  })
}

/** 恢复时保留整个失败现场；调用方须已停止所有写入端。 */
export async function restoreUpgradeBackup(root: string, backupPath: string): Promise<string> {
  root = path.resolve(root); backupPath = path.resolve(backupPath)
  const meta = await verifyUpgradeBackup(backupPath)
  if (meta.root !== root || path.dirname(root) !== path.dirname(backupPath)) throw new Error('备份与待恢复库不匹配。')
  const stage = root + '.restore-' + randomUUID(), failed = root + '.failed-upgrade-' + randomUUID()
  await mkdir(stage)
  for (const file of Object.keys(meta.files)) {
    const target = await safePath(stage, file); await mkdir(path.dirname(target), { recursive: true }); await copyFile(await safePath(backupPath, file), target)
  }
  for (const [file, digest] of Object.entries(meta.files)) if (hash(await readFile(await safePath(stage, file))) !== digest) throw new Error('恢复暂存校验失败。')
  await rename(root, failed)
  try { await rename(stage, root) } catch (error) { await rename(failed, root); throw error }
  return failed
}
