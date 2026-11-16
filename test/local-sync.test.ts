import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ResourceUpdatedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { LocalConfigStore, parseLocalConfig } from '../src/local/config.js'
import { createMcpServer } from '../src/mcp/server.js'
import { emptyRegistry } from '../src/domain/config.js'
import { runCli } from '../src/cli.js'
import { registryRevision } from '../src/wiki/library-discovery.js'
import { fixture } from './query-pages-audit-fixture.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'
import { temporaryWorkspace } from './temp.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('独立配置保留旧外层及运行参数，兼容接口接受明文或环境变量密钥', () => {
  const registry = emptyRegistry()
  registry.compatibleProviders = { 'compatible:local': { baseUrl: 'https://offline.invalid/v1', api: 'openai-responses', model: 'fake', apiKeyEnv: 'LOCAL_SYNC_KEY' } }
  const runtime = { codexExecutable: 'custom.exe', codexContextWindowTokens: 64000, deepseekBaseUrl: 'https://offline.invalid/v1' }
  expect(parseLocalConfig({ registry, runtime })).toMatchObject({ registry: { compatibleProviders: registry.compatibleProviders }, runtime })
  // FR-39：MCP 配置可写明文 key 或环境变量名（c935b4c 起放开）；明文由 LocalConfigStore.secrets 纳入日志脱敏。
  registry.compatibleProviders['compatible:local'] = { ...registry.compatibleProviders['compatible:local']!, apiKey: '离线明文密钥' }
  delete registry.compatibleProviders['compatible:local']!.apiKeyEnv
  expect(parseLocalConfig({ registry, runtime }).registry.compatibleProviders?.['compatible:local']).toMatchObject({ apiKey: '离线明文密钥' })
})

it('SDK 库卡片资源、订阅和修订写入共用持久配置，旧修订拒绝覆盖', async () => {
  const f = await fixture(), config = new LocalConfigStore(path.join(f.root, 'sync-home'))
  await config.load(); f.library.layered = { embeddingMode: 'none' }
  await config.writeRegistry(f.store.snapshot(), config.registry())
  const app = createMcpServer(config), client = new Client({ name: '独立同步测试', version: '1' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const notifications: string[] = []
  client.setNotificationHandler(ResourceUpdatedNotificationSchema, message => { notifications.push(message.params.uri) })
  try {
    await app.server.connect(a); await client.connect(b)
    const resources = await client.listResources(), uri = resources.resources[0]!.uri
    expect(uri).toBe(`llmwiki://libraries/${f.library.id}/card`)
    await client.subscribeResource({ uri })
    const card = await client.readResource({ uri })
    expect(JSON.parse(String(card.contents[0]!.text)).libraryId).toBe(f.library.id)
    const revision = registryRevision(config.registry())
    const args = { libraryId: f.library.id, patch: { pinned: true }, expectedRegistryRevision: revision }
    expect((await client.callTool({ name: 'wiki_update_library', arguments: args })).isError).not.toBe(true)
    expect((await new LocalConfigStore(config.home).load()).registry.libraries[0]!.pinned).toBe(true)
    expect((await client.callTool({ name: 'wiki_update_library', arguments: { ...args, patch: { order: 9 } } })).isError).toBe(true)
    await vi.waitFor(() => expect(notifications).toContain(uri))
    await client.unsubscribeResource({ uri })
  } finally { await app.jobs.close(); await client.close(); await app.server.close(); await f.cleanup() }
})

it('libraries 命令沿用原配置位置和外层，组织更新不覆盖 runtime', async () => {
  const f = await temporaryWorkspace(), previousCode = process.exitCode
  try {
    const config = new LocalConfigStore(path.join(f.root, 'home')); await config.load()
    const initial = config.snapshot(); initial.runtime.codexExecutable = 'custom.exe'
    await writeFile(config.file, JSON.stringify(initial))
    const request = path.join(f.root, 'groups.json')
    await writeFile(request, JSON.stringify({ groups: [{ id: 'research', name: '研究', order: 0 }], expectedRegistryRevision: registryRevision(config.registry()) }))
    const output: string[] = []
    await runCli(['libraries', 'groups', 'save', '--json', request], config, text => output.push(text))
    expect(process.exitCode).toBe(0)
    const saved = JSON.parse(await readFile(config.file, 'utf8'))
    expect(saved.runtime).toEqual(initial.runtime)
    expect(saved.registry.groups).toEqual([{ id: 'research', name: '研究', order: 0 }])
    await runCli(['library', 'list'], config, text => output.push(text))
    expect(JSON.parse(output.at(-1)!)).toEqual([])
  } finally { process.exitCode = previousCode; await f.cleanup() }
})
