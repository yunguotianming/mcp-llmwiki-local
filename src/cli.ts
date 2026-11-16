#!/usr/bin/env node
import { pathToFileURL } from 'node:url'
import { format } from 'node:util'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { LocalConfigStore } from './local/config.js'
import { createMcpServer } from './mcp/server.js'
import { localError } from './local/jobs.js'
import { createLocalRuntime, redactionSecrets, redactSecrets } from './local/runtime.js'
import { createLocalHost } from './local/host.js'
import { runLibrariesCli } from './host/library-cli.js'
import { publicResult } from './host/public-results.js'

export async function runCli(args: string[], config = new LocalConfigStore(), output: (value: string) => void = console.log) {
  await config.load()
  if (args[0] === 'libraries') {
    const host = createLocalHost(config.registry(), { runtime: createLocalRuntime(config.snapshot().runtime), persist: config.writeRegistry })
    try {
      process.exitCode = await runLibrariesCli(args, host.operations.libraries!, {
        stdin: async () => { let value = ''; for await (const chunk of process.stdin) value += String(chunk); return value },
        stdout: value => output(value.trimEnd()), stderr: value => process.stderr.write(redactSecrets(value, config.secrets())),
        sanitize: (value, operation) => host.sanitize(value, operation, redactionSecrets(config.secrets())),
      })
    } finally { host.dispose() }
    return
  }
  if (args[0] === 'mcp' && args.length === 1) {
    // stdio 的 stdout 只传 MCP；日志遮蔽环境变量与本机配置中的密钥。
    console.log = console.info = console.warn = console.error = (...values: unknown[]) => process.stderr.write(redactSecrets(format(...values), config.secrets()) + '\n')
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
    output(JSON.stringify(publicResult(result, redactionSecrets(config.secrets()), args[1] === 'list' ? 'registrations' : args[1] === 'add' ? 'library' : 'library/remove', '[已隐藏]'), null, 2))
    return
  }
  if (!args.length || args[0] === '--help') { output('llmwiki-local mcp\nllmwiki-local library add <资料目录> [--name <名称>]\nllmwiki-local library list\nllmwiki-local library remove <id>\nllmwiki-local libraries <list|find|show|register|update|unregister|groups|summary> [--json <文件或->]'); return }
  throw new Error('未知命令；使用 --help 查看用法。')
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const config = new LocalConfigStore()
  runCli(process.argv.slice(2), config).catch(error => { console.error(localError(error, config.secrets())); process.exitCode = 1 })
}
