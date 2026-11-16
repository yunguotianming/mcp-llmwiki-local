import { randomUUID } from 'node:crypto'
import { actualPath } from '../storage/paths.js'
import { z } from 'zod'
import { newLibrary } from '../domain/config.js'
import type { Registry } from '../domain/config.js'
import { registrySchema } from '../domain/config-io.js'
import type { LibraryStore } from '../storage/libraries.js'
import type { ModelRuntime } from '../llm/client.js'
import { inspectDirectory } from './directory-inspection.js'
import { createBuildModelClient } from './models.js'
import { createLibraryDiscovery } from '../wiki/library-reader.js'
import { discoveryError } from '../wiki/library-discovery.js'
import type { DiscoveryBackend, LibraryDiscovery } from '../wiki/library-discovery.js'
import { LibraryManagement } from '../wiki/library-management.js'
import { createSummaryRunner, LibrarySummaries } from '../wiki/library-summaries.js'

export function createLibraryServices(store: LibraryStore, write: (next: Registry, expected: Registry) => Promise<void>,
  runtime: () => ModelRuntime | undefined, running: Map<string, AbortController>, visible?: DiscoveryBackend['visible'], changed?: () => void | Promise<void>) {
  const discovery = createLibraryDiscovery(store, visible)
  const management = new LibraryManagement(store, {
    write, busy: id => running.has(id), ...(changed ? { changed } : {}),
    async prepare(input) {
      if (!input || typeof input !== 'object' || Array.isArray(input)) throw discoveryError('INVALID_ARGUMENT', '登记须为对象。')
      const registration = registrySchema.shape.libraries.element.parse({ ...newLibrary(randomUUID()), ...input })
      if (registration.kind !== 'whalefall') {
        let inspected
        try { inspected = await inspectDirectory(registration.wikiPath, undefined, store) }
        catch { throw discoveryError('INVALID_PATH', 'Wiki 目录不可读或格式无效。') }
        const existingId = 'identityId' in inspected && inspected.identityId || inspected.libraryId
        if (existingId) registration.id = existingId
        const target = (await actualPath(registration.wikiPath)).toLowerCase()
        for (const previous of store.snapshot().libraries.filter(item => item.kind !== 'whalefall')) {
          if ((await actualPath(previous.wikiPath)).toLowerCase() === target) {
            if (existingId && existingId !== previous.id) throw discoveryError('LIBRARY_ID_CONFLICT', '随库身份与已登记身份不一致。')
            registration.id = previous.id; registration.wikiPath = previous.wikiPath; break
          }
        }
        // 保留已有登记路径；目录检查只取身份，不重写默认路径或组织字段。
        if ('locks' in inspected && inspected.locks?.length) throw discoveryError('LIBRARY_BUSY', '目录仍有写入锁。')
      }
      return registration
    },
  })
  const summaries = new LibrarySummaries(management, discovery, async library => {
    const model = runtime()
    if (!model) throw discoveryError('MODEL_UNAVAILABLE', '宿主模型服务尚未连接。')
    const policy = await store.policy(library.id)
    const client = createBuildModelClient(model, library, policy.policy, store.snapshot())
    if (!client.bindRecovery) throw discoveryError('ACCEPTANCE_BINDING_REQUIRED', '简介需要持久化接受接点。')
    return { run: createSummaryRunner(client.bindRecovery, { knowledgeRoot: library.wikiPath, wikiPath: library.wikiPath, client }),
      ...(client.upgradeOptions ? { upgradeOptions: client.upgradeOptions } : {}) }
  })
  return { discovery, management, summaries }
}
export interface LibraryServices { discovery: LibraryDiscovery; management: LibraryManagement; summaries: LibrarySummaries }
/** 对外管理结果不传本机密钥；修订仍由完整内部登记计算。 */
export function publicLibraryResult(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value, (key, item: unknown) => key === 'apiKey' ? undefined : item)) as unknown
}
const id = z.string().min(1), revision = z.string().min(1)
const schemas = {
  wiki_list_libraries: z.strictObject({ cursor: z.string().optional(), limit: z.number().int().min(1).max(50).optional(), groupId: z.string().nullable().optional() }),
  wiki_find_library: z.strictObject({ question: z.string().trim().min(1).max(2000), limit: z.number().int().min(1).max(5).optional() }),
  wiki_library_card: z.strictObject({ libraryId: id }),
  wiki_register_library: z.strictObject({ registration: z.record(z.string(), z.unknown()), expectedRegistryRevision: revision }),
  wiki_update_library: z.strictObject({ libraryId: id, patch: z.record(z.string(), z.unknown()), expectedRegistryRevision: revision }),
  wiki_unregister_library: z.strictObject({ libraryId: id, expectedRegistryRevision: revision }),
}
export const libraryTools = Object.entries(schemas).map(([name, schema]) => ({ name, inputSchema: schema.toJSONSchema(),
  description: ({ wiki_list_libraries: '分页列出可见库的短目录。', wiki_find_library: '按问题匹配库简介与顶层主题。', wiki_library_card: '按需读取库卡片。',
    wiki_register_library: '登记已有库，不创建页面。', wiki_update_library: '按修订修改库登记、组织或简介；手改档位自动锁定。', wiki_unregister_library: '只取消登记，保留库文件。' } as Record<string, string>)[name]! }))

/** 插件、MCP、工作区、CLI 共用分派；宿主负责自己的授权与配置写锁。 */
export async function callLibraryTool(services: LibraryServices, name: string, input: unknown, signal?: AbortSignal) {
  signal?.throwIfAborted()
  const schema = schemas[name as keyof typeof schemas]
  if (!schema) throw discoveryError('NOT_FOUND', '库管理工具不存在。')
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw discoveryError('INVALID_ARGUMENT', '工具参数无效。', input)
  switch (name) {
    case 'wiki_list_libraries': return services.discovery.list(schemas.wiki_list_libraries.parse(input), signal)
    case 'wiki_find_library': { const args = schemas.wiki_find_library.parse(input); return services.discovery.find(args.question, args.limit, signal) }
    case 'wiki_library_card': return services.discovery.show(schemas.wiki_library_card.parse(input).libraryId, signal)
    case 'wiki_register_library': { const args = schemas.wiki_register_library.parse(input); return services.management.register(args.registration, args.expectedRegistryRevision) }
    case 'wiki_update_library': { const args = schemas.wiki_update_library.parse(input); return services.management.update(args.libraryId, args.patch, args.expectedRegistryRevision) }
    case 'wiki_unregister_library': { const args = schemas.wiki_unregister_library.parse(input); return services.management.unregister(args.libraryId, args.expectedRegistryRevision) }
    default: throw discoveryError('NOT_FOUND', '库管理工具不存在。')
  }
}
export async function listLibraryResources(services: LibraryServices, cursor?: string, signal?: AbortSignal) {
  const page = await services.discovery.list({ cursor }, signal)
  return { resources: page.libraries.map(library => ({ uri: library.cardUri, name: library.name, description: library.description, mimeType: 'application/json' })),
    ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) }
}
export const libraryResourceTemplate = { uriTemplate: 'llmwiki://libraries/{libraryId}/card', name: 'Wiki 库卡片', mimeType: 'application/json' }

export async function callLibraryManagement(services: LibraryServices, action: string, input: unknown, signal?: AbortSignal) {
  const scoped = z.strictObject({ libraryId: id, expectedRegistryRevision: revision })
  switch (action) {
    case 'directory/preview': z.strictObject({}).parse(input); return services.discovery.l0(signal)
    case 'registry/get': z.strictObject({}).parse(input); return services.management.view()
    case 'organization/save': {
      const args = z.strictObject({ organization: z.unknown(), expectedRegistryRevision: revision }).parse(input)
      return services.management.organization(args.organization, args.expectedRegistryRevision)
    }
    case 'organization/draft': {
      const args = z.strictObject({ registry: registrySchema, expectedRegistryRevision: revision }).parse(input)
      const workspace = new LibraryWorkspace(services)
      workspace.load(); workspace.draft = args.registry; workspace.revision = args.expectedRegistryRevision
      // saveDraft 只接收组织字段，省略密钥的公共草稿不会覆盖宿主凭据。
      return workspace.save()
    }
    case 'summary/refresh': { const args = scoped.parse(input); return services.summaries.refresh(args.libraryId, args.expectedRegistryRevision, signal) }
    case 'summary/confirm': { const args = scoped.parse(input); return services.summaries.confirmReview(args.libraryId, args.expectedRegistryRevision, signal) }
    default: return callLibraryTool(services, action, input, signal)
  }
}

/** 供 B5 工作区绑定：冲突时保留草稿和旧修订，重新读取不会悄悄覆盖编辑。 */
export class LibraryWorkspace {
  draft: Registry | undefined
  revision = ''
  constructor(private readonly services: LibraryServices) {}
  load() {
    const view = this.services.management.view()
    this.draft ??= structuredClone(view.registry)
    if (!this.revision) this.revision = view.registryRevision
    return view
  }
  async save() {
    if (!this.draft) throw discoveryError('INVALID_ARGUMENT', '请先读取登记草稿。')
    const result = await this.services.management.saveDraft(this.draft, this.revision)
    this.draft = structuredClone(result.registry); this.revision = result.registryRevision; return result
  }
}

export interface SkillRegistry {
  register(skill: { name: string; description: string; source: string; content: string }): () => void
}
export async function registerLibrarySkill(skills: SkillRegistry, discovery: LibraryDiscovery, signal?: AbortSignal) {
  const directory = await discovery.l0(signal)
  return skills.register({ name: 'llmwiki', source: 'runtime', description: '本地 Wiki 库发现：' + JSON.stringify(directory),
    content: '知识问题先用 wiki_find_library(question) 选库，再用 wiki_library_card 或库卡片 resource 看范围。用 wiki_browse 下钻，wiki_search 检索、wiki_read 读页；原文用 wiki_source_read。未指定库的 search 自动选库，无匹配时改写问题或明确指定库。wiki_catalog/wiki_list_libraries 按 nextCursor 续页。卡片只是导航，查询时重新核对权限与版本。登记写操作携带 expectedRegistryRevision；移除只取消登记，手改简介锁定对应档位。' })
}

/** 动态 provider 每次按当前会话重读 L0，避免撤权后仍用已缓存的短简介。 */
export function registerLibrarySkillProvider(skills: { registerProvider(factory: () => {
  name: string; list(options: { signal?: AbortSignal }): Promise<unknown>; get(candidate: unknown, options: { signal?: AbortSignal }): Promise<unknown>
}): () => void }, discovery: LibraryDiscovery, available: () => boolean) {
  const definition = async (signal?: AbortSignal) => {
    let value: Parameters<SkillRegistry['register']>[0] | undefined
    await registerLibrarySkill({ register: skill => { value = skill; return () => {} } }, discovery, signal)
    return { ...value!, provider: 'llmwiki', invocation: { modelInvocable: true, userInvocable: true } }
  }
  return skills.registerProvider(() => ({ name: 'llmwiki',
    async list(options) {
      if (!available()) return { candidates: [], complete: false }
      const { content: _content, ...summary } = await definition(options.signal)
      return { candidates: [{ ...summary, rank: 250, locator: 'llmwiki' }], complete: false }
    },
    async get(_candidate, options) { return available() ? definition(options.signal) : undefined },
  }))
}
