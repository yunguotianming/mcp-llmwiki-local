import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { redactSecrets, redactValue } from '../src/llm/credentials.js'
import { LocalConfigStore, parseLocalConfig } from '../src/local/config.js'
import { createLocalHost } from '../src/local/host.js'
import { LocalJobs, localError } from '../src/local/jobs.js'
import { createMcpServer } from '../src/mcp/server.js'
import { runCli } from '../src/cli.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { temporaryWorkspace } from './temp.js'
import type { ModelRuntime } from '../src/llm/client.js'

const key = 'fixture-quoted-"key\\tail'
const provider = { baseUrl: 'https://offline.invalid/v1', model: 'fixture', api: 'openai-responses' as const, apiKey: key }
const fake: ModelRuntime = { async resolveModelInfo(): Promise<never> { throw new Error('禁止模型调用') }, async *stream() { throw new Error('禁止模型调用') } }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
function memoryConfig() {
  const registry = emptyRegistry(), library = newLibrary('00000000-0000-4000-8000-000000000000')
  registry.compatibleProviders = { 'compatible:fixture': { ...provider } }
  library.name = '包含' + key; library.description = JSON.stringify({ detail: key })
  library.sourceRoots = [path.join(tmpdir(), 'llmwiki-credential-no-source')]; library.wikiPath = path.join(library.sourceRoots[0]!, '.llmwiki')
  registry.libraries = [library]; registry.activeLibraryId = library.id
  const config = new LocalConfigStore(path.join(tmpdir(), 'llmwiki-credential-no-config'))
  Reflect.set(config, 'value', parseLocalConfig({ registry }))
  vi.spyOn(config, 'load').mockImplementation(async () => config.snapshot())
  return { config, registry, library }
}

it('结构化脱敏保留字段名、数字和布尔，合法短密钥不会破坏JSON', () => {
  const value = { status: true, completedSources: 1, nested: [1, false, null, '凭据=1'] }
  const safe = redactValue(value, ['1'])
  expect(safe).toEqual({ status: true, completedSources: 1, nested: [1, false, null, '凭据=[已脱敏]'] })
  expect(JSON.parse(redactSecrets(JSON.stringify(value), ['1']))).toEqual(safe)
  const { registry } = memoryConfig(); registry.compatibleProviders!['compatible:fixture']!.apiKey = '1'
  const host = createLocalHost(registry, { runtime: fake })
  try { expect(host.sanitize({ completedSources: 1, enabled: true })).toEqual({ completedSources: 1, enabled: true }) }
  finally { host.dispose() }
})

it('嵌套JSON字符串与带前缀错误统一遮蔽，不枚举转义层数', () => {
  let nested = JSON.stringify({ authorization: key })
  for (let i = 0; i < 4; i++) nested = JSON.stringify({ detail: nested })
  let safe = redactValue({ nested }, [key]).nested
  for (let i = 0; i < 4; i++) safe = JSON.parse(safe).detail
  expect(JSON.parse(safe).authorization).toBe('[已脱敏]')
  const prefixed = redactSecrets('请求失败：' + nested, [key])
  expect(prefixed).toContain('[已脱敏]')
  expect(prefixed).not.toContain('fixture-quoted')
})

it('MCP资源列表、模板、卡片、工具和资源错误全部走统一脱敏', async () => {
  const f = await temporaryWorkspace(), { config } = memoryConfig(), registry = config.registry()
  registry.libraries[0]!.sourceRoots = [f.root]; registry.libraries[0]!.wikiPath = path.join(f.root, '.llmwiki')
  Reflect.set(config, 'value', parseLocalConfig({ registry })); await new LibraryStore(config.registry).initialize(registry.libraries[0]!.id)
  const app = createMcpServer(config, fake), client = new Client({ name: '假密钥边界', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  try {
    await app.server.connect(a); await client.connect(b)
    const resources = await client.listResources()
    expect(resources.resources[0]!.name).not.toContain('fixture-quoted')
    expect((await client.listResourceTemplates()).resourceTemplates).toHaveLength(1)
    const card = await client.readResource({ uri: resources.resources[0]!.uri })
    const data = JSON.parse((card.contents[0] as { text: string }).text)
    expect(JSON.stringify(data)).not.toContain('fixture-quoted')
    const tool = await client.callTool({ name: 'wiki_list_libraries', arguments: {} })
    expect(JSON.stringify(tool)).not.toContain('fixture-quoted')
    vi.mocked(config.load).mockRejectedValueOnce(new Error('资源失败：' + JSON.stringify({ detail: JSON.stringify({ key }) })))
    await expect(client.listResources()).rejects.toThrow(/已隐藏|已脱敏/)
  } finally { await app.jobs.close(); await client.close(); await app.server.close(); await f.cleanup() }
})

it('作业嵌套错误落盘安全且保留数值类型，实际假模型失败得到遮蔽', async () => {
  const f = await temporaryWorkspace(), config = new LocalConfigStore(path.join(f.root, 'home'))
  await config.load(); const source = path.join(f.root, '资料'); await mkdir(source)
  await writeFile(path.join(source, '资料.md'), '可追溯的真实原文。')
  const library = await config.add(source), old = config.registry(), next = structuredClone(old)
  next.compatibleProviders = { 'compatible:fixture': { ...provider } }
  next.libraries[0]!.models.unified = { provider: 'fake', model: 'fake' }
  next.libraries[0]!.layered = { embeddingMode: 'none', extractionReview: 'off', topicReview: false }
  await config.writeRegistry(next, old)
  let calls = 0
  const runtime: ModelRuntime = { async resolveModelInfo(): Promise<never> { calls++; throw new Error(JSON.stringify({ detail: JSON.stringify({ key }) })) }, async *stream() { throw new Error('禁止网络请求') } }
  const jobs = new LocalJobs(config, runtime)
  try {
    const start = await jobs.generate({ libraryId: library.id }), target = path.join(config.home, 'jobs', start.jobId + '.json')
    let job: { status: string; ownerPid: number; error?: string } | undefined
    await vi.waitFor(async () => { job = JSON.parse(await readFile(target, 'utf8')); expect(job!.status).not.toBe('running') }, { timeout: 10000 })
    expect(calls).toBeGreaterThan(0)
    expect(job!.ownerPid).toBe(process.pid)
    expect(job!.error).toMatch(/已隐藏|已脱敏/)
    expect(JSON.stringify(job)).not.toContain('fixture-quoted')
    expect(await readFile(path.join(source, '资料.md'), 'utf8')).toBe('可追溯的真实原文。')
  } finally { await jobs.close(); await f.cleanup() }
})

it('CLI列表及其嵌套错误输出遮蔽配置凭据', async () => {
  const { config } = memoryConfig(), output: string[] = []
  await runCli(['library', 'list'], config, text => output.push(text))
  expect(JSON.parse(output[0]!)).toHaveLength(1)
  expect(output[0]).not.toContain('fixture-quoted')
  expect(localError(new Error('请求失败：' + JSON.stringify({ detail: JSON.stringify({ key }) })), config.secrets())).not.toContain('fixture-quoted')
})
