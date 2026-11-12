import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, it, expect, vi } from 'vitest'
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
import { spawn } from 'node:child_process'
import { createCodexCliRuntime } from '../src/llm/codex-cli.js'
import { ModelTransportError } from '../src/llm/client.js'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'

const folders: string[] = []
afterEach(async () => { for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true }) })

it('Codex CLI 取消后等待 close 才结束并保留现场，不在 error 事件提前返回',async()=>{
  const abort=new AbortController();let child!:EventEmitter,settled=false
  vi.mocked(spawn).mockImplementation((_executable:any,_args:any,options:any):any=>{
    folders.push(options.cwd)
    child=Object.assign(new EventEmitter(),{stdout:new PassThrough(),stderr:new PassThrough(),stdin:new Writable({write(_chunk,_encoding,done){done()}})})
    options.signal.addEventListener('abort',()=>child.emit('error',new Error('提前的取消事件')),{once:true})
    return child
  })
  const model=createCodexCliRuntime({executable:'test-codex',model:'gpt-6.1-terra',disabledFeatures:['shell_tool','multi_agent','plugins','remote_plugin']})
  const options={provider:'codex-cli',model:'gpt-6.1-terra',messages:[],signal:abort.signal} as unknown as GenerateOptions
  const pending=(async()=>{for await(const _event of model.stream(options)){} })().catch(error=>{settled=true;return error})
  await vi.waitFor(()=>expect(child).toBeDefined());abort.abort(new Error('用户取消'))
  await Promise.resolve();expect(settled).toBe(false)
  child.emit('close',null);expect((await pending).message).toBe('用户取消')
  expect((await stat(folders[0]!)).isDirectory()).toBe(true)
})

it('Codex CLI 使用指定模型与只读执行，返回正文并正确拆分缓存用量', async () => {
  let prompt = '', folder = ''
  const schema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }
  vi.mocked(spawn).mockImplementation((executable: any, args: any, options: any): any => {
    expect(executable).toBe('test-codex'); expect(args).toContain('gpt-6.1-terra'); expect(args).toContain('read-only')
    expect(args).toContain('shell_tool'); expect(args).toContain('multi_agent'); expect(args.join(' ')).toContain('--disable plugins --disable remote_plugin'); expect(options.windowsHide).toBe(true)
    folder = options.cwd
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new Writable({ write(chunk, _encoding, done) { prompt += chunk; done() } }) })
    child.stdin.on('finish', () => { void (async () => {
      expect(args).toContain('--output-schema')
      expect(JSON.parse(await readFile(args[args.indexOf('--output-schema') + 1], 'utf8'))).toEqual(schema)
      await writeFile(args[args.indexOf('-o') + 1], '{"ok":true}')
      child.stdout.write(JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 1000, cached_input_tokens: 700, output_tokens: 100 } }) + '\n')
      child.emit('close', 0)
    })() })
    return child
  })
  const runtime = createCodexCliRuntime({ executable: 'test-codex', model: 'gpt-6.1-terra', disabledFeatures:['shell_tool','multi_agent','plugins','remote_plugin'] })
  expect(runtime.supportsStructuredOutput?.('codex-cli', 'gpt-6.1-terra')).toBe(true)
  const options = { provider: 'codex-cli', model: 'gpt-6.1-terra', system: '保留来源', responseFormat: { type: 'json_schema', json_schema: { schema } }, messages: [{ role: 'user', content: [{ type: 'text', text: '正文' }] }] } as GenerateOptions
  const events = []
  for await (const event of runtime.stream(options)) events.push(event)
  expect(prompt).toContain('保留来源'); expect(prompt).toContain('正文')
  expect(events).toContainEqual({ type: 'usage', usage: { inputTokens: 300, cacheReadTokens: 700, outputTokens: 100, totalTokens: 1100 } })
  expect(events).toContainEqual({ type: 'text-delta', index: 0, text: '{"ok":true}' })
  await expect(stat(path.join(folder, 'result.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('Codex CLI 失败与取消不当作完成，不悄悄换模型', async () => {
  vi.mocked(spawn).mockImplementation((_executable: any, _args: any, options: any): any => {
    folders.push(options.cwd)
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new Writable({ write(_chunk, _encoding, done) { done() } }) })
    child.stdin.on('finish', () => { child.stderr.write('模拟模型不可用'); child.emit('close', 2) })
    return child
  })
  const runtime = createCodexCliRuntime({ executable: 'test-codex', model: 'gpt-6.1-terra', disabledFeatures:['shell_tool','multi_agent','plugins','remote_plugin'] })
  const options = { provider: 'codex-cli', model: 'gpt-6.1-terra', messages: [] } as unknown as GenerateOptions
  const collect = async (value: GenerateOptions) => { for await (const _event of runtime.stream(value)) {} }
  await expect(collect(options)).rejects.toThrow('模拟模型不可用')
  const abort = new AbortController(); abort.abort(new Error('用户取消'))
  await expect(collect({ ...options, signal: abort.signal })).rejects.toThrow('用户取消')
  await expect(runtime.resolveModelInfo('codex-cli', '其他模型')).rejects.toThrow('不一致')
})

it('Codex 传输错误结构化并交出完整输出，保留失败文件且识别无换行尾事件', async () => {
  const raw = '完整原始输出'.repeat(1000)
  let outputPath = ''
  vi.mocked(spawn).mockImplementation((_executable: any, args: any, options: any): any => {
    folders.push(options.cwd); outputPath = args[args.indexOf('-o') + 1]
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new Writable({ write(_chunk, _encoding, done) { done() } }) })
    child.stdin.on('finish', () => { void (async () => {
      await writeFile(outputPath, raw)
      child.stdout.write(JSON.stringify({ type: 'turn.failed', error: { message: 'error decoding response body' } }))
      child.emit('close', 0)
    })() })
    return child
  })
  const runtime = createCodexCliRuntime({ executable: 'test-codex', model: 'mock', disabledFeatures:['shell_tool','multi_agent','plugins','remote_plugin'] })
  const options = { provider: 'codex-cli', model: 'mock', messages: [] } as unknown as GenerateOptions
  const failure = await (async () => { for await (const _event of runtime.stream(options)) {} })().catch(error => error)
  expect(failure).toBeInstanceOf(ModelTransportError)
  expect(failure.failure.rawOutput).toBe(raw); expect(failure.failure.outputPath).toBe(outputPath)
  expect(await readFile(outputPath, 'utf8')).toBe(raw)
  expect(await runtime.resolveModelInfo('codex-cli', 'mock')).not.toHaveProperty('context')
})

it('Codex 连接中断和 HTTP 5xx 归为传输错误，业务错误保持原类型', async () => {
  const messages = ['connection reset by peer', 'HTTP 503 Service Unavailable', '模型参数错误']
  vi.mocked(spawn).mockImplementation((_executable: any, _args: any, options: any): any => {
    folders.push(options.cwd)
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new Writable({ write(_chunk, _encoding, done) { done() } }) })
    child.stdin.on('finish', () => { child.stderr.write(messages.shift()); child.emit('close', 1) })
    return child
  })
  const runtime = createCodexCliRuntime({ executable: 'test-codex', model: 'mock', disabledFeatures:['shell_tool','multi_agent','plugins','remote_plugin'] })
  for (const transport of [true, true, false]) {
    const failure = await (async () => { for await (const _event of runtime.stream({ provider: 'codex-cli', model: 'mock', messages: [] } as unknown as GenerateOptions)) {} })().catch(error => error)
    expect(failure instanceof ModelTransportError).toBe(transport)
  }
})
