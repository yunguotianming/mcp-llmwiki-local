import { afterEach, expect, it, vi } from 'vitest'
import { createLocalRuntime } from '../src/local/runtime.js'
const settings = { codexExecutable: process.execPath, codexContextWindowTokens: 256000, deepseekBaseUrl: 'https://api.deepseek.com/v1' }
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

it('缺密钥在发送请求前拒绝，支持 Codex 默认模型信息', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', '')
  const request = vi.fn(); vi.stubGlobal('fetch', request)
  const runtime = createLocalRuntime(settings)
  await expect(runtime.resolveModelInfo('deepseek-official', 'deepseek-flash')).rejects.toThrow('DEEPSEEK_API_KEY')
  expect(request).not.toHaveBeenCalled()
  expect((await runtime.resolveModelInfo('codex-cli', 'gpt-6.1-terra')).id).toBe('gpt-6.1-terra')
})

it('OpenAI 兼容请求映射正文、缓存计量、终止状态', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-api-key')
  const request = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: { content: '{"variants":["证据"]}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 4, prompt_cache_hit_tokens: 6 } }), { status: 200 }))
  vi.stubGlobal('fetch', request)
  const events = []
  for await (const event of createLocalRuntime(settings).stream({ provider: 'deepseek-official', model: 'deepseek-flash', system: '系统', messages: [{ role: 'user', content: [{ type: 'text', text: '问题' }] }] })) events.push(event)
  const init = (request.mock.calls[0] as unknown as [string, RequestInit])[1]
  expect(JSON.parse(init.body as string)).toMatchObject({ model: 'deepseek-flash', stream: false, reasoning_effort: 'high' })
  expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 4, outputTokens: 4, cacheReadTokens: 6 } })
  expect(events.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
})

it('传输错误隐藏环境密钥，HTTP 错误不回显供应商正文', async () => {
  vi.stubEnv('DEEPSEEK_API_KEY', 'fixture-secret-value')
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fixture-secret-value 请求异常')))
  const consume = async () => { for await (const _ of createLocalRuntime(settings).stream({ provider: 'deepseek-official', model: 'deepseek-flash', messages: [] })) { /* 消费假响应。 */ } }
  await expect(consume()).rejects.toThrow('[已隐藏]')
  vi.stubGlobal('fetch', async () => new Response('fixture-secret-value', { status: 401 }))
  await expect(consume()).rejects.toThrow('HTTP 401')
})
