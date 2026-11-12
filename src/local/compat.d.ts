// 保留同源核心的类型导入名称；这些声明在编译时擦除，不加载或依赖 dsh。
declare module '@deepseek-ai/dsh-llm' {
  export type ReasoningEffortId = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max'
  export interface TokenUsage { inputTokens: number; outputTokens: number; cacheReadTokens?: number; cacheWriteTokens?: number; reasoningTokens?: number }
  export interface ImageBlock { type: 'image'; attachment: unknown }
  export interface LlmResolvedModelInfo {
    provider: string; id: string; name: string; defaultMaxTokens?: number
    inputModalities?: string[]; context?: { contextWindow?: number; maxOutputTokens?: number }
    reasoning?: { efforts: { id: ReasoningEffortId; name: string }[] }
  }
  export interface GenerateOptions {
    provider: string; model: string; system?: string
    messages: { role: string; content: ({ type: 'text'; text: string } | ImageBlock)[] }[]
    signal?: AbortSignal; reasoningEffort?: ReasoningEffortId; temperature?: number; maxTokens?: number
    cacheMode?: string; responseFormat?: { type: 'json_schema'; json_schema: { name: string; strict: boolean; schema: unknown } }
  }
  export type LlmEvent = { type: 'text-delta'; index: number; text: string }
    | { type: 'usage'; usage: TokenUsage }
    | { type: 'finish'; reason: { kind: 'stop' | 'length' | 'tool-calls' } | { kind: 'error' | 'aborted'; failure: { message: string; code: string; status?: number } } }
  export interface LlmRuntime {
    resolveModelInfo(provider: string, model: string, signal?: AbortSignal): Promise<LlmResolvedModelInfo>
    stream(options: GenerateOptions): AsyncIterable<LlmEvent>
  }
}
declare module '@deepseek-ai/dsh-attachment' {
  export type ImageMediaType = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'
  export interface AttachmentStore { saveImage(input: { data: Uint8Array; mediaType: ImageMediaType; name: string }): Promise<unknown> }
}
