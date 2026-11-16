import { buildStages } from '../src/domain/route-schema.js'
import type { BuildModels, ModelExecution, StageId } from '../src/domain/route-schema.js'
import type { CandidateModel, ResolvedParameters } from '../src/domain/stage-policy.js'
export function stagePolicy(): BuildModels {
  const single = (line: string) => ({ selection: 'failover' as const, candidates: [{ line, model: 'terra', parameters: { reasoningEffort: 'high' } }] })
  return { version: 1, stages: { extract: { selection: 'priority-spillover', candidates: [{ line: 'flash', model: 'flash' }, ...single('terra').candidates] },
    extractionReview: single('review-extract'), topicReview: single('review-topic'), topic: single('terra'), parent: single('terra'), term: single('terra'), rewrite: single('terra') },
    retry: { maxAttempts: 4, maxAttemptsPerLine: 2, deadlineMs: 1200000 }, reuseAccepted: true }
}
export function hostExecution(): ModelExecution {
  return { globalMaxInFlight: 1000, lineBindings: Object.fromEntries(['flash', 'terra', 'review-extract', 'review-topic'].map(line => [line,
    { provider: 'offline', quotaGroupId: 'account', maxConcurrency: 3 }])), quotaGroups: { account: { maxConcurrency: 6, rpm: 60, tpm: 1000000 } } }
}
export function candidateModel(model = 'terra'): CandidateModel {
  const defaults: ResolvedParameters = { reasoningEffort: model === 'terra' ? 'high' : 'runtime-default', temperature: 'runtime-default', maxOutputTokens: 4096 }
  return { resolvedModel: model, endpointRevision: 'endpoint-v1', credentialRevision: 'credential-v1', defaultsRevision: 'defaults-v1', defaults,
    capabilities: { contextWindowTokens: 131072, maxOutputTokens: 32768, inputModalities: ['text'], reasoningEfforts: ['high'],
      structuredOutput: 'prompt-validated', streaming: true, source: '离线能力夹具', validationRevision: 'cap-v1', temperature: { min: 0, max: 2 } },
    priceSnapshot: null, qualityEvidence: (model === 'flash' ? ['extract'] as StageId[] : [...buildStages]).map(stage => ({ stage, model, parameters: defaults, reference: '离线验收/' + stage })) }
}
export const resolveCandidate = async (_provider: string, model: string) => candidateModel(model)
