import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { expect, it, vi } from 'vitest'
import path from 'node:path'
import { LocalConfigStore } from '../src/local/config.js'
import { fixture } from './query-pages-audit-fixture.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
it('构建产物 stdio 握手、列出九工具并成功查询一次', async () => {
  const f = await fixture(), config = new LocalConfigStore(path.join(f.temp, 'home'))
  await config.load(); f.library.layered = { embeddingMode: 'none' }
  await config.writeRegistry(f.registry, config.registry())
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined))
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve('dist/cli.js'), 'mcp'],
    env: { ...env, LLMWIKI_LOCAL_HOME: config.home, DEEPSEEK_API_KEY: '' }, stderr: 'pipe' })
  const client = new Client({ name: 'stdio验收', version: '1' })
  let diagnostics = ''; transport.stderr?.on('data', chunk => { diagnostics += String(chunk) })
  try {
    await client.connect(transport)
    const tools = await client.listTools(); expect(tools.tools).toHaveLength(9)
    const result = await client.callTool({ name: 'wiki_search', arguments: { query: '审查证据', variants: ['审查'], include: 'hits' } })
    expect(result.isError, diagnostics).not.toBe(true)
    const value = JSON.parse((result.content as { text: string }[])[0]!.text)
    expect(value.total).toBeGreaterThan(0)
    console.log(JSON.stringify({ transport: 'stdio', tools: tools.tools.length, query: '审查证据', hits: value.total }))
  } finally { await client.close(); await transport.close(); cleanupLayeredFixtures(); f.cleanup() }
}, 15000)
