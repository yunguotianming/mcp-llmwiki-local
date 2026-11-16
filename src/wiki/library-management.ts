import { z } from 'zod'
import { parseRegistry } from '../domain/config.js'
import type { LibraryRegistration, Registry } from '../domain/config.js'
import { registryOrganizationSchema } from '../domain/registry-schema.js'
import type { LibraryOrganization } from '../domain/registry-schema.js'
import type { LibraryStore } from '../storage/libraries.js'
import { discoveryError, librarySummary, registryRevision } from './library-discovery.js'

const editTier = (max: number) => z.union([z.strictObject({ text: z.string().max(max) }), z.strictObject({ unlock: z.literal(true) })])
const patchSchema = z.strictObject({
  name: z.string().trim().min(1).optional(), description: z.string().optional(), enabled: z.boolean().optional(),
  wikiPath: z.string().optional(), sourceRoots: z.array(z.string()).optional(), vaultPath: z.string().optional(), location: z.string().optional(),
  groupId: z.string().min(1).nullable().optional(), pinned: z.boolean().optional(), order: z.number().int().nonnegative().optional(),
  summary: z.strictObject({ short: editTier(80).optional(), long: editTier(1200).optional() }).optional(),
})
export type LibraryPatch = z.infer<typeof patchSchema>
export interface RegistryAdapter {
  /** 由 B5 在宿主配置锁下复核完整 expected 并原子保存；服务不直接写配置文件。 */
  write(next: Registry, expected: Registry): Promise<void>
  prepare(registration: unknown): Promise<LibraryRegistration>
  busy?(id: string): boolean
  changed?(): void | Promise<void>
}
export class LibraryManagement {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(readonly store: LibraryStore, private readonly adapter: RegistryAdapter) {}
  view() { const registry = this.store.snapshot(); return { registry, registryRevision: registryRevision(registry) } }
  private async commit(expectedRevision: string, draft: unknown, change: (next: Registry) => void | Promise<void>) {
    const run = async () => {
      const before = this.store.snapshot(), next = structuredClone(before)
      await change(next)
      const parsed = parseRegistry(next), currentRevision = registryRevision(before)
      if (registryRevision(parsed) === currentRevision) return { registry: before, registryRevision: currentRevision }
      if (expectedRevision !== currentRevision) throw discoveryError('REGISTRY_CONFLICT', '登记已被其他入口修改；草稿已保留。', draft)
      try { await this.adapter.write(parsed, before) }
      catch (error) {
        if (registryRevision(this.store.snapshot()) !== currentRevision || error && typeof error === 'object' && 'httpStatus' in error && error.httpStatus === 409)
          throw discoveryError('REGISTRY_CONFLICT', '保存时登记发生变化；草稿已保留。', draft)
        throw error
      }
      // 通知失败不能把已保存的登记报告为未保存。
      await Promise.resolve().then(() => this.adapter.changed?.()).catch(() => {})
      return { registry: parsed, registryRevision: registryRevision(parsed) }
    }
    const result = this.queue.then(run, run); this.queue = result.catch(() => {}); return result
  }
  async register(registration: unknown, expectedRegistryRevision: string) {
    const library = await this.adapter.prepare(registration)
    const result = await this.commit(expectedRegistryRevision, registration, next => {
      const previous = next.libraries.find(item => item.id === library.id)
      if (previous) {
        if (previous.wikiPath !== library.wikiPath) throw discoveryError('LIBRARY_ID_CONFLICT', '同一库身份已登记在其他路径。')
        return
      }
      next.libraries.push(library)
      if (!next.activeLibraryId) next.activeLibraryId = library.id
    })
    return { libraryId: library.id, registryRevision: result.registryRevision, registration: result.registry.libraries.find(item => item.id === library.id)! }
  }
  async update(libraryId: string, input: unknown, expectedRegistryRevision: string) {
    const parsed = patchSchema.safeParse(input)
    if (!parsed.success) throw discoveryError('INVALID_ARGUMENT', '登记补丁字段或简介长度无效。', input)
    const patch = parsed.data
    const result = await this.commit(expectedRegistryRevision, input, async next => {
      const library = next.libraries.find(item => item.id === libraryId)
      if (!library) throw discoveryError('NOT_FOUND', '库未登记。')
      const relocating = ['wikiPath', 'sourceRoots', 'vaultPath'].some(key => key in patch && JSON.stringify(patch[key as keyof LibraryPatch]) !== JSON.stringify(library[key as keyof LibraryRegistration]))
      if (relocating && this.adapter.busy?.(libraryId)) throw discoveryError('LIBRARY_BUSY', '库正在运行，不能改变路径。', input)
      const { summary, description, ...fields } = patch
      Object.assign(library, fields)
      if (relocating) {
        const checked = await this.adapter.prepare(library)
        if (checked.id !== libraryId) throw discoveryError('LIBRARY_ID_CONFLICT', '新路径的库身份不一致。')
      }
      if (summary || description !== undefined) {
        library.summary = librarySummary(library)
        if (description !== undefined) {
          if (description.length > 1200) throw discoveryError('INVALID_ARGUMENT', '长简介最多 1200 字符。')
          library.description = description
          library.summary.long = { text: description, origin: 'manual', locked: true, sourceVersion: library.publishedVersion ?? null }
        }
        for (const tier of ['short', 'long'] as const) {
          const edit = summary?.[tier]
          if (!edit) continue
          if ('text' in edit) library.summary[tier] = { text: edit.text, origin: 'manual', locked: true, sourceVersion: library.publishedVersion ?? null }
          else if (library.summary[tier]) {
            library.summary[tier]!.locked = false
            // 解锁后显式刷新当前版本，不能被同版零调用判断跳过。
            library.summary[tier]!.sourceVersion = null
            library.summaryStatus = 'pending'
          }
        }
      }
    })
    return { registration: result.registry.libraries.find(item => item.id === libraryId)!, registryRevision: result.registryRevision }
  }
  async unregister(libraryId: string, expectedRegistryRevision: string) {
    let removed = false
    const result = await this.commit(expectedRegistryRevision, { libraryId }, next => {
      removed = next.libraries.some(item => item.id === libraryId)
      if (removed && this.adapter.busy?.(libraryId)) throw discoveryError('LIBRARY_BUSY', '库正在运行，不能移除登记。')
      next.libraries = next.libraries.filter(item => item.id !== libraryId)
      if (next.activeLibraryId === libraryId) next.activeLibraryId = next.libraries[0]?.id ?? ''
    })
    return { removed, registryRevision: result.registryRevision }
  }
  async organization(input: unknown, expectedRegistryRevision: string) {
    const parsed = registryOrganizationSchema.safeParse(input)
    if (!parsed.success) throw discoveryError('INVALID_ARGUMENT', '分组或发现设置无效。', input)
    return this.commit(expectedRegistryRevision, input, next => {
      Object.assign(next, parsed.data)
      const ids = new Set(next.groups?.map(group => group.id))
      for (const library of next.libraries) if (library.groupId && !ids.has(library.groupId)) library.groupId = null
    })
  }
  /** 工作区/CLI 的整份组织草稿只改变组织字段，不能夹带凭据或解锁。 */
  async saveDraft(draft: Registry, expectedRegistryRevision: string) {
    return this.commit(expectedRegistryRevision, draft, next => {
      if (next.libraries.length !== draft.libraries.length || next.libraries.some(item => !draft.libraries.some(other => other.id === item.id)))
        throw discoveryError('INVALID_ARGUMENT', '批量草稿不能新增或移除登记。', draft)
      const organization = registryOrganizationSchema.parse({ groups: draft.groups, discovery: draft.discovery })
      Object.assign(next, organization)
      for (const library of next.libraries) {
        const proposed = draft.libraries.find(item => item.id === library.id)!
        for (const key of ['groupId', 'pinned', 'order'] as const) {
          if (proposed[key] === undefined) delete library[key]
          else Object.assign(library, { [key]: proposed[key] })
        }
      }
    })
  }
  /** 自动刷新只用服务内部入口，提交时同时核对登记修订与档位状态。 */
  async saveSummary(libraryId: string, organization: LibraryOrganization, expectedRegistryRevision: string) {
    return this.commit(expectedRegistryRevision, organization, next => {
      const library = next.libraries.find(item => item.id === libraryId)
      if (!library) throw discoveryError('NOT_FOUND', '库已取消登记。')
      Object.assign(library, organization)
    })
  }
}
