#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { format } from 'node:util'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { LocalConfigStore } from './local/config.js'
import { createMcpServer } from './mcp/server.js'
import { localError } from './local/jobs.js'
import { redactSecrets } from './local/runtime.js'

export async function runCli(args: string[], config = new LocalConfigStore(), output: (value: string) => void = console.log) {
  await config.load()
  if (args[0] === 'mcp' && args.length === 1) {
    // stdio 的 stdout 只传 MCP；核心日志在入口转到 stderr 并遮蔽环境变量密钥。
    console.log = console.info = (...values: unknown[]) => process.stderr.write(redactSecrets(format(...values)) + '\n')
    const { server, jobs } = createMcpServer(config)
    const shutdown = () => { void jobs.close().finally(() => server.close()) }
    server.server.onclose = () => { void jobs.close() }
    process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown)
    await server.connect(new StdioServerTransport())
    return
  }
  if (args[0] === 'library') {
    let result: unknown
    if (args[1] === 'list' && args.length === 2) result = config.registry().libraries
    else if (args[1] === 'remove' && args.length === 3) result = await config.remove(args[2]!)
    else if (args[1] === 'add' && args[2] && (args.length === 3 || args.length === 5 && args[3] === '--name' && args[4]?.trim())) result = await config.add(args[2], args[4])
    else throw new Error('用法：library add <资料目录> [--name <名称>] | library list | library remove <id>')
    output(JSON.stringify(result, null, 2)); return
  }
  if (!args.length || args[0] === '--help') { output('llmwiki-local mcp\nllmwiki-local library add <资料目录> [--name <名称>]\nllmwiki-local library list\nllmwiki-local library remove <id>'); return }
  throw new Error('未知命令；使用 --help 查看用法。')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli(process.argv.slice(2)).catch(error => { console.error(localError(error)); process.exitCode = 1 })
}
