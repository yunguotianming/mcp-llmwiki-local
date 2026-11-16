import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalConfigStore, parseLocalConfig } from '../src/local/config.js'
import { emptyRegistry } from '../src/domain/config.js'
import { exportConfig } from '../src/domain/config-io.js'
import { createLocalHost } from '../src/local/host.js'
import { LocalJobs, localError } from '../src/local/jobs.js'
import { redactSecrets } from '../src/local/runtime.js'
import { runCli } from '../src/cli.js'
import { temporaryWorkspace } from './temp.js'
import type { ModelRuntime } from '../src/llm/client.js'

const key = 'fixture-quoted-"key\\tail'
const provider = { baseUrl: 'https://offline.invalid/v1', model: 'fixture', api: 'openai-responses' as const }
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

it('本机配置保留两类明文凭据，导出移除，明文与环境变量互斥', async () => {
  const f = await temporaryWorkspace(), config = new LocalConfigStore(f.root)
  try {
    await config.load(); const old = config.registry(), next = structuredClone(old)
    next.compatibleProviders = { 'compatible:fixture': { ...provider, apiKey: key } }
    next.embeddingService = { baseUrl: provider.baseUrl, model: 'embedding', apiKey: key }
    await config.writeRegistry(next, old)
    const reloaded = new LocalConfigStore(f.root); await reloaded.load()
    expect(reloaded.registry().compatibleProviders!['compatible:fixture']!.apiKey).toBe(key)
    expect(reloaded.registry().embeddingService!.apiKey).toBe(key)
    expect(exportConfig(next)).not.toContain('apiKey')
    next.compatibleProviders['compatible:fixture']!.apiKeyEnv = 'FIXTURE_CREDENTIAL'
    expect(() => parseLocalConfig({ registry: next })).toThrow('只能选择一种')
  } finally { await f.cleanup() }
})

it.each(['openai-completions', 'openai-responses'] as const)('%s 从配置读取明文或环境变量，仅授权头含凭据', async api => {
  vi.stubEnv('FIXTURE_CREDENTIAL', key)
  for (const credential of [{ apiKey: key }, { apiKeyEnv: 'FIXTURE_CREDENTIAL' }]) {
    const registry = emptyRegistry()
    registry.compatibleProviders = { 'compatible:fixture': { ...provider, api, ...credential } }
    const request = vi.fn(async () => Response.json(api === 'openai-responses'
      ? { status: 'completed', output: [{ type: 'message', content: [{ type: 'output_text', text: '有据回答' }] }] }
      : { choices: [{ message: { content: '有据回答' }, finish_reason: 'stop' }] }))
    const host = createLocalHost(parseLocalConfig({ registry }).registry, { request })
    try {
      const events = []
      for await (const event of host.runtime.stream({ provider: 'compatible:fixture', model: 'fixture', system: '仅按证据回答', messages: [] })) events.push(event)
      const init = request.mock.calls[0]![1] as RequestInit
      expect(init.headers).toMatchObject({ authorization: 'Bearer ' + key })
      expect(String(init.body)).not.toContain(JSON.stringify(key).slice(1, -1))
      expect(events).toContainEqual({ type: 'text-delta', index: 0, text: '有据回答' })
      const encoded = JSON.stringify({ error: key })
      expect(JSON.stringify(host.sanitize({ error: key }))).not.toContain(JSON.stringify(key).slice(1, -1))
      expect(host.failure(new Error(encoded)).message).not.toContain(JSON.stringify(key).slice(1, -1))
    } finally { host.dispose() }
  }
})

it('CLI 输出与错误隐藏配置密钥及其 JSON 转义形式', async () => {
  const f = await temporaryWorkspace(), config = new LocalConfigStore(f.root)
  try {
    await config.load(); const old = config.registry(), next = structuredClone(old)
    next.compatibleProviders = { 'compatible:fixture': { ...provider, apiKey: key } }
    await config.writeRegistry(next, old)
    const source = path.join(f.root, '资料'); await mkdir(source); await config.add(source, '包含' + key)
    const output: string[] = []; await runCli(['library', 'list'], config, value => output.push(value))
    expect(output.join('')).not.toContain(JSON.stringify(key).slice(1, -1))
    expect(output.join('')).toContain('[已隐藏]')
    expect(localError(new Error(JSON.stringify({ key })), config.secrets())).toContain('[已隐藏]')
    expect(redactSecrets(key + key, [key, 'fixture'])).toBe('[已隐藏][已隐藏]')
  } finally { await f.cleanup() }
})

it('失败作业回执不落盘配置密钥，原始资料保留', async () => {
  const f = await temporaryWorkspace(), config = new LocalConfigStore(path.join(f.root, 'home'))
  await config.load(); const source = path.join(f.root, '资料'); await mkdir(source)
  await writeFile(path.join(source, '资料.md'), '可追溯的真实原文。')
  const library = await config.add(source), old = config.registry(), next = structuredClone(old)
  next.compatibleProviders = { 'compatible:fixture': { ...provider, apiKey: key } }
  next.libraries[0]!.layered = { embeddingMode: 'none' }
  await config.writeRegistry(next, old)
  const runtime: ModelRuntime = { async resolveModelInfo(): Promise<never> { throw new Error('假模型错误：' + key) }, async *stream() { throw new Error('不应发送请求') } }
  const jobs = new LocalJobs(config, runtime)
  try {
    const start = await jobs.generate({ libraryId: library.id }); await jobs.close()
    const raw = await readFile(path.join(config.home, 'jobs', start.jobId + '.json'), 'utf8')
    expect(raw).not.toContain(JSON.stringify(key).slice(1, -1))
    expect(JSON.parse(raw).status).not.toBe('running')
    expect(await readFile(path.join(source, '资料.md'), 'utf8')).toBe('可追溯的真实原文。')
  } finally { await jobs.close(); await f.cleanup() }
})
