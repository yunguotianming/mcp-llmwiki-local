import type { LlmResolvedModelInfo } from '@deepseek-ai/dsh-llm'
import type { LibraryPolicy } from '../domain/policy.js'

// 上限以 token 数配置；现有调用方继续用 UTF-8 字节数保守估算输入。
export function contextWindowLimit(policy: Pick<LibraryPolicy,'contextWindowTokens'>, info: Pick<LlmResolvedModelInfo,'context'>): number | undefined {
  const requested=policy.contextWindowTokens || undefined,declared=info.context?.contextWindow
  return requested && declared ? Math.min(requested,declared) : requested ?? declared
}

// 按 1 UTF-8 字节不超过 1 token 保守计量；系统提示和协议包含在返回的总输入预算内。
// 总输入 = 上下文 - 输出额度 - ceil(上下文 × 10%)；正文额度再减实际系统提示字节。
export function topicInputBudget(context: number, outputTokens: number): number {
  return Math.max(0, context - outputTokens - Math.ceil(context * 0.1))
}
