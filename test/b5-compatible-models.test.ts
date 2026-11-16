import { expect, it, vi } from 'vitest'
import { emptyModels, emptyRegistry, newLibrary, resolveModel } from '../src/domain/config.js'
import { exportConfig, registrySchema } from '../src/domain/config-io.js'
import { defaultPolicy } from '../src/domain/policy.js'
import { compatibleRuntime } from '../src/host/compatible-models.js'
import { modelRuntime, createBuildStageResolver } from '../src/host/models.js'
import { ModelClient } from '../src/llm/client.js'
import { buildStages } from '../src/domain/route-schema.js'
import type { BuildModels } from '../src/domain/route-schema.js'
import { createLocalHost } from '../src/local/host.js'

it.each(['openai-completions', 'openai-responses'] as const)('%s 建库、查询与视觉请求使用同一协议适配，usage 不重复计算缓存', async api => {
  const request = vi.fn(async () => Response.json(api === 'openai-responses'
    ? { id: 'response', model: '实际模型', status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '完成' }] }], usage: { input_tokens: 12, output_tokens: 3, input_tokens_details: { cached_tokens: 4 } } }
    : { id: 'response', model: '实际模型', choices: [{ message: { content: '完成' }, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 3, prompt_tokens_details: { cached_tokens: 4 } } }))
  const runtime = compatibleRuntime({ 'compatible:a': { baseUrl: 'https://offline.invalid/v1', model: '任意模型', api, apiKey: 'secret-test', inputModalities: ['text', 'image'] } }, { request, imageUrl: async () => 'data:image/png;base64,AA==' })
  const library = newLibrary('test'); library.models = emptyModels(); library.models.unified = { provider: 'compatible:a', model: '任意模型' }
  library.models.query = library.models.unified; library.models.vision = library.models.unified
  const client = new ModelClient(runtime, library, { ...defaultPolicy(), batchDelayMs: 0 })
  expect(await client.call('ingest', '系统', '资料')).toBe('完成')
  expect(await client.call('query', '系统', '查询')).toBe('完成')
  expect(await client.call('vision', '系统', '看图', undefined, [{ type: 'image', attachment: {} as never }])).toBe('完成')
  expect(client.attempts[0]).toMatchObject({ usage: { inputTokens: 8, cacheReadTokens: 4, outputTokens: 3 }, reportedModel: '实际模型', requestId: 'response' })
  for (const [url, init] of request.mock.calls as unknown as [string, RequestInit][]) {
    expect(url).toBe('https://offline.invalid/v1/' + (api === 'openai-responses' ? 'responses' : 'chat/completions'))
    expect(init.headers).toMatchObject({ authorization: 'Bearer secret-test' })
    expect(JSON.parse(String(init.body)).model).toBe('任意模型')
  }
  expect(JSON.stringify(request.mock.calls[2])).toContain('data:image/png;base64,AA==')
})

it('明文和环境密钥不出现在传输异常、错误响应或成功回显中，导出不带明文', async () => {
  const key = 'secret-do-not-log', registry = emptyRegistry()
  registry.compatibleProviders = { 'compatible:a': { baseUrl: 'https://offline.invalid/v1', model: 'a', api: 'openai-completions', apiKey: key },
    'compatible:b': { baseUrl: 'https://offline.invalid/v1', model: 'b', api: 'openai-responses', apiKeyEnv: 'TEST_SECRET' } }
  expect(exportConfig(registry)).not.toContain(key)
  const request = vi.fn().mockRejectedValueOnce(new Error(key, { cause: { authorization: key } })).mockResolvedValueOnce(new Response(key, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ status: 'completed', model: key, id: key, output: [{ type: 'message', content: [{ type: 'output_text', text: key }] }] }))
  const host = createLocalHost(registry, { request, env: { TEST_SECRET: key } })
  const events = []
  for (const model of ['a', 'b', 'b']) for await (const event of host.runtime.stream({ provider: 'compatible:' + model, model, messages: [{ role: 'user', content: [{ type: 'text', text: '输入' }] }] })) events.push(event)
  expect(JSON.stringify(events)).not.toContain(key)
  expect(JSON.stringify(events.map(event => host.runtime.responseMetadata?.(event)))).not.toContain(key)
  expect(host.failure(new Error(key))).toEqual({ code: 'LIBRARY_ERROR', message: '[已脱敏]' })
  expect(JSON.stringify(host.failure(Object.assign(new Error(key, { cause: key }), { upgrade: { reason: key, backupPath: key } })))).not.toContain(key)
  expect(() => registrySchema.parse({ ...registry, compatibleProviders: { 'compatible:a': { ...registry.compatibleProviders['compatible:a'], apiKeyEnv: 'TEST_SECRET' } } })).toThrow()
})

it('相同策略在 dsh 与 local 得到相同候选，宿主公开能力提供阶段解析', async () => {
  const registry = emptyRegistry(), library = newLibrary('test'); library.wikiPath = '/tmp/wiki'
  const config = { baseUrl: 'https://offline.invalid/v1', model: 'any', api: 'openai-responses' as const }
  registry.compatibleProviders = { 'compatible:a': config }
  registry.modelExecution = { globalMaxInFlight: 3, lineBindings: { selected: { provider: 'compatible:a', quotaGroupId: 'account', maxConcurrency: 2 } }, quotaGroups: { account: { maxConcurrency: 3 } } }
  const buildModels: BuildModels = { version: 1, reuseAccepted: true, stages: Object.fromEntries(buildStages.map(stage => [stage, { selection: 'failover', candidates: [{ line: 'selected', model: 'any' }] }])) as BuildModels['stages'], retry: { maxAttempts: 2, maxAttemptsPerLine: 1, deadlineMs: 30000 } }
  const policy = { ...defaultPolicy(), buildModels }, request = vi.fn(() => { throw new Error('禁止网络') })
  const native = { listProviders: () => [{ id: 'native', name: '原生' }], listModels: async () => [], resolveModelInfo: async () => ({ provider: 'native', id: 'native', name: '原生', context: { contextWindow: 32768 }, defaultMaxTokens: 4096 }), async *stream() {} }
  const dsh = modelRuntime(native, registry, { request }), local = createLocalHost(registry, { request })
  for (const stage of buildStages) expect(await createBuildStageResolver(registry, library, policy, dsh.resolveBuildModel!)(stage))
    .toEqual(await createBuildStageResolver(registry, library, policy, local.runtime.resolveBuildModel!)(stage))
  expect((await dsh.resolveBuildModel!('native', 'native', 'native')).qualityEvidence).toEqual([])
  expect(request).not.toHaveBeenCalled()
})

it('查询与视觉显式选择独立于统一模型及建库阶段策略', () => {
  const models = emptyModels(); models.unified = { provider: 'build', model: 'build' }; models.query = { provider: 'query', model: 'q' }; models.vision = { provider: 'vision', model: 'v' }
  expect(resolveModel(models, 'query')).toEqual(models.query)
  expect(resolveModel(models, 'vision')).toEqual(models.vision)
  expect(resolveModel(models, 'ingest')).toEqual(models.unified)
})
