import type { ModelRuntime } from '../llm/client.js'
import { open, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { registrySchema } from '../domain/config-io.js'
import { parseRegistry } from '../domain/config.js'
import type { Registry } from '../domain/config.js'
import { LibraryStore } from '../storage/libraries.js'
import { WikiOperations } from '../host/wiki-operations.js'
import { modelRuntime } from '../host/models.js'
import type { CompatibleRuntimeOptions } from '../host/compatible-models.js'
import { WikiQuery } from '../wiki/query.js'
import { askWiki } from '../wiki/chat.js'
import { bindEmbeddingCredential, redactSecrets, resolveCredential } from '../llm/credentials.js'
import { searchDiscovered } from '../wiki/library-reader.js'
import { publicLibraryResult } from '../host/library-management.js'
import { discoveryError, registryRevision } from '../wiki/library-discovery.js'
import { answerGuidance } from '../wiki/page-search.js'
import { publicResult } from '../host/public-results.js'

/** 独立宿主与插件使用同一登记、策略、运行时及操作门面。 */
export function createLocalHost(input: Registry, options: CompatibleRuntimeOptions & { runtime?: ModelRuntime; running?: Map<string, AbortController>; persist?: (next: Registry, expected: Registry) => Promise<void> } = {}) {
  let registry = parseRegistry(registrySchema.parse(input)), runtime = modelRuntime(options.runtime, registry, options)
  const running = options.running ?? new Map<string, AbortController>(), store = new LibraryStore(() => registry)
  const listeners = new Set<() => void>()
  const changed = () => { for (const listener of listeners) { try { listener() } catch { /* 通知失败不回滚已提交登记。 */ } } }
  const secrets = () => [...Object.values(registry.compatibleProviders ?? {}), ...(registry.embeddingService ? [registry.embeddingService] : [])]
    .map(config => resolveCredential(config, options.env))
  const operations = new WikiOperations(store, () => runtime, running, async (next, expected) => {
    if (registryRevision(registry) !== registryRevision(expected)) throw discoveryError('REGISTRY_CONFLICT', '数据库登记已变化。')
    await options.persist?.(next, expected)
    registry = parseRegistry(structuredClone(next)); runtime = modelRuntime(options.runtime, registry, options); changed()
  }, { visible: library => library.enabled })
  const query = new WikiQuery(store, undefined, () => runtime)
  const sanitize = (value: unknown, operation?: string, additionalSecrets: readonly string[] = []) =>
    publicResult(publicLibraryResult(value), [...secrets(), ...additionalSecrets], operation)
  return {
    store, operations, query: Object.assign(query, {
      search: (question: string, name?: string, types?: string[], limit?: number, signal?: AbortSignal, options = {}) =>
        searchDiscovered(store, operations.libraries!.discovery, question, name, types, limit, signal, options, undefined, () => runtime),
    }),
    sanitize,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    get runtime() { return runtime },
    answer: (id: string, question: string, signal?: AbortSignal) => askWiki(store, id, question, [], runtime, signal),
    answerSelected: async (question: string, signal?: AbortSignal) => {
      const discovery = operations.libraries!.discovery, selection = await discovery.find(question, undefined, signal)
      const answers = []
      for (const card of selection.cards) answers.push({ libraryId: card.libraryId, ...await askWiki(store, card.libraryId, question, [], runtime, signal) })
      if (selection.selectionRevision !== (await discovery.find(question, undefined, signal)).selectionRevision) throw discoveryError('SELECTION_CHANGED', '回答期间选库依据已变化，请重新提问。')
      return { question, answers, selectedLibraries: selection.cards.map(card => card.libraryId), selectionRevision: selection.selectionRevision, answerGuidance }
    },
    stop: (id: string) => { running.get(id)?.abort(new Error('用户暂停，检查点已保留。')); return { stopping: running.has(id) } },
    dispose: () => { for (const abort of running.values()) abort.abort(new Error('本地宿主停止。')); listeners.clear() },
    // MCP/CLI 只返回白名单错误属性，绝不返回 cause、请求或凭据对象。
    failure: (error: unknown) => {
      const keys = secrets(), message = redactSecrets(error instanceof Error ? error.message : '操作未完成。', keys)
      const code = error && typeof error === 'object' && 'code' in error && /^[A-Z][A-Z0-9_]{1,60}$/.test(String(error.code)) ? String(error.code) : 'LIBRARY_ERROR'
      if (error instanceof Error && 'upgrade' in error) {
        try { return { code, message, upgrade: publicResult(error.upgrade, keys) } }
        catch { return { code, message } }
      }
      return { code, message }
    },
    replace: (next: Registry) => {
      if (running.size) throw new Error('请先暂停并等待所有在途请求结束，再重载本机模型配置。')
      const parsed = parseRegistry(registrySchema.parse(next)), updated = modelRuntime(options.runtime, parsed, options)
      registry = parsed; runtime = updated; changed()
    },
    copyEmbedding: (libraryId: string, signal?: AbortSignal) => {
      const service = registry.embeddingService
      if (!service) throw new Error('请先配置 embeddingService。')
      return operations.copyWithEmbedding({ libraryId, confirm: true, target: { embeddingMode: 'cloud', cloudEmbeddingUrl: service.baseUrl,
        cloudEmbeddingModel: service.model, cloudEmbeddingKeyEnv: bindEmbeddingCredential(service, options.env) } }, signal, options.env)
    },
  }
}
export type LocalHost = ReturnType<typeof createLocalHost>

export async function loadLocalHost(file: string, options: CompatibleRuntimeOptions = {}) {
  const absolute = path.resolve(file)
  const read = async (): Promise<Registry> => {
    let value: unknown
    try { value = JSON.parse(await readFile(absolute, 'utf8')) }
    catch { throw new Error('无法读取本机 MCP 配置 JSON，请检查文件路径和格式。') }
    let registry: Registry
    try { registry = parseRegistry(registrySchema.parse(value)) }
    catch { throw new Error('本机 MCP 配置不符合登记或模型配置规则。') }
    for (const library of registry.libraries.filter(item => item.kind !== 'whalefall')) {
      const relative = path.relative(path.resolve(library.wikiPath), absolute)
      if (!relative || !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative)) throw new Error('含凭据的 MCP 配置文件必须位于库目录之外。')
    }
    return registry
  }
  const host = createLocalHost(await read(), { ...options, persist: async (next, expected) => {
    const lockPath = absolute + '.lock'
    let lock
    try { lock = await open(lockPath, 'wx', 0o600) }
    catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') throw discoveryError('REGISTRY_CONFLICT', '本机配置正在写入，请稍后重读。'); throw error }
    const temporary = absolute + '.' + randomUUID() + '.tmp'
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })); await lock.sync()
      if (registryRevision(await read()) !== registryRevision(expected)) throw discoveryError('REGISTRY_CONFLICT', '本机 MCP 配置已变化，请重载后重试。')
      await writeFile(temporary, JSON.stringify(next, null, 2), { encoding: 'utf8', flag: 'wx', mode: 0o600 }); await rename(temporary, absolute)
    } finally {
      await lock.close(); await unlink(lockPath)
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error })
    }
  } })
  return Object.assign(host, { reload: async () => host.replace(await read()) })
}
