import { z } from 'zod'
import { createRequire } from 'node:module'
import type { LocalHost } from '../local/host.js'
import { callLibraryTool, libraryTools, libraryResourceTemplate, listLibraryResources } from '../host/library-management.js'
import { generationChoiceShape, generationSelectionDescription, generationSelectionInstructions, withMcpGenerationSelection } from './generation-selection.js'

const { version } = createRequire(import.meta.url)('../../package.json') as { version: string }
const id = z.string().min(1), empty = z.strictObject({})
export const localToolInputs = {
  wiki_list_libraries: empty,
  wiki_search: z.strictObject({ query: z.string().min(1), library: id.optional() }),
  wiki_answer: z.strictObject({ libraryId: id.optional(), question: z.string().min(1) }),
  wiki_browse: z.strictObject({ library: id, ref: id.optional(), cursor: id.optional(), depth: z.number().int().min(1).max(2).optional(), limit: z.number().int().positive().max(50).optional() }),
  wiki_read: z.strictObject({ library: id, path: id, version: id.optional(), offset: z.number().int().nonnegative().optional(), maxChars: z.number().int().positive().optional() }),
  wiki_source_read: z.strictObject({ library: id, sourceId: id, locator: id, version: id.optional(), sourceVersion: id.optional(), offset: z.number().int().nonnegative().optional(), maxChars: z.number().int().positive().optional() }),
  wiki_generate: z.strictObject({ libraryId: id, action: z.enum(['scan', 'generate']).default('generate'),
    ...generationChoiceShape,
    retrySources: z.strictObject({ sourceIds: z.array(id).min(1), kinds: z.array(z.enum(['summary', 'review'])).min(1) }).optional() }),
  wiki_changes: z.strictObject({ libraryId: id, action: z.enum(['list', 'preview', 'commit', 'cancel']), batchId: id.optional(), digest: id.optional() }),
  wiki_status: z.strictObject({ libraryId: id, version: id.optional() }),
  wiki_pause: z.strictObject({ libraryId: id }),
  wiki_copy_with_embedding: z.strictObject({ libraryId: id, confirm: z.literal(true) }),
  wiki_retry_topic_gaps: z.strictObject({ libraryId: id, topicIds: z.array(id).optional(), reasons: z.array(id).optional() }),
} as const

/** 独立 MCP 复用宿主的查询、登记锁与发现服务。 */
export function createMcpHandler(host: LocalHost, notify?: (message: unknown) => void) {
  const services = host.operations.libraries!, subscribed = new Set<string>()
  let initialized = false
  const dispose = host.subscribe(() => {
    if (!initialized) return
    notify?.({ jsonrpc: '2.0', method: 'notifications/resources/list_changed' })
    for (const uri of subscribed) notify?.({ jsonrpc: '2.0', method: 'notifications/resources/updated', params: { uri } })
  })
  const handle = async (request: { jsonrpc?: string; id?: number | string | null; method: string; params?: { name?: string; arguments?: unknown; cursor?: string; uri?: string } }) => {
    if (request.method === 'notifications/initialized') initialized = true
    if (request.id === undefined) return
    const result = (value: unknown) => ({ jsonrpc: '2.0', id: request.id, result: value })
    if (request.method === 'initialize') return result({ protocolVersion: '2024-11-05', capabilities: { tools: {}, resources: { listChanged: true, subscribe: true } }, serverInfo: { name: 'llmwiki-local', version }, instructions: generationSelectionInstructions })
    if (request.method === 'ping') return result({})
    if (request.method === 'tools/list') return result({ tools: [...Object.entries(localToolInputs).filter(([name]) => !libraryTools.some(tool => tool.name === name)).map(([name, schema]) => ({ name, inputSchema: z.toJSONSchema(schema), ...(name === 'wiki_generate' ? { description: generationSelectionDescription } : {}) })), ...libraryTools] })
    try {
      if (request.method === 'resources/list') return result(host.sanitize(await listLibraryResources(services, request.params?.cursor), request.method))
      if (request.method === 'resources/templates/list') return result({ resourceTemplates: [libraryResourceTemplate] })
      if (['resources/read', 'resources/subscribe', 'resources/unsubscribe'].includes(request.method)) {
        const uri = id.parse(request.params?.uri), card = await services.discovery.resource(uri)
        if (request.method === 'resources/read') return result(host.sanitize(card, request.method))
        if (request.method === 'resources/subscribe') subscribed.add(uri); else subscribed.delete(uri)
        return result({})
      }
      if (request.method !== 'tools/call') return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: '不支持的 MCP 方法。' } }
      if (libraryTools.some(tool => tool.name === request.params?.name)) {
        const value = await callLibraryTool(services, request.params!.name!, request.params?.arguments ?? {})
        return result({ content: [{ type: 'text', text: JSON.stringify(host.sanitize(value, request.params!.name!)) }] })
      }
      const name = request.params?.name as keyof typeof localToolInputs
      if (!Object.hasOwn(localToolInputs, name)) throw new Error('工具不存在。')
      const raw = request.params?.arguments ?? {}, signal = new AbortController().signal
      let value: unknown
      switch (name) {
        case 'wiki_list_libraries': localToolInputs[name].parse(raw); value = await host.query.catalog(signal); break
        case 'wiki_search': { const args = localToolInputs[name].parse(raw); value = await host.query.search(args.query, args.library, undefined, 8, signal); break }
        case 'wiki_answer': { const args = localToolInputs[name].parse(raw); value = args.libraryId ? await host.answer(args.libraryId, args.question, signal) : await host.answerSelected(args.question, signal); break }
        case 'wiki_browse': { const args = localToolInputs[name].parse(raw); value = await host.query.browse(args.library, args.ref, args, signal); break }
        case 'wiki_read': { const args = localToolInputs[name].parse(raw); value = await host.query.read(args.path, args.library, args.maxChars, signal, args); break }
        case 'wiki_source_read': { const args = localToolInputs[name].parse(raw); value = await host.query.sourceRead(args.sourceId, args.locator, args.library, { ...args, signal }); break }
        case 'wiki_generate': {
          const args = localToolInputs[name].parse(raw)
          value = await withMcpGenerationSelection(host.store, args, host.operations.running,
            () => host.operations.generate(args.libraryId, args.action, signal, undefined, false, undefined, undefined, undefined, args.retrySources)); break
        }
        case 'wiki_changes': { const args = localToolInputs[name].parse(raw); value = await host.operations.changes(args.libraryId, args.action, signal, args.batchId, args.digest); break }
        case 'wiki_status': { const args = localToolInputs[name].parse(raw); value = await host.operations.productionStatus(args.libraryId, args.version); break }
        case 'wiki_pause': { const args = localToolInputs[name].parse(raw); value = host.stop(args.libraryId); break }
        case 'wiki_copy_with_embedding': { const args = localToolInputs[name].parse(raw); value = await host.copyEmbedding(args.libraryId, signal); break }
        case 'wiki_retry_topic_gaps': { const args = localToolInputs[name].parse(raw); value = await host.operations.retryTopicGaps(args.libraryId, signal, {
          ...(args.topicIds ? { topicIds: args.topicIds } : {}), ...(args.reasons ? { reasons: args.reasons } : {}),
        }); break }
      }
      return result({ content: [{ type: 'text', text: JSON.stringify(host.sanitize(value, name === 'wiki_list_libraries' ? 'catalog' : name)) }] })
    } catch (error) {
      const failure = host.failure(error)
      if (request.method !== 'tools/call') return { jsonrpc: '2.0', id: request.id, error: { code: -32602, message: failure.message, data: failure } }
      return result({ isError: true, content: [{ type: 'text', text: JSON.stringify(failure) }] })
    }
  }
  return Object.assign(handle, { dispose })
}
