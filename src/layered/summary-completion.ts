import { readFile } from 'node:fs/promises'
import { AsyncLocalStorage } from 'node:async_hooks'
import { z } from 'zod'
import { layeredSettings } from '../domain/config.js'
import { jsonProtocol, schemaJSON } from '../llm/protocol.js'
import { safePath } from '../storage/paths.js'
import { hash } from './files.js'
import { canonicalJson, mergeModels, protocolDigest, protocolError, validateAcceptedRecord } from './models.js'
import { withTaskReplay } from './extraction-cache.js'
import { synthesizeSourceSummary } from './longdoc.js'
import { storageJson } from './vectors.js'
import type { SummaryRecoveryState } from './longdoc.js'
import type { AcceptedTaskSpec } from './accepted.js'
import type { BuildLayeredOptions, Extraction, SourceEntry, SummaryCompletionProof } from './schema.js'

function fail(): never { throw protocolError('PROVENANCE_INCOMPLETE', '摘要补缺组合无法从原接受结果严格重放。') }
const same = (a: unknown, b: unknown): boolean => canonicalJson(a) === canonicalJson(b)
const bodyIdentity = (source: SourceEntry) => {
  const { extract, models: _models, updated_at: _updated, ...identity } = source
  const { path: _path, processing_fingerprint: _fingerprint, processing } = extract
  const { model: _model, ...rules } = processing
  return { ...identity, processing: rules }
}
const summaryRef = (value: unknown) => (value as { acceptedRef?: import('./schema.js').AcceptedRef } | undefined)?.acceptedRef
const settingKeys = ['sourceSummaryFanout', 'sourceSummaryMaxPoints', 'sourcePointBaseChars', 'sourcePointMaxMultiplier', 'sourceChapterMinPoints', 'sourceLongChapterChars'] as const

// 接受记录和原始 JSON 输出随证明内嵌，读端重放不依赖已被 GC 的 work 或模型目录。
export async function summaryCompletionProof(root: string, source: SourceEntry, baseSource: SourceEntry, baseVersion: string,
  refs: import('./schema.js').AcceptedRef[], settings = layeredSettings({}, source.extract.processing.tier), reextractGeneration = 0): Promise<SummaryCompletionProof> {
  const { createExecutionLedger } = await import('./costs.js')
  const ledger = createExecutionLedger(root), identity = JSON.parse(await readFile(await safePath(root, '.llmwiki/library.json'), 'utf8')) as { libraryId: string }
  const baseManifest = await (await import('./objects.js')).readVersion(root, baseVersion, false)
  const creationGeneration = (JSON.parse(await readFile(await safePath(root, 'state/revocations.json'), 'utf8')) as { generation: number }).generation
  const accepted: SummaryCompletionProof['accepted'] = []
  for (const ref of refs) {
    const snapshot = await ledger.readAcceptance(ref.taskId)
    if (snapshot.status !== 'bound' || snapshot.acceptedDigest !== ref.digest || snapshot.record.identity.reextractGeneration !== reextractGeneration
      || snapshot.record.identity.revocationGeneration !== creationGeneration) fail()
    const bytes = await readFile(await safePath(root, snapshot.record.output.path))
    if (hash(bytes) !== snapshot.record.output.digest || bytes.length !== snapshot.record.output.bytes) fail()
    accepted.push({ ref, record: snapshot.record, output: bytes.toString('utf8') })
  }
  return { libraryId: identity.libraryId, baseVersion, baseSource: structuredClone(baseSource), reextractGeneration, creationGeneration,
    baseManifestChecksum: hash(storageJson(baseManifest)), settings: Object.fromEntries(settingKeys.map(key => [key, settings[key]])) as SummaryCompletionProof['settings'], accepted }
}

export async function replaySummaryCompletion(root: string, before: Extraction, after: Extraction, source: SourceEntry,
  proof: SummaryCompletionProof, generation: number, baseManifestText?: string): Promise<Record<string, import('./schema.js').ProductionRecord>> {
  const identity = JSON.parse(await readFile(await safePath(root, '.llmwiki/library.json'), 'utf8')) as { libraryId: string }
  let baseManifest: import('./schema.js').SnapshotManifest
  try { baseManifest = JSON.parse(baseManifestText!) as import('./schema.js').SnapshotManifest } catch { fail() }
  if (!proof || !same(Object.keys(proof).sort(), ['accepted', 'baseManifestChecksum', 'baseSource', 'baseVersion', 'creationGeneration', 'libraryId', 'reextractGeneration', 'settings'])
    || !proof.libraryId || proof.libraryId !== identity.libraryId || !/^v\d{6,}$/.test(proof.baseVersion)
    || baseManifest.version !== proof.baseVersion || hash(baseManifestText!) !== proof.baseManifestChecksum
    || baseManifest.sources.filter(entry => entry.source_id === source.source_id).length !== 1
    || !same(baseManifest.sources.find(entry => entry.source_id === source.source_id), proof.baseSource)
    || !same(Object.keys(proof.settings).sort(), [...settingKeys].sort())
    || !Number.isSafeInteger(proof.reextractGeneration) || proof.reextractGeneration < 0
    || !Number.isSafeInteger(proof.creationGeneration) || proof.creationGeneration < baseManifest.revocation_generation || proof.creationGeneration > generation
    || !same(bodyIdentity(proof.baseSource), bodyIdentity(source)) || before.source_id !== source.source_id || after.source_id !== source.source_id
    || before.source_hash !== source.content_hash || after.source_hash !== source.content_hash || !before.chunk_plan?.length
    || !same(before.segments, after.segments) || !same(before.chunk_plan, after.chunk_plan)) fail()
  const expected = structuredClone(before) as Extraction & SummaryRecoveryState, child = after as Extraction & SummaryRecoveryState
  const records: Record<string, import('./schema.js').ProductionRecord> = {}, entries = new Map<string, SummaryCompletionProof['accepted'][number]>()
  const sourceRefs = [{ sourceId: source.source_id, sourceVersion: source.source_version }]
  for (const entry of proof.accepted) {
    const { ref, record, output } = entry
    validateAcceptedRecord(record)
    if (!same(Object.keys(entry).sort(), ['output', 'record', 'ref']) || entries.has(ref.taskId)
      || ref.taskId !== record.taskId || ref.digest !== protocolDigest(record)
      || ref.path !== 'work/accepted/tasks/' + ref.taskId.slice(2) + '.json'
      || record.identity.scope.libraryId !== proof.libraryId || !same(record.identity.scope.sourceRefs, sourceRefs)
      || record.identity.revocationGeneration !== proof.creationGeneration || record.identity.reextractGeneration !== proof.reextractGeneration
      || record.identity.operation !== 'sourceSummary' || record.identity.stage !== 'extract'
      || record.output.encoding !== 'utf8-json' || typeof output !== 'string' || hash(output) !== record.output.digest
      || Buffer.byteLength(output) !== record.output.bytes) fail()
    entries.set(ref.taskId, entry); Object.assign(records, record.productions)
  }
  if (!entries.size) fail()
  for (const { record } of entries.values()) for (const dependency of record.dependencies) {
    const parent = entries.get(dependency.taskId)
    if (!parent || parent.ref.digest !== dependency.acceptedDigest || !same(parent.record.identity.scope.sourceRefs, dependency.sourceRefs)) fail()
  }
  const consumed = new Set<string>(), requestBytes: number[] = []
  const dependencyScopes = new AsyncLocalStorage<Set<string>>()
  const plans = structuredClone(child.summary_plans ?? {}), usedPlans = new Set<string>()
  if (Object.entries((before as Extraction & SummaryRecoveryState).summary_plans ?? {}).some(([key, plan]) => !same(plan, plans[key] ?? null))) fail()
  expected.summary_plans = new Proxy(plans, { get(target, key, receiver) {
    if (typeof key === 'string' && Object.hasOwn(target, key)) usedPlans.add(key)
    return Reflect.get(target, key, receiver) as unknown
  } })
  const replay = async (stage: string, spec: AcceptedTaskSpec, work: () => Promise<unknown>, valid: (value: unknown) => boolean) => {
    const parentScope = dependencyScopes.getStore(), dependencyIds = new Set((spec.dependencies ?? []).map(ref => ref.taskId))
    const entry = [...entries.values()].find(entry => entry.record.identity.scope.unitId === spec.unitId)
    if (!entry) {
      // 无模型的单支或全缺口节点由原合成器派生；原校验未通过的空节点也不能冒充接受。
      const value = await dependencyScopes.run(dependencyIds, work)
      for (const id of dependencyIds) parentScope?.add(id)
      return { value, reused: true }
    }
    const dependencies = (spec.dependencies ?? []).map(ref => {
      const parent = entries.get(ref.taskId)
      if (!parent || !same(ref, parent.ref)) fail()
      return { taskId: ref.taskId, outputDigest: parent.record.output.digest }
    })
    const actual = entry.record.identity
    const task = { version: 1, scope: { libraryId: proof.libraryId, unitId: spec.unitId, sourceRefs: spec.sourceRefs }, stage,
      operation: spec.operation, inputDigest: protocolDigest({ input: spec.input, dependencies }), promptDigest: protocolDigest(spec.prompt), schemaDigest: protocolDigest(spec.schema),
      validatorVersion: spec.validatorVersion, semanticVersion: spec.semanticVersion, groupPlanDigest: spec.groupPlan === undefined ? null : protocolDigest(spec.groupPlan),
      revocationGeneration: proof.creationGeneration, reextractGeneration: proof.reextractGeneration }
    const output = JSON.parse(entry.output) as unknown
    if (!same(task, actual) || !valid(output)) fail()
    consumed.add(entry.ref.taskId)
    const block = /^(.*)\/block\/([^/]+)$/.exec(spec.unitId.slice(source.source_id.length + 1))
    const split = block && Object.keys(plans).some(key => key.startsWith(block[1]! + '/') && key.endsWith('/split/' + block[2]!))
    if (spec.groupPlan && Array.isArray(spec.groupPlan) || split) {
      const assembled = await dependencyScopes.run(dependencyIds, work)
      if (!same(assembled, output)) fail()
    }
    const expectedDependencies = [...dependencyIds].sort((a, b) => a.localeCompare(b)).map(id => {
      const parent = entries.get(id)
      if (!parent) fail()
      return { taskId: id, acceptedDigest: parent.ref.digest, sourceRefs: parent.record.identity.scope.sourceRefs }
    })
    const inheritedProductions = Object.assign({}, ...[...dependencyIds].map(id => entries.get(id)!.record.productions))
    const directProductions = Object.fromEntries(Object.entries(entry.record.productions).filter(([, record]) => record.taskId === entry.ref.taskId))
    if (!same(entry.record.dependencies, expectedDependencies) || !same(entry.record.productions, { ...inheritedProductions, ...directProductions })) fail()
    parentScope?.add(entry.ref.taskId)
    const direct = Object.values(entry.record.productions).filter(record => record.taskId === entry.ref.taskId)
    if (direct.length) {
      const input = spec.input as { request?: string; input?: string }
      if (typeof spec.prompt !== 'string' || typeof (input.request ?? input.input) !== 'string') fail()
      requestBytes.push(...direct.map(() => Buffer.byteLength(spec.prompt as string) + Buffer.byteLength((input.request ?? input.input)!)))
    }
    return { value: structuredClone(output), reused: true, acceptedRef: entry.ref }
  }
  const { excludeEmptySourceSummary, outputSchema } = await import('./extraction.js')
  const { parseModelJson } = await import('../llm/json.js')
  let groupsChanged = false
  for (const [key, group] of Object.entries(before.group_cache ?? {})) {
    if (!group.missing_summary || child.group_cache?.[key]?.missing_summary !== false) continue
    const raw = outputSchema.parse(parseModelJson(group.raw, schemaJSON(outputSchema)))
    if (excludeEmptySourceSummary(expected, key, raw.points)) continue
    const members = before.segments.flatMap(segment => segment.points).filter(point => raw.points.some(item => item.text === point.text
      && item.evidence.every(evidence => point.evidence.some(saved => saved.quote === evidence.quote && saved.locator === evidence.locator))))
    const schema = z.object({ point_ids: z.array(z.string()).min(1).max(proof.settings.sourceSummaryMaxPoints) })
    const prompt = jsonProtocol('从本组已校验要点选择摘要。只返回输入中的 point_ids，不修改要点或证据，数量不超过 point_limit。', schemaJSON(schema))
    const request = JSON.stringify({ source_id: source.source_id, summary_id: key, point_limit: proof.settings.sourceSummaryMaxPoints,
      children: [{ id: key, points: members.map(point => ({ point_id: point.point_id, text: point.text })) }] })
    const dependencies = summaryRef(group) ? [summaryRef(group)!].filter(ref => entries.has(ref.taskId)) : []
    const receipt = await replay('extract', { unitId: source.source_id + '/group-summary/' + key, sourceRefs, operation: 'sourceSummary', input: { request }, prompt,
      schema: schemaJSON(schema), validatorVersion: 'source-summary-v1', semanticVersion: 'source-summary-v1', dependencies }, async () => fail(), value => {
      const ids = (value as { ids?: string[] })?.ids
      return !!ids?.length && ids.length <= proof.settings.sourceSummaryMaxPoints && new Set(ids).size === ids.length && ids.every(id => members.some(point => point.point_id === id))
    })
    const selected = receipt.value as { ids: string[]; models: import('../domain/config.js').ModelRef[] }
    expected.group_cache![key]!.missing_summary = false; expected.group_cache![key]!.summary_models = selected.models
    expected.group_summaries![key] = { id: key, point_ids: selected.ids, models: selected.models, missing: [], level: 0, children: [], fingerprint: hash(JSON.stringify([key, selected.ids])), acceptedRef: receipt.acceptedRef } as import('./schema.js').SourceSummary
    expected.gaps = expected.gaps?.filter(gap => gap.kind !== 'summary' || !gap.segment_hashes.length || !gap.segment_hashes.every(digest => group.parts.some(part => part.text_hash === digest))) ?? []
    groupsChanged = true
  }
  if (!groupsChanged) fail()
  const noModel = async (): Promise<never> => fail()
  const settings = layeredSettings(proof.settings, before.processing.tier)
  const options = { knowledgeRoot: root, client: { call: noModel, info: noModel, concurrency: () => 1 }, topics: settings } as BuildLayeredOptions
  await withTaskReplay(proof.accepted.map(entry => entry.ref), replay, () => synthesizeSourceSummary(expected, Object.keys(expected.group_summaries ?? {}), options,
    settings, Infinity, async () => {}, () => true))
  if (consumed.size !== entries.size || Object.keys(plans).some(key => !same(plans[key], (before as Extraction & SummaryRecoveryState).summary_plans?.[key] ?? null) && !usedPlans.has(key))) fail()
  const extractionCalls = before.calls.slice(0, before.calls.length - (before.summary_calls?.length ?? 0))
  const delta = [...(after.summary_calls ?? [])]
  if (!same(after.calls, [...extractionCalls, ...(after.summary_calls ?? [])])) fail()
  for (const call of before.summary_calls ?? []) { const index = delta.findIndex(item => same(item, call)); if (index < 0) fail(); delta.splice(index, 1) }
  if (!same(delta.map(call => call.input_bytes).sort((a, b) => a - b), requestBytes.sort((a, b) => a - b))
    || !same(after.summary_calls ?? [], [...(after.summary_calls ?? [])].sort((a, b) => a.input_bytes - b.input_bytes || a.input_limit - b.input_limit))
    || delta.some(call => !Number.isFinite(call.input_limit) || call.input_limit < call.input_bytes)) fail()
  expected.calls = structuredClone(after.calls); expected.summary_calls = structuredClone(after.summary_calls ?? [])
  expected.models = mergeModels(before.models, ...proof.accepted.map(entry => (JSON.parse(entry.output) as { models?: import('../domain/config.js').ModelRef[] }).models))
  if (expected.models[0]) { expected.actual_model = expected.models[0].provider + '/' + expected.models[0].model; expected.processing.model = expected.actual_model }
  for (const field of ['in_progress', 'completed_chunks', 'chunk_results', 'chunk_calls', 'chunk_quotas', 'pending_chunk_plan', 'summary_pending', 'reextractGeneration'] as const) delete (expected as unknown as Record<string, unknown>)[field]
  if (!same(expected, after)) fail()
  return records
}
