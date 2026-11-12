import { afterEach, expect, it, vi } from 'vitest'
import { newLibrary } from '../src/domain/config.js'
import { understandQuery } from '../src/wiki/query-understanding.js'
import { tokenCost } from '../src/wiki/page-search.js'
import { model } from './query-pages-audit-fixture.js'

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it('Q21 有有效变体零调用，只有空白重复超长变体时恰好调用一次', async () => {
  const library = newLibrary('audit-trigger'), runtime = model()
  expect(await understandQuery('原话', ['原话', '', '有效词'], library, runtime)).toMatchObject({ status: 'caller', calls: 0 })
  expect(runtime.stream).not.toHaveBeenCalled(); expect(runtime.resolveModelInfo).not.toHaveBeenCalled()
  expect(await understandQuery('原话', ['原话', '', ' '.repeat(3), '超'.repeat(501)], library, runtime)).toMatchObject({ status: 'generated', calls: 1 })
  expect(runtime.stream).toHaveBeenCalledTimes(1); expect(runtime.resolveModelInfo).toHaveBeenCalledTimes(1)
})

it('Q22 非法输出、超限、未配置及执行异常均退原话并标因，不重试不换模型', async () => {
  const library = newLibrary('audit-failure')
  library.queryUnderstanding = { outputTokens: 300 }
  library.models.fallbacks = [{ provider: '备用', model: '备用' }]
  library.models.providerProfiles = { 'deepseek-official': { concurrency: 1, retryLimit: 5, backoffMs: 0, cacheMode: 'none' } }
  for (const output of ['not json', '{"variants":[7]}', '{"variants":["原话"]}', '{"variants":["一","二","三","四"]}', '{"variants":["' + 'x'.repeat(301) + '"]}', '{"variants":["合法"],"正文":"不应泄露"}']) {
    const runtime = model(output), result = await understandQuery('原话', [], library, runtime)
    expect(result).toMatchObject({ status: 'invalid-output', calls: 1, variants: [], notice: { stage: 'understanding', reason: 'invalid-output' } })
    expect(runtime.stream).toHaveBeenCalledTimes(1); expect(runtime.resolveModelInfo).toHaveBeenCalledTimes(1)
    expect(runtime.stream.mock.calls[0]![0]).toMatchObject({ provider: 'deepseek-official', model: 'deepseek-flash' })
    expect(JSON.stringify(result)).not.toContain('不应泄露')
  }
  const broken = model(); broken.stream.mockImplementation(async function* () { throw new Error('含服务内部敏感正文的异常') })
  expect(await understandQuery('原话', [], library, broken)).toMatchObject({ status: 'model-failed', calls: 1, variants: [] })
  expect(broken.stream).toHaveBeenCalledTimes(1)
  expect(await understandQuery('原话', [], library)).toMatchObject({ status: 'model-unconfigured', calls: 0, variants: [] })
  const absent = model(); absent.resolveModelInfo.mockRejectedValue(new Error('模型不存在'))
  expect(await understandQuery('原话', [], library, absent)).toMatchObject({ status: 'model-unconfigured', calls: 0 })
  expect(absent.stream).not.toHaveBeenCalled(); expect(absent.resolveModelInfo).toHaveBeenCalledTimes(1)
})

it('Q23 取消同时传给解析器与执行器，已有取消不启动调用', async () => {
  const library = newLibrary('audit-cancel'), runtime = model(), started = Promise.withResolvers<void>(), abort = new AbortController()
  runtime.stream.mockImplementation(async function* () { started.resolve(); await new Promise(() => {}); yield { type: 'finish', reason: { kind: 'stop' } } })
  const pending = understandQuery('原话', [], library, runtime, abort.signal), rejection = expect(pending).rejects.toThrow('用户取消')
  await started.promise; abort.abort(new Error('用户取消')); await rejection
  expect(runtime.stream.mock.calls[0]![0].signal!.aborted).toBe(true)
  expect(runtime.resolveModelInfo.mock.calls[0]![2]!.aborted).toBe(true)
  await expect(understandQuery('原话', [], library, runtime, abort.signal)).rejects.toThrow('用户取消')
  expect(runtime.stream).toHaveBeenCalledTimes(1)
})

it('Q24 输入含系统提示总计不超1500且自定义输出强制不超300，截断不拆Unicode字符', async () => {
  const library = newLibrary('audit-budget'), runtime = model()
  library.queryUnderstanding = { outputTokens: 300 }
  expect(await understandQuery('🦊中文'.repeat(1000), [], library, runtime)).toMatchObject({ status: 'generated' })
  const request = runtime.stream.mock.calls[0]![0], input = request.messages[0]!.content[0]!
  expect(input.type).toBe('text')
  if (input.type !== 'text') throw new Error('应为文本消息')
  expect(tokenCost(request.system! + input.text)).toBeLessThanOrEqual(1500)
  expect(input.text).not.toContain('\uFFFD'); expect(request.maxTokens).toBe(300)
  const over = model('{"variants":["' + '超'.repeat(110) + '"]}')
  expect(await understandQuery('原话', [], library, over)).toMatchObject({ status: 'invalid-output', variants: [] })
  expect(over.stream.mock.calls[0]![0].signal!.aborted).toBe(true)
})

it('Q25 只累计调用无每日配额，日志与计数不保存模型输出或资料正文', async () => {
  const library = newLibrary('audit-count'), runtime = model('{"variants":["模型输出独占正文"]}'), log = vi.spyOn(console, 'info').mockImplementation(() => {})
  const results = []
  for (let i = 0; i < 205; i++) results.push(await understandQuery('原话', [], library, runtime))
  expect(results.every(result => result.status === 'generated')).toBe(true)
  expect(runtime.stream).toHaveBeenCalledTimes(205)
  expect(results.at(-1)!.count - results[0]!.count).toBe(204)
  expect(log).toHaveBeenCalledTimes(205)
  expect(JSON.stringify(log.mock.calls)).not.toContain('模型输出独占正文')
  expect(JSON.stringify(results.map(result => ({ calls: result.calls, count: result.count })))).not.toContain('模型输出独占正文')
})
