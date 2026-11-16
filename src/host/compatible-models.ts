import type { GenerateOptions, ImageBlock, LlmResolvedModelInfo, StreamChunk, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { CompatibleProviders } from '../domain/route-schema.js'
import { compatibleProvidersSchema } from '../domain/route-schema.js'
import { executionDigest } from '../domain/stage-policy.js'
import type { CandidateModel } from '../domain/stage-policy.js'
import type { ModelRuntime } from '../llm/client.js'
import type { ResponseMetadata } from '../llm/detailed-client.js'
import { redactSecrets, resolveCredential } from '../llm/credentials.js'

export interface CompatibleRuntimeOptions {
  request?: typeof fetch
  env?: NodeJS.ProcessEnv
  imageUrl?: (image: ImageBlock) => Promise<string>
}

/** 两种协议共用确定的宿主快照；不依赖供应商登记、远端模型目录或额外 SDK。 */
export function compatibleRuntime(value: CompatibleProviders, options: CompatibleRuntimeOptions = {}) {
  const providers = structuredClone(compatibleProvidersSchema.parse(value)), request = options.request ?? fetch
  const keys = new Map(Object.entries(providers).map(([id, config]) => [id, resolveCredential(config, options.env)]))
  const secrets = [...keys.values()], clean = (text: string) => redactSecrets(text, secrets)
  const metadata = new WeakMap<object, ResponseMetadata>()
  const configFor = (provider: string, model: string) => {
    const config = providers[provider]
    if (!config || config.model !== model) throw new Error('兼容模型未在本机配置。')
    return config
  }
  const info = async (provider: string, model: string): Promise<LlmResolvedModelInfo> => {
    const config = configFor(provider, model)
    return { provider, id: model, name: model, context: { contextWindow: config.contextWindowTokens ?? 32768 },
      defaultMaxTokens: config.maxOutputTokens ?? 4096, inputModalities: config.inputModalities ?? ['text'],
      ...(config.reasoningEfforts?.length ? { reasoning: { efforts: config.reasoningEfforts.map(id => ({ id: id as NonNullable<LlmResolvedModelInfo['reasoning']>['efforts'][number]['id'], name: id })) } } : {}) }
  }
  const runtime: ModelRuntime & { listProviders(): { id: string; name: string }[]; listModels(provider: string): Promise<LlmResolvedModelInfo[]> } = {
    listProviders: () => Object.keys(providers).map(id => ({ id, name: id.slice('compatible:'.length) + '（手填接口）' })),
    listModels: async provider => providers[provider] ? [await info(provider, providers[provider]!.model)] : [],
    resolveModelInfo: info,
    resolveBuildModel: async (provider, model) => {
      const config = configFor(provider, model), resolved = await info(provider, model)
      return { resolvedModel: model, endpointRevision: executionDigest({ baseUrl: config.baseUrl, api: config.api }), credentialRevision: 'host-managed-v1',
        defaultsRevision: 'compatible-v1', defaults: { maxOutputTokens: resolved.defaultMaxTokens! }, priceSnapshot: null, qualityEvidence: [],
        capabilities: { contextWindowTokens: resolved.context!.contextWindow, maxOutputTokens: resolved.defaultMaxTokens!,
          inputModalities: config.inputModalities ?? ['text'], reasoningEfforts: config.reasoningEfforts ?? [],
          structuredOutput: 'prompt-validated', streaming: false, source: '本机兼容接口配置（未声明时采用保守窗口）', validationRevision: 'compatible-v1', temperature: { min: 0, max: 2 } } }
    },
    supportsStructuredOutput: () => false,
    responseMetadata: event => metadata.get(event),
    async *stream(input: GenerateOptions): AsyncGenerator<StreamChunk> {
      const config = configFor(input.provider, input.model), responses = config.api === 'openai-responses'
      let failureCode = 'CONFIG_ERROR'
      try {
        input.signal?.throwIfAborted()
        const messages = []
        for (const message of input.messages) {
          const content: Record<string, unknown>[] = []
          for (const block of message.content) {
            if (block.type === 'text') content.push({ type: responses ? 'input_text' : 'text', text: block.text })
            else if (block.type === 'image') {
              if (!config.inputModalities?.includes('image') || !options.imageUrl) throw new Error('视觉模型缺少图片能力或宿主图片读取接口。')
              const url = await options.imageUrl(block)
              content.push(responses ? { type: 'input_image', image_url: url } : { type: 'image_url', image_url: { url } })
            } else throw new Error('兼容模型请求包含不支持的内容类型。')
          }
          messages.push({ role: message.role, content })
        }
        const body = { model: input.model, stream: false,
          ...(responses ? { instructions: input.system, input: messages } : { messages: [...(input.system ? [{ role: 'system', content: input.system }] : []), ...messages] }),
          ...(input.maxTokens ? responses ? { max_output_tokens: input.maxTokens } : { max_tokens: input.maxTokens } : {}),
          ...(input.temperature === undefined ? {} : { temperature: input.temperature }),
          ...(input.reasoningEffort ? responses ? { reasoning: { effort: input.reasoningEffort } } : { reasoning_effort: input.reasoningEffort } : {}) }
        const key = keys.get(input.provider)!
        failureCode = 'TRANSPORT'
        const response = await request(config.baseUrl.replace(/\/+$/, '') + (responses ? '/responses' : '/chat/completions'), {
          method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json', ...(key ? { authorization: 'Bearer ' + key } : {}) },
          body: JSON.stringify(body), ...(input.signal ? { signal: input.signal } : {}) })
        if (!response.ok) {
          // 不读取错误正文；网关可能回显整个请求和 Authorization。
          const failure = { message: `兼容模型请求失败（HTTP ${response.status}）。`, code: response.status === 429 ? 'RATE_LIMIT' : 'HTTP_ERROR', status: response.status }
          const event: StreamChunk = { type: 'finish', reason: { kind: 'error', failure } }
          const retry = response.headers.get('retry-after')
          const delay = retry === null ? NaN : /^\d+(\.\d+)?$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()
          if (Number.isFinite(delay) && delay >= 0) Object.assign(failure, { providerRetryAfterMs: delay })
          yield event; return
        }
        let value: WireResponse
        try { value = await response.json() as WireResponse }
        catch (error) { if (!(error instanceof TypeError)) failureCode = 'INVALID_RESPONSE'; throw error }
        failureCode = 'INVALID_RESPONSE'
        if (value.error) throw new Error('模型返回错误响应。')
        const text = responses ? value.output?.flatMap(item => item.type === 'message' ? item.content?.filter(part => part.type === 'output_text').map(part => part.text ?? '') ?? [] : []).join('') ?? ''
          : value.choices?.[0]?.message?.content ?? ''
        const stopped = responses ? value.status === 'completed' : value.choices?.[0]?.finish_reason === 'stop'
        if (typeof text !== 'string') throw new Error('模型响应正文格式无效。')
        if (text) yield { type: 'text-delta', index: 0, text: clean(text) }
        const usage = wireUsage(value.usage, responses)
        if (usage) yield { type: 'usage', usage }
        const finish: StreamChunk = { type: 'finish', reason: stopped ? { kind: 'stop' } : { kind: 'error', failure: { code: 'INCOMPLETE_RESPONSE', message: '模型响应未完整结束。' } } }
        metadata.set(finish, { ...(typeof value.model === 'string' ? { reportedModel: clean(value.model) } : {}),
          ...(typeof value.id === 'string' ? { requestId: clean(value.id) } : {}) })
        yield finish
      } catch {
        // 原始异常、cause、请求头和响应体一律不越过凭据边界。
        yield { type: 'finish', reason: { kind: input.signal?.aborted ? 'aborted' : 'error', failure: {
          code: input.signal?.aborted ? 'ABORTED' : failureCode, message: input.signal?.aborted ? '模型请求已取消。' : '兼容模型请求或响应解析失败。' } } }
      }
    },
  }
  return runtime
}

interface WireResponse {
  id?: string; model?: string; status?: string; error?: unknown
  choices?: { finish_reason?: string; message?: { content?: string } }[]
  output?: { type: string; content?: { type: string; text?: string }[] }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; input_tokens?: number; output_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number }; input_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number }; output_tokens_details?: { reasoning_tokens?: number } }
}
function wireUsage(usage: WireResponse['usage'], responses: boolean): TokenUsage | undefined {
  if (!usage) return
  const total = responses ? usage.input_tokens : usage.prompt_tokens, output = responses ? usage.output_tokens : usage.completion_tokens
  const cached = (responses ? usage.input_tokens_details : usage.prompt_tokens_details)?.cached_tokens ?? 0
  if (![total, output, cached].every(n => Number.isSafeInteger(n) && n! >= 0) || cached > total!) return
  return { inputTokens: total! - cached, outputTokens: output!, cacheReadTokens: cached,
    ...((responses ? usage.output_tokens_details : usage.completion_tokens_details)?.reasoning_tokens === undefined ? {} : {
      reasoningTokens: (responses ? usage.output_tokens_details : usage.completion_tokens_details)!.reasoning_tokens! }) }
}

/** dsh 公开目录足以提供阶段能力；缺少窗口时保持可定位的能力错误。 */
export async function hostCandidate(runtime: ModelRuntime, provider: string, model: string, signal?: AbortSignal): Promise<CandidateModel> {
  const info = await runtime.resolveModelInfo(provider, model, signal)
  if (!info.context?.contextWindow || !info.defaultMaxTokens) throw new Error('宿主模型未声明上下文窗口或输出上限，请在宿主模型设置中补齐。')
  return { resolvedModel: info.id, endpointRevision: executionDigest({ provider, model: info.id }), credentialRevision: 'host-managed-v1', defaultsRevision: 'host-directory-v1',
    defaults: { maxOutputTokens: info.defaultMaxTokens, ...(info.reasoning?.defaultEffort ? { reasoningEffort: info.reasoning.defaultEffort } : {}) }, qualityEvidence: [], priceSnapshot: null,
    capabilities: { contextWindowTokens: info.context.contextWindow, maxOutputTokens: info.defaultMaxTokens, inputModalities: [...info.inputModalities ?? ['text']],
      reasoningEfforts: info.reasoning?.efforts.map(item => item.id) ?? [], structuredOutput: 'prompt-validated', streaming: true,
      source: '宿主公开模型目录', validationRevision: 'host-directory-v1' } }
}
