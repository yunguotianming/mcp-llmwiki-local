import type { GenerateOptions, ImageBlock, LlmRuntime, LlmResolvedModelInfo, TokenUsage } from '@deepseek-ai/dsh-llm'
import type { LayeredModelTask, LibraryRegistration, ModelRef, Task } from '../domain/config.js'
import { defaultProviderProfile, providerProfile, resolveLayeredModel, resolveModel } from '../domain/config.js'
import type { LibraryPolicy } from '../domain/policy.js'
import { CallGate, modelGate, providerGate } from './scheduler.js'
import { jsonProtocol, registerStructuredSchema, strictSchema } from './protocol.js'
import { contextWindowLimit, topicInputBudget } from './context.js'
export type ModelRuntime = Pick<LlmRuntime, 'resolveModelInfo' | 'stream'> & {
  supportsStructuredOutput?: (provider: string, model: string) => boolean
  supportsCacheMode?: (provider: string, model: string) => boolean
}
export interface ModelCallOptions { operation?: LayeredModelTask; reasoningEffort?: string; structuredSchema?: { name: string; schema: unknown }; structuredSchemaKind?: 'extraction' | 'correction' | 'review' | 'summary' | 'topic' | 'term' | 'tag' | 'query'; beforeAttempt?: () => void; onAttempt?: (attempt: ModelAttempt) => void }
export interface ModelFailureOutput { rawOutput: string; diagnostics?: string; outputPath?: string }
export interface ModelAttempt { route: ModelRef; startedAt: string; durationMs: number; queuedAt?: string; queueMs?: number; executionMs?: number; inputBytes?: number; outputBytes?: number; firstTextMs?: number; finish: string; usage?: TokenUsage; estimatedInputTokens?: number; structuredSchemaKind?: ModelCallOptions['structuredSchemaKind']; error?: string; status?: number; failure?: ModelFailureOutput }
export class ModelCallError extends Error {
  constructor(message: string, readonly code: string, readonly status?: number, readonly failure?: ModelFailureOutput) { super(message) }
}
export class ModelTransportError extends ModelCallError {}
export const transportRetries = defaultProviderProfile.retryLimit, transportRetryDelayMs = defaultProviderProfile.backoffMs
// dsh 适配器常返回标准错误码而不附 HTTP 状态；沿用插件供应商档案退避。
const hostTransientCodes = new Set(['RATE_LIMIT', 'SERVER', 'TRANSPORT', 'TIMEOUT', 'NETWORK_ERROR', 'ECONNRESET', 'ETIMEDOUT'])
async function retryDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted()
  await new Promise<void>((resolve, reject) => {
    const done = () => { signal?.removeEventListener('abort', aborted); resolve() }
    const timer = setTimeout(done, milliseconds)
    const aborted = () => { clearTimeout(timer); signal?.removeEventListener('abort', aborted); reject(signal?.reason) }
    signal?.addEventListener('abort', aborted, { once: true })
  })
}
export interface ValidationFeedback {output:string;error:string}
export class ModelOutputValidationError extends Error {
  constructor(cause:unknown){super(cause instanceof Error?cause.message:String(cause),{cause});this.name='ModelOutputValidationError'}
}
export async function validatedModelOutput<T>(call:(feedback?:ValidationFeedback)=>Promise<string>,validate:(output:string)=>T):Promise<{output:string;value:T}> {
  let output=await call()
  try{return {output,value:validate(output)}}catch(error){
    output=await call({output,error:error instanceof Error?error.message:String(error)})
    try{return {output,value:validate(output)}}catch(cause){throw new ModelOutputValidationError(cause)}
  }
}
export async function abortable<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void pending.catch(() => {}); signal.throwIfAborted() }
  return await new Promise<T>((resolve,reject) => {
    const aborted = () => reject(signal.reason)
    signal.addEventListener('abort',aborted,{once:true})
    pending.then(resolve,reject).finally(() => signal.removeEventListener('abort',aborted)).catch(() => {})
  })
}
export class ModelClient {
  readonly attempts: ModelAttempt[] = []
  private readonly legacyGate: CallGate
  constructor(private readonly runtime: ModelRuntime, private readonly library: LibraryRegistration, private readonly policy: LibraryPolicy) {
    this.legacyGate = new CallGate(policy.pageGenerationConcurrency, policy.batchDelayMs)
    modelGate(runtime, policy.pageGenerationConcurrency)
  }
  private routes(task: Task, operation?: LayeredModelTask): ModelRef[] {
    const primary = operation ? resolveLayeredModel(this.library.models, operation) : resolveModel(this.library.models, task)
    return [primary,...this.library.models.fallbacks].filter((route,index,all) => route.provider && route.model && all.findIndex(item => item.provider === route.provider && item.model === route.model) === index)
  }
  private reasoning(info: LlmResolvedModelInfo, operation?: LayeredModelTask, override?: string) {
    const custom = this.policy.advancedSettingsMode === 'custom'
    const configured = override ?? (operation ? this.library.models.layeredRoutes?.[operation]?.reasoningEffort : undefined)
    const requested = configured || (custom && this.policy.disableThinking ? 'none' : custom ? this.policy.reasoningEffort : '')
    const effort = requested ? info.reasoning?.efforts.find(item => item.id === requested)?.id : undefined
    if (requested && !effort) throw new Error(this.policy.disableThinking && custom
      ? '当前模型未声明 none 推理强度，无法按设置关闭思考。'
      : '所选模型未声明此推理强度。请在 dsh 模型设置中声明支持的推理等级，或调整本库阶段推理强度。')
    return effort
  }
  async info(task: Task, signal?: AbortSignal, required?: 'image', operation?: LayeredModelTask): Promise<LlmResolvedModelInfo> {
    const route = operation ? resolveLayeredModel(this.library.models, operation) : resolveModel(this.library.models,task)
    if (!route.provider || !route.model) throw new Error('请先选择宿主供应商与模型。')
    if (!required) {
      const timeout = AbortSignal.timeout(this.policy.ingestRequestTimeoutSeconds * 1000)
      const callSignal = signal ? AbortSignal.any([signal, timeout]) : timeout
      const info = await abortable(this.runtime.resolveModelInfo(route.provider,route.model,callSignal),callSignal)
      this.reasoning(info, operation)
      return info
    }
    for (const candidate of this.routes(task, operation)) {
      signal?.throwIfAborted()
      const timeout = AbortSignal.timeout(this.policy.ingestRequestTimeoutSeconds * 1000)
      const callSignal = signal ? AbortSignal.any([signal,timeout]) : timeout
      try {
        const info = await abortable(this.runtime.resolveModelInfo(candidate.provider,candidate.model,callSignal),callSignal)
        if (info.inputModalities?.includes(required)) return info
      } catch(error) {
        signal?.throwIfAborted()
        if (!timeout.aborted) throw error
      }
    }
    throw new Error('已配置的视觉路由均未声明可用的图片输入能力，保留待处理。')
  }
  async call(task: Task, system: string, input: string, signal?: AbortSignal, images:ImageBlock[]=[], callOptions: ModelCallOptions = {}): Promise<string> {
    if (callOptions.structuredSchema) registerStructuredSchema(callOptions.structuredSchema.name, callOptions.structuredSchema.schema)
    if (callOptions.structuredSchema) system = jsonProtocol(system, callOptions.structuredSchema.schema)
    // 旧流程的间隔属于逻辑任务，重试和备用切换不增加一次冷却；所有实际请求仍经过供应商闸门。
    const run = () => this.perform(task,system,input,signal,images,callOptions)
    return callOptions.operation ? await run() : await this.legacyGate.run(run, signal)
  }
  async inputBudget(task: Task, signal?: AbortSignal, operation?: LayeredModelTask, safetyRatio = operation === 'topic' || operation === 'parent' ? 0.1 : 0): Promise<number | undefined> {
    const info = await this.info(task, signal, undefined, operation), context = contextWindowLimit(this.policy, info)
    const output = this.policy.maxTokensPerCall || info.defaultMaxTokens || 4096
    return context === undefined ? undefined : safetyRatio === 0.1
      ? topicInputBudget(context, output) : Math.max(0, context - output - Math.ceil(context * safetyRatio))
  }
  concurrency(): number { return this.policy.pageGenerationConcurrency }
  private async perform(task: Task, system: string, input: string, signal?: AbortSignal, images:ImageBlock[]=[], callOptions: ModelCallOptions = {}): Promise<string> {
    const primary = callOptions.operation ? resolveLayeredModel(this.library.models, callOptions.operation) : resolveModel(this.library.models,task)
    if (!primary.provider || !primary.model) throw new Error('请先选择宿主供应商与模型。')
    const routes = this.routes(task, callOptions.operation)
    for (const [index,route] of routes.entries()) {
      const profile = providerProfile(this.library.models, route.provider)
      const gate = providerGate(this.runtime, route.provider, this.policy.pageGenerationConcurrency, profile)
      for (let retry = 0; retry <= profile.retryLimit; retry++) {
      signal?.throwIfAborted()
      let timeoutSignal: AbortSignal | undefined, callSignal = signal
      const queued = Date.now()
      const estimatedInputTokens = Math.ceil(Buffer.byteLength(system + input) / 4), attempt: ModelAttempt = {route:{...route},startedAt:new Date(queued).toISOString(),queuedAt:new Date(queued).toISOString(),durationMs:0,finish:'pending',estimatedInputTokens,
        ...(callOptions.structuredSchemaKind ? { structuredSchemaKind: callOptions.structuredSchemaKind } : {})}
      let started: number | undefined
      let output = ''
      try {
        output = await gate.run(() => modelGate(this.runtime, this.policy.pageGenerationConcurrency).run(async () => {
        signal?.throwIfAborted()
        callOptions.beforeAttempt?.()
        timeoutSignal = AbortSignal.timeout(this.policy.ingestRequestTimeoutSeconds * 1000)
        callSignal = signal ? AbortSignal.any([signal,timeoutSignal]) : timeoutSignal
        started = Date.now(); attempt.startedAt = new Date(started).toISOString(); attempt.queueMs = started - queued; this.attempts.push(attempt)
        callOptions.onAttempt?.(attempt)
        const info = await abortable(this.runtime.resolveModelInfo(route.provider,route.model,callSignal),callSignal)
        const custom = this.policy.advancedSettingsMode === 'custom'
        if(images.length&&!info.inputModalities?.includes('image'))throw new ModelCallError('所选模型未声明图片输入能力，未发送图片。','image-unsupported')
        const contextWindow=contextWindowLimit(this.policy,info)
        if (contextWindow && Buffer.byteLength(system + input) + (this.policy.maxTokensPerCall || info.defaultMaxTokens || 4096) > contextWindow) throw new ModelCallError('请求超出所选模型的保守上下文预算。','context-limit')
        const effort = this.reasoning(info, callOptions.operation, callOptions.reasoningEffort)
        const temperature = task === 'query' ? this.policy.chatTemperature : this.policy.extractionTemperature
        const structured = callOptions.structuredSchema && this.runtime.supportsStructuredOutput?.(route.provider, route.model)
        const cacheMode = profile.cacheMode === 'none' && this.runtime.supportsCacheMode?.(route.provider, route.model) ? 'none' : undefined
        const options = {provider:route.provider,model:route.model,system,messages:[{role:'user',content:[{type:'text',text:input},...images]}],signal:callSignal,
          ...(effort ? {reasoningEffort:effort} : {}), ...(custom && temperature !== null ? {temperature} : {}),
          ...(this.policy.maxTokensPerCall > 0 ? {maxTokens:this.policy.maxTokensPerCall} : {}),
          ...(cacheMode ? { cacheMode } : {}),
          ...(structured ? { responseFormat: { type: 'json_schema', json_schema: { name: callOptions.structuredSchema!.name, strict: true, schema: strictSchema(callOptions.structuredSchema!.schema) } } } : {}) } as GenerateOptions
        const iterator = this.runtime.stream(options)[Symbol.asyncIterator]()
        let finished = false
        try {
          while (true) {
            const item = await abortable(iterator.next(),callSignal)
            if (item.done) break
            const event = item.value
            if (event.type === 'text-delta') {
              if (event.text && attempt.firstTextMs === undefined) attempt.firstTextMs = Date.now() - started
              output += event.text
            }
            if (event.type === 'usage') attempt.usage = event.usage
            if (event.type === 'finish') {
              finished = true; attempt.finish = event.reason.kind
              if (event.reason.kind === 'error' || event.reason.kind === 'aborted') throw new ModelCallError(event.reason.failure.message,event.reason.failure.code,event.reason.failure.status)
              if (event.reason.kind !== 'stop') throw new ModelCallError('模型输出未完整结束：' + event.reason.kind,event.reason.kind)
              break
            }
          }
        } finally {
          // 适配器若卡在 next/return，取消或超时仍须及时释放调度槽位。
          const closing = iterator.return?.()
          if (closing) await abortable(closing, callSignal).catch(() => {})
        }
        callSignal.throwIfAborted()
        if (!finished) throw new ModelCallError('模型响应缺少终止状态。','missing-finish')
        if (!output.trim()) throw new ModelCallError('模型返回空正文。','empty-output')
        attempt.executionMs = Date.now() - started
        return output
        }, 0, signal, undefined, this.policy.pageGenerationConcurrency, 0), estimatedInputTokens, signal, () => attempt.usage ? attempt.usage.inputTokens + (attempt.usage.cacheReadTokens ?? 0) + (attempt.usage.cacheWriteTokens ?? 0) + attempt.usage.outputTokens : undefined,
          Math.min(this.policy.pageGenerationConcurrency, profile.concurrency), callOptions.operation ? this.policy.batchDelayMs : 0)
        return output
      } catch(error) {
        if (!(error instanceof ModelCallError) && error instanceof Error && 'code' in error && typeof error.code === 'string') {
          error = new ModelCallError(error.message, error.code, 'status' in error && typeof error.status === 'number' ? error.status : undefined)
        }
        if (started !== undefined) attempt.executionMs = Date.now() - started
        attempt.error = error instanceof Error ? error.message : String(error)
        if (error instanceof ModelCallError && error.status !== undefined) attempt.status = error.status
        attempt.failure = error instanceof ModelCallError && error.failure ? error.failure : { rawOutput: output }
        if (attempt.finish === 'pending') attempt.finish = callSignal?.aborted ? 'aborted' : 'error'
        signal?.throwIfAborted()
        const serviceFailure = error instanceof ModelCallError && (error.status === 429 || error.status !== undefined && error.status >= 500 && error.status < 600)
        const retryable = error instanceof ModelTransportError || serviceFailure && (callOptions.operation !== undefined || this.library.models.providerProfiles?.[route.provider] !== undefined)
          || error instanceof ModelCallError && hostTransientCodes.has(error.code) && (callOptions.operation !== undefined || this.library.models.providerProfiles?.[route.provider] !== undefined)
        if (retryable && !callSignal?.aborted && retry < profile.retryLimit) {
          gate.penalize(profile.backoffMs * 2 ** retry)
          await retryDelay(profile.backoffMs * 2 ** retry, signal)
          continue
        }
        const transient = retryable || serviceFailure || timeoutSignal?.aborted || error instanceof ModelCallError && (hostTransientCodes.has(error.code) || error.code === 'image-unsupported')
        if (!transient || index === routes.length - 1) throw error
        break
      } finally {
        attempt.inputBytes = Buffer.byteLength(system + input); attempt.outputBytes = Buffer.byteLength(output)
        // 失败后的退避不属于模型执行；记录在运行体退出时，避免并入重试等待。
        if (started !== undefined) attempt.durationMs = attempt.executionMs ?? Date.now() - started
      }
      }
    }
    throw new Error('没有可用模型。')
  }
}
