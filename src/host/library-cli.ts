import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { callLibraryTool } from './library-management.js'
import type { LibraryServices } from './library-management.js'
import { discoveryError } from '../wiki/library-discovery.js'

export interface LibraryCliIO { stdin(): Promise<string>; stdout(text: string): void; stderr(text: string): void; sanitize?(value: unknown, operation?: string): unknown }
/** local CLI 启动入口调用此函数；不启动网页进程、不改变 stdio MCP。 */
export async function runLibrariesCli(argv: string[], services: LibraryServices, io: LibraryCliIO): Promise<number> {
  try {
    const args = [...argv]
    if (args.shift() !== 'libraries') throw discoveryError('INVALID_ARGUMENT', '命令须以 libraries 开始。')
    const command = args.shift(), sub = command === 'groups' || command === 'summary' ? args.shift() : undefined
    let request: unknown = {}
    if (args.length) {
      if (args.length !== 2 || args[0] !== '--json') throw discoveryError('INVALID_ARGUMENT', '请求使用 --json <文件> 或 --json -。')
      try { request = JSON.parse(args[1] === '-' ? await io.stdin() : await readFile(args[1]!, 'utf8')) }
      catch { throw discoveryError('INVALID_ARGUMENT', '无法读取 UTF-8 JSON 请求。') }
    }
    let value: unknown, operation: string | undefined
    if (command === 'groups') {
      operation = 'groups/' + sub
      if (sub === 'list') { const view = services.management.view(); value = { groups: view.registry.groups ?? [], registryRevision: view.registryRevision } }
      else if (sub === 'save') {
        const input = z.strictObject({ groups: z.array(z.unknown()), expectedRegistryRevision: z.string().min(1) }).parse(request)
        value = await services.management.organization({ groups: input.groups }, input.expectedRegistryRevision)
      } else throw discoveryError('INVALID_ARGUMENT', 'groups 支持 list/save。')
    } else if (command === 'summary') {
      operation = 'summary/' + sub
      if (sub === 'refresh') {
        const input = z.strictObject({ libraryId: z.string().min(1), expectedRegistryRevision: z.string().min(1) }).parse(request)
        value = await services.summaries.refresh(input.libraryId, input.expectedRegistryRevision)
      } else if (sub === 'unlock') {
        const input = z.strictObject({ libraryId: z.string().min(1), tier: z.enum(['short', 'long']), expectedRegistryRevision: z.string().min(1) }).parse(request)
        value = await services.management.update(input.libraryId, { summary: { [input.tier]: { unlock: true } } }, input.expectedRegistryRevision)
      } else throw discoveryError('INVALID_ARGUMENT', 'summary 支持 refresh/unlock。')
    } else {
      const tools: Record<string, string> = { list: 'wiki_list_libraries', find: 'wiki_find_library', show: 'wiki_library_card', register: 'wiki_register_library', update: 'wiki_update_library', unregister: 'wiki_unregister_library' }
      const tool = tools[command ?? '']
      if (!tool) throw discoveryError('INVALID_ARGUMENT', '不支持的 libraries 子命令。')
      value = await callLibraryTool(services, tool, request)
      operation = tool
    }
    io.stdout(JSON.stringify(io.sanitize ? io.sanitize(value, operation) : value) + '\n'); return 0
  } catch (error) {
    const code = error instanceof z.ZodError ? 'INVALID_ARGUMENT' : error && typeof error === 'object' && 'code' in error ? String(error.code) : 'LIBRARY_ERROR'
    const value = { error: { code, message: error instanceof Error ? error.message : String(error),
      ...(error && typeof error === 'object' && 'draft' in error ? { draft: error.draft } : {}) } }
    io.stderr(JSON.stringify(io.sanitize ? io.sanitize(value) : value) + '\n')
    return code === 'INVALID_ARGUMENT' ? 2 : code === 'REGISTRY_CONFLICT' ? 3 : 1
  }
}
