import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { emptyModels, emptyRegistry } from '../src/domain/config.js'
import { buildStages } from '../src/domain/route-schema.js'
import type { BuildModels } from '../src/domain/route-schema.js'
import { modelRuntime } from '../src/host/models.js'
import { WikiOperations } from '../src/host/wiki-operations.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { safePath } from '../src/storage/paths.js'
import { WikiQuery } from '../src/wiki/query.js'
import { askWiki } from '../src/wiki/chat.js'
import { loadLocalHost } from '../src/local/host.js'
import { createMcpHandler } from '../src/mcp/server.js'
import { readVersion } from '../src/layered/objects.js'
import { cleanupLayeredFixtures, layeredFixture, modelOutput } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => { cleanupLayeredFixtures(); vi.unstubAllGlobals() })

it.each(['dsh-host', 'dsh-manual', 'dsh-completions', 'local-plain', 'local-env'] as const)('%s 建库、查询、暂停换模型续跑，记录实际选择且库目录无凭据', async source => {
  const f = await layeredFixture(), key = 'b5-secret-' + source, registry = emptyRegistry(), local = source.startsWith('local'), api = source === 'local-env' || source === 'dsh-manual' ? 'openai-responses' : 'openai-completions'
  const provider = source === 'dsh-host' ? 'native' : 'compatible:custom'
  f.library.wikiPath = f.root; f.library.sourceRoots = [f.knowledgeRoot]; f.library.models = emptyModels()
  f.library.models.unified = { provider, model: 'alpha' }; f.library.models.query = { provider, model: 'alpha' }
  f.library.layered = { embeddingMode: 'none', pointLabelsOnBuild: false, topicMergeMinSources: 99, termThreshold50: 99, extractionReview: 'off', topicReview: false }
  f.library.queryUnderstanding = { enabled: true, model: { provider, model: 'alpha' } }
  registry.activeLibraryId = f.library.id; registry.libraries = [f.library]
  registry.modelExecution = { globalMaxInFlight: 3, lineBindings: { primary: { provider, quotaGroupId: 'account', maxConcurrency: 2 } }, quotaGroups: { account: { maxConcurrency: 3 } } }
  if (source !== 'dsh-host') registry.compatibleProviders = { [provider]: { baseUrl: 'https://models.invalid/v1', model: 'alpha', api,
    ...(source === 'local-env' ? { apiKeyEnv: 'B5_TEST_KEY' } : { apiKey: key }) } }
  const stageModels = (model: string): BuildModels => ({ version: 1, reuseAccepted: true,
    stages: Object.fromEntries(buildStages.map(stage => [stage, { selection: 'failover', candidates: [{ line: 'primary', model }] }])) as BuildModels['stages'],
    retry: { maxAttempts: 2, maxAttemptsPerLine: 1, deadlineMs: 30000 } })
  let stopping: AbortController | undefined
  const observed: { model: string; input: string }[] = []
  const output = (model: string, text: string) => {
    observed.push({ model, input: text })
    if (!text.startsWith('{')) return JSON.stringify({ variants: ['研究方法资料'] })
    if (stopping && text.includes('待续跑资料')) { stopping.abort(new Error('用户暂停')); stopping = undefined; throw new Error(key) }
    const input = JSON.parse(text)
    if (input.tiers) return JSON.stringify(Object.fromEntries(input.tiers.map((tier: string) => [tier, '研究方法资料'])))
    if (input.question) return JSON.stringify({ answer: '资料支持研究方法。[1]', citations: [1] })
    const value = JSON.parse(modelOutput(input)); if (value.terms) value.terms = []
    return JSON.stringify(value)
  }
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    expect(init?.headers).toMatchObject({ authorization: 'Bearer ' + key })
    const body = JSON.parse(String(init?.body)), messages = body.input ?? body.messages
    const text = output(body.model, messages.at(-1).content[0].text)
    return Response.json(api === 'openai-responses' ? { status: 'completed', model: body.model, output: [{ type: 'message', content: [{ type: 'output_text', text }] }] }
      : { model: body.model, choices: [{ message: { content: text }, finish_reason: 'stop' }] })
  })
  const native = { listProviders: () => [{ id: provider, name: provider }], listModels: async () => [{ provider, id: 'alpha', name: 'alpha' }, { provider, id: 'beta', name: 'beta' }],
    resolveModelInfo: async (_provider: string, model: string) => ({ provider, id: model, name: model, context: { contextWindow: 32768 }, defaultMaxTokens: 4096 }),
    async *stream(options: any) { yield { type: 'text-delta' as const, index: 0, text: output(options.model, options.messages[0].content[0].text) }; yield { type: 'finish' as const, reason: { kind: 'stop' as const } } } }
  const configFile = path.join(f.knowledgeRoot, 'mcp-config.json')
  await writeFile(configFile, JSON.stringify(registry))
  const host = local ? await loadLocalHost(configFile, { request, env: { B5_TEST_KEY: key } }) : undefined
  const store = host?.store ?? new LibraryStore(() => registry)
  const getRuntime = () => host?.runtime ?? modelRuntime(native, registry, { request })
  const operations = host?.operations ?? new WikiOperations(store, getRuntime, new Map())
  const view = await store.initialize(f.library.id)
  await store.savePolicy(f.library.id, { ...view.policy, batchDelayMs: 0, libraryFormat: '0.3.0', buildModels: stageModels('alpha') }, view.revision)
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '研究方法具有完整的原始资料依据。')
  const commit = async (result: any) => {
    expect(result.status).toBe('preview')
    const preview = await operations.changes(f.library.id, 'preview', new AbortController().signal, result.batchId)
    await operations.changes(f.library.id, 'commit', new AbortController().signal, result.batchId, (preview as any).digest)
  }
  const built = await operations.generate(f.library.id, 'generate', new AbortController().signal) as any
  await commit(built)
  if (host) expect(host.store.registration(f.library.id).summaryStatus).toBe('ready')
  const before = await readVersion(f.root, built.version), extraction = await readFile(await safePath(f.root, before.sources[0]!.extract.path))
  const search = await new WikiQuery(store, undefined, getRuntime).search('研究方法', f.library.name)
  expect(search.understanding.status).toBe('generated')
  expect(search.results.length).toBeGreaterThan(0)
  const answer = await askWiki(store, f.library.id, '研究方法', [], getRuntime())
  expect(answer.answer).toContain('[1]')
  expect(answer.citations[0]!.segments!.length).toBeGreaterThan(0)
  expect(answer.answerGuidance).toContain('未核实')
  expect(observed.some(item => item.input.includes('"segments"') && item.input.includes('"question"'))).toBe(true)
  const status = await operations.productionStatus(f.library.id)
  expect(status.artifacts.flatMap(item => item.productions).some(record => record.requestedModel === 'alpha' && record.stage === 'extract')).toBe(true)
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '待续跑资料说明新的研究方法。')
  const abort = new AbortController(); stopping = abort
  await expect(operations.generate(f.library.id, 'generate', abort.signal)).rejects.toThrow()
  expect(JSON.stringify(await store.policy(f.library.id))).not.toContain(key)
  if (registry.compatibleProviders) registry.compatibleProviders[provider]!.model = 'beta'
  f.library.models.query = { provider, model: 'beta' }; f.library.queryUnderstanding!.model = { provider, model: 'beta' }
  if (host) { registry.libraries = [f.library]; await writeFile(configFile, JSON.stringify(registry)); await host.reload() }
  const current = await store.policy(f.library.id)
  await operations.savePolicy(f.library.id, { ...current.policy, buildModels: stageModels('beta') }, current.revision, JSON.stringify(store.registration(f.library.id)))
  const count = observed.length
  const resumed = await operations.generate(f.library.id, 'generate', new AbortController().signal) as any
  await commit(resumed)
  expect(observed.slice(count).every(item => item.model === 'beta')).toBe(true)
  expect(observed.slice(count).filter(item => item.input.includes('研究方法具有完整的原始资料依据。') && item.input.includes('paragraphs'))).toHaveLength(0)
  expect(await readFile(await safePath(f.root, before.sources[0]!.extract.path))).toEqual(extraction)
  if (host) { await writeFile(configFile, JSON.stringify(registry)); await host.reload() }
  expect((await new WikiQuery(store, undefined, getRuntime).search('研究方法', f.library.name)).understanding.status).toBe('generated')
  expect(observed.at(-1)?.model).toBe('beta')
  const text = []
  for (const entry of await readdir(f.root, { recursive: true, withFileTypes: true })) if (entry.isFile()) text.push((await readFile(path.join(entry.parentPath, entry.name))).toString('utf8'))
  expect(text.join('\n')).not.toContain(key)
  if (host) {
    const response = await createMcpHandler(host)({ id: 1, method: 'tools/call', params: { name: 'wiki_status', arguments: { libraryId: f.library.id } } })
    expect(JSON.stringify(response)).toContain('beta'); expect(JSON.stringify(response)).not.toContain(key)
    host.dispose()
  }
}, 60000)
