import type { ModelRuntime } from '../llm/client.js'
import { ModelCallError } from '../llm/client.js'
import { createCodexCliRuntime } from '../llm/codex-cli.js'
import type { RuntimeSettings } from './config.js'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { redactSecrets as redactText, redactValue as redactData } from '../llm/credentials.js'

function codexExecutable(configured: string): string {
  if (configured !== 'codex' || process.platform !== 'win32') return configured
  // Windows 的 npm .cmd 入口不能直接由 spawn 执行；优先选择同安装目录的原生程序。
  const bases = [path.join(process.env.APPDATA ?? '', 'npm'), ...(process.env.PATH ?? '').split(path.delimiter)]
  for (const base of bases) {
    for (const relative of ['codex.exe', 'node_modules/@openai/codex/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe', 'node_modules/@openai/codex/vendor/x86_64-pc-windows-msvc/bin/codex.exe']) {
      const file = path.join(base, relative)
      if (existsSync(file)) return file
    }
  }
  throw new ModelCallError('未找到 Codex 原生可执行文件，请设置 runtime.codexExecutable 为 codex.exe 绝对路径。', 'MODEL_UNAVAILABLE')
}

export const redactionSecrets = (configured: readonly string[] = []) => [...configured, ...Object.entries(process.env)
  .filter(([name]) => /(?:KEY|TOKEN|SECRET|PASSWORD)/i.test(name)).map(([, value]) => value).filter((value): value is string => !!value)]
export function redactSecrets(text: string, configured: readonly string[] = []): string {
  return redactText(text, redactionSecrets(configured), '[已隐藏]')
}
export function redactValue<T>(value: T, configured: readonly string[] = []): T {
  return redactData(value, redactionSecrets(configured), '[已隐藏]')
}

export function createLocalRuntime(settings: RuntimeSettings): ModelRuntime {
  const codex = new Map<string, ModelRuntime>()
  const select = (model: string) => {
    let runtime = codex.get(model)
    if (!runtime) { runtime = createCodexCliRuntime({ executable: codexExecutable(settings.codexExecutable), model, reasoningEffort: 'high' }); codex.set(model, runtime) }
    return runtime
  }
  const credential = () => {
    const key = process.env.DEEPSEEK_API_KEY
    if (!key?.trim()) throw new ModelCallError('缺少环境变量 DEEPSEEK_API_KEY；查询理解将降级为原话检索。', 'MISSING_CREDENTIAL')
    return key
  }
  return {
    supportsStructuredOutput: provider => provider === 'codex-cli',
    async resolveModelInfo(provider, model, signal) {
      signal?.throwIfAborted()
      if (provider === 'codex-cli') return { ...await select(model).resolveModelInfo(provider, model, signal), context: { contextWindow: settings.codexContextWindowTokens } }
      if (provider !== 'deepseek-official') throw new ModelCallError('未支持的本地模型供应商：' + provider, 'MODEL_UNAVAILABLE')
      credential()
      return { provider, id: model, name: model, inputModalities: ['text'], context: { contextWindow: 1000000 },
        reasoning: { efforts: [{ id: 'high', name: '高' }, { id: 'none', name: '关闭' }] } }
    },
    async *stream(options) {
      try {
        if (options.provider === 'codex-cli') { yield* select(options.model).stream(options); return }
        if (options.provider !== 'deepseek-official') throw new ModelCallError('未支持的本地模型供应商。', 'MODEL_UNAVAILABLE')
        const messages = options.messages.map(message => ({ role: message.role, content: message.content.map(block => {
          if (block.type !== 'text') throw new ModelCallError('DeepSeek 文本客户端不支持图片输入。', 'image-unsupported')
          return block.text
        }).join('\n') }))
        if (options.system) messages.unshift({ role: 'system', content: options.system })
        const response = await fetch(settings.deepseekBaseUrl + '/chat/completions', {
          method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + credential() },
          body: JSON.stringify({ model: options.model, messages, stream: false,
            ...(options.maxTokens ? { max_tokens: options.maxTokens } : {}),
            ...(options.temperature !== undefined ? { temperature: options.temperature } : {}),
            thinking: { type: options.reasoningEffort === 'none' ? 'disabled' : 'enabled' },
            ...(options.reasoningEffort !== 'none' ? { reasoning_effort: options.reasoningEffort ?? 'high' } : {}) }),
          signal: options.signal ?? AbortSignal.timeout(30000),
        })
        if (!response.ok) throw new ModelCallError('DeepSeek 请求失败，HTTP ' + response.status,
          response.status === 429 ? 'RATE_LIMIT' : response.status >= 500 ? 'SERVER' : 'BAD_REQUEST', response.status)
        const result = await response.json() as { choices?: { message?: { content?: string }; finish_reason?: string }[]; usage?: { prompt_tokens: number; completion_tokens: number; prompt_cache_hit_tokens?: number } }
        const choice = result.choices?.[0]
        if (!choice?.message?.content) throw new ModelCallError('DeepSeek 返回空正文。', 'empty-output')
        yield { type: 'text-delta', index: 0, text: choice.message.content }
        if (result.usage) yield { type: 'usage', usage: { inputTokens: Math.max(0, result.usage.prompt_tokens - (result.usage.prompt_cache_hit_tokens ?? 0)),
          outputTokens: result.usage.completion_tokens, cacheReadTokens: result.usage.prompt_cache_hit_tokens ?? 0 } }
        yield { type: 'finish', reason: { kind: choice.finish_reason === 'stop' ? 'stop' : 'length' } }
      } catch (error) {
        options.signal?.throwIfAborted()
        if (error instanceof ModelCallError) throw new ModelCallError(redactSecrets(error.message), error.code, error.status)
        throw new ModelCallError('本地模型请求失败：' + redactSecrets(error instanceof Error ? error.message : String(error)), 'TRANSPORT')
      }
    },
  }
}
