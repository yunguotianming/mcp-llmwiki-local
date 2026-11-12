import { z } from 'zod'
import type { LibraryPolicy } from './policy.js'
export const policySchema = z.strictObject({
  version: z.literal(1), wikiLanguage: z.string().trim().min(1), useCustomWikiLanguage: z.boolean(),
  concurrencyLimit: z.number().int().min(1).max(1000).default(50),
  pageGenerationConcurrency: z.number().int().min(1).max(1000), analysisConcurrency: z.number().int().min(1).max(1000),
  batchDelayMs: z.number().int().min(0).max(3600000), ingestRequestTimeoutSeconds: z.number().int().min(1).max(86400),
  maxTokensPerCall: z.number().int().min(0).max(1000000), advancedSettingsMode: z.enum(['default', 'custom']),
  contextWindowTokens: z.union([z.literal(0),z.literal(64000),z.literal(128000),z.literal(256000),z.literal(512000),z.literal(1000000)]).default(0),
  disableThinking: z.boolean(), extractionTemperature: z.number().min(0).max(2).nullable(), chatTemperature: z.number().min(0).max(2).nullable(), reasoningEffort: z.string(),
  extractionGranularity: z.enum(['minimal', 'coarse', 'balanced', 'standard', 'detailed', 'fine', 'custom']), customEntityLimit: z.number().int().min(1).max(1000), customConceptLimit: z.number().int().min(1).max(1000),
  customPointLimit: z.number().int().min(1).max(500).optional(),
  tagVocabularyMode: z.enum(['auto', 'custom']), customEntityTags: z.array(z.string()), customConceptTags: z.array(z.string()),
  startupCheckNoticeLevel: z.enum(['off', 'errors', 'all']), autoWatchSources: z.boolean(), autoWatchMode: z.enum(['notify', 'auto']), autoWatchDebounceMs: z.number().int().min(100).max(3600000),
  periodicLint: z.enum(['off', 'daily', 'weekly']), autoSmartFix: z.boolean(), automaticOperations: z.array(z.enum(['ingest', 'update', 'repair'])),
  showAdvancedSettings: z.boolean().default(false),
  maxConversationHistory: z.number().int().min(1).max(1000), queryInstructions: z.string().max(10000).default(''), slugCase: z.enum(['lower', 'preserve']), minAliasLength: z.number().int().min(2).max(6), createWelcomeNote: z.boolean(), skipMentionOnlyCandidates: z.boolean(), createStubsForUnresolvableLinks: z.boolean(),
  lintJaccardLinkThreshold: z.number().min(0).max(1), lintJaccardBodyGate: z.number().min(0).max(1), lintBigramThreshold: z.number().min(0).max(1), lintDedupIncludeSources: z.boolean(), imageStrategy: z.enum(['on-demand', 'all', 'text-only']),
}).superRefine((policy, context) => {
  for (const key of ['analysisConcurrency', 'pageGenerationConcurrency'] as const) if (policy[key] > policy.concurrencyLimit) {
    context.addIssue({ code: 'custom', path: [key], message: `不能超过并发上限 ${policy.concurrencyLimit}。` })
  }
}) satisfies z.ZodType<LibraryPolicy>
