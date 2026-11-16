import { granularityTier } from '../domain/granularity.js'
import { mkdir, readFile, open, unlink, stat } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { parse } from 'yaml'
import type { LibraryRegistration, Registry } from '../domain/config.js'
import { isWritable, migrateRegistry, newLibrary, validateRegistry } from '../domain/config.js'
import { defaultPolicy, processingPolicy } from '../domain/policy.js'
import { policySchema } from '../domain/policy-schema.js'
import { actualPath, initializeStateLayout, isLayeredRoot, safePath, stateDirectory, validateRoots, within } from './paths.js'
import { clearHiddenAttribute, readOptional, signature, writeState } from './files.js'
import { withLibraryLock } from './lock.js'
import { readSharedManifest } from './manifest.js'
import { migrateJobStorage } from './jobs.js'
import { identityFiles, recoverIdentity, replaceIdentity } from './identity.js'
import { localDevice } from '../layered/devices.js'
import { withRevocationLock } from '../layered/files.js'
import { registeredEmbedding } from './embedding-registration.js'
interface Metadata { libraryId: string; formatVersion: 1; protocolVersion: 1 }
interface SharedWriter { protocolVersion: number; writer: string; capabilities: string[] }
export interface PolicyView { policy: ReturnType<typeof defaultPolicy>; revision: string; initialized: boolean; writable: boolean; message: string }
export class LibraryStore {
  constructor(private readonly registry: () => Registry) {}
  async copiedIdentity(input: string) {
    const root = await actualPath(input)
    const metadata = await readOptional<Metadata>(await safePath(root, '.llmwiki/library.json'))
      ?? await readOptional<Metadata>(await safePath(root, 'state/library.json'))
    let registeredId: string | undefined
    for (const library of this.snapshot().libraries.filter(item => item.kind !== 'whalefall')) {
      const registered = await actualPath(library.wikiPath)
      const canonical = await isLayeredRoot(registered) ? registered : await actualPath(path.join(registered, '.llmwiki'))
      if (canonical.toLowerCase() === root.toLowerCase()) registeredId = library.id
    }
    const card = parse(await readFile(await safePath(root, 'library.yaml'), 'utf8'))
    return { identityId: metadata?.libraryId, ...(registeredId ? { libraryId: registeredId } : {}), wikiPath: root,
      sourceRoot: path.dirname(root), canReissue: !registeredId && Boolean(metadata?.libraryId) && card.origin_type === 'local' && /^\.llmwiki(?:-[a-z0-9-]+)?$/i.test(path.basename(root)) }
  }
  async reissueIdentity(input: { path: string; name: string; expectedLibraryId: string; reissueId: true }) {
    if (input.reissueId !== true) throw new Error('重新签发库 ID 需要显式确认。')
    const selected = await actualPath(input.path)
    const root = await isLayeredRoot(selected) ? selected : await actualPath(path.join(selected, '.llmwiki'))
    const registryKey = JSON.stringify(this.snapshot())
    const assertRegistry = () => { if (JSON.stringify(this.snapshot()) !== registryKey) throw new Error('数据库登记已变化，请重新检查目录。') }
    const info = await this.copiedIdentity(root)
    if (!info.canReissue || info.identityId !== input.expectedLibraryId) throw new Error('该目录已登记或库身份已变化，请重新检查目录。')
    if (!input.name.trim()) throw new Error('请填写数据库名称。')
    // 不调用会自动清理旧锁的建库入口；遗留锁一律保留并要求先核对。
    const buildLock = await safePath(info.sourceRoot, '.llmwiki-build.lock')
    const lockPaths = [buildLock, ...await Promise.all(['.llmwiki-build.lock', '.llmwiki/coordination/write.lock', 'coordination/write.lock', 'state/revocations.lock', 'state/revocation-pending.json', 'work/pending.json', 'work/preview.json', '.llmwiki/storage.json'].map(file => safePath(root, file)))]
    for (const file of lockPaths) {
      if (await stat(file).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })) throw new Error('目录仍有写入锁、未完成操作或旧作业存储，请先在原流程核对：' + file)
    }
    // 确保身份和事务目录均未通过链接越出副本。
    for (const file of [...identityFiles, 'state/identity-transaction.json']) await safePath(root, file)
    const lock = await open(buildLock, 'wx')
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, token: randomUUID(), device: (await localDevice()).id })); await lock.sync()
      return await withLibraryLock(root, 'reissue-identity', () => withRevocationLock(root, async () => {
        assertRegistry()
        await recoverIdentity(root)
        const latest = await this.copiedIdentity(root)
        if (!latest.canReissue || latest.identityId !== input.expectedLibraryId) throw new Error('库身份已变化，请重新检查目录。')
        const item = newLibrary(randomUUID()); item.name = input.name.trim(); item.wikiPath = root; item.sourceRoots = [info.sourceRoot]; item.mode = 'managed'
        const embedding = await registeredEmbedding(root)
        if (embedding.embeddingSettings) item.layered = embedding.embeddingSettings
        const metadata = { libraryId: item.id, formatVersion: 1, protocolVersion: 1 }
        const old = await Promise.all(identityFiles.slice(0, 2).map(async file => readOptional<Metadata>(await safePath(root, file))))
        for (const value of old) if (value && (value.libraryId !== info.identityId || value.formatVersion !== 1 || value.protocolVersion !== 1)) throw new Error('库身份记录不一致或协议不兼容，拒绝签发。')
        await replaceIdentity(root, [{ ...old[0], ...metadata }, old[1] ? { ...old[1], ...metadata } : undefined,
          { ...await localDevice(), registered_at: new Date().toISOString(), consumed_takeovers: [] }], assertRegistry)
        return item
      }))
    } finally { await lock.close(); await unlink(buildLock) }
  }
  async migrateStorage(id: string) {
    const library = this.registration(id), root = await this.root(id, true)
    if (library.kind !== 'local' || library.mode !== 'managed') throw new Error('SQLite 迁移只适用于本地独立管理库。')
    this.assertUnchanged(library)
    return migrateJobStorage(root, id)
  }
  snapshot(): Registry { return migrateRegistry(structuredClone(this.registry())) }
  registration(id: string, expectedKey?: string): LibraryRegistration {
    const registry = this.snapshot()
    const issues = validateRegistry(registry)
    if (issues.length) throw new Error(issues.map(item => item.message).join('\n'))
    const library = registry.libraries.find(item => item.id === id)
    if (!library) throw new Error('数据库登记已变化，请重新选择。')
    if (expectedKey !== undefined && expectedKey !== JSON.stringify(library)) throw Object.assign(new Error('数据库登记已变化，请重新加载后核对目录。'), { httpStatus: 409 })
    return structuredClone(library)
  }
  assertUnchanged(expected: LibraryRegistration): void {
    if (JSON.stringify(this.registration(expected.id)) !== JSON.stringify(expected)) throw new Error('数据库配置在操作期间发生变化，请重新核对后执行。')
  }
  async root(id: string, write = false): Promise<string> {
    const library = this.registration(id)
    if (library.kind === 'whalefall') throw new Error('whalefall 资料通过原生工具查询。')
    if (write && !isWritable(library)) throw Object.assign(new Error('只读数据库拒绝写入。'), { httpStatus: 403 })
    const root = await actualPath(library.wikiPath)
    if (write && library.mode === 'shared') {
      await this.sharedCompatibility(library, root)
      await this.metadata(root, id)
    }
    return root
  }
  private async sharedCompatibility(library: LibraryRegistration, root: string, request = false): Promise<void> {
    if (library.kind !== 'obsidian' || !library.vaultPath) throw new Error('共同管理需要填写 Obsidian Vault 根目录。')
    if (await stateDirectory(root) === 'state') throw new Error('该库采用本地 state 布局，不能直接作为 Obsidian 协调协议库启用共管。')
    const manifest = await readSharedManifest(library.vaultPath)
    if (!within(manifest.vaultPath, root) || root === manifest.vaultPath || !manifest.found ||
        !manifest.libraries.some(item => item.wikiPath.toLowerCase() === root.toLowerCase())) {
      throw new Error('该 Wiki 未在 Obsidian 共享清单中登记，请先核对所属 Vault 与数据库。')
    }
    const writer = await readOptional<SharedWriter>(await safePath(root, '.llmwiki/coordination/obsidian.json'))
    if (!writer) {
      if (request) await withLibraryLock(root, 'request-shared', async () => {
        this.assertUnchanged(library)
        await this.metadata(root, library.id)
        await writeState(root, '.llmwiki/coordination/request.json', { protocolVersion: 1, writer: 'dsh-llmwiki' })
      })
      throw new Error((request ? '已申请启用共管。' : '请点击初始化申请启用共管。') + '请启动一次已升级的 Obsidian LLM Wiki 插件，刷新后再次初始化；之后可关闭 Obsidian，由 dsh 直接更新。')
    }
    if (writer.protocolVersion !== 1 || writer.writer !== 'obsidian-llm-wiki-local' || !Array.isArray(writer.capabilities) ||
        !['conditional-write', 'generation', 'recovery'].every(item => writer.capabilities.includes(item))) {
      throw new Error('Obsidian 共管协议或写入能力不兼容，保留只读查询。')
    }
  }
  private async metadata(root: string, id: string): Promise<Metadata | undefined> {
    const metadata = await readOptional<Metadata>(await safePath(root, '.llmwiki/library.json'))
    if (metadata && (metadata.libraryId !== id || metadata.formatVersion !== 1 || metadata.protocolVersion !== 1)) throw new Error('库身份或状态协议不匹配。请核对还原或接入方式，不自动接管。')
    return metadata
  }
  async initialize(id: string): Promise<PolicyView> {
    const library = this.registration(id)
    if (library.mode === 'shared') await this.sharedCompatibility(library, await actualPath(library.wikiPath), true)
    const root = await this.root(id, true)
    // 默认资料目录取 Wiki 父目录（D-64）；新库先建出 Wiki 目录，父目录随之存在，再校验来源边界。
    // 显式填写但不存在的资料目录仍在校验中报错。
    const implicit = library.sourceRoots.length === 1 && path.resolve(library.sourceRoots[0]!) === path.dirname(path.resolve(library.wikiPath))
    if (implicit) await mkdir(root, { recursive: true })
    await validateRoots(root, library.sourceRoots)
    await mkdir(root, { recursive: true })
    if ((library.kind === 'local' || library.kind === 'siyuan') && !await isLayeredRoot(root)) await initializeStateLayout(root)
    await clearHiddenAttribute(root)
    await withLibraryLock(root, 'initialize', async () => {
      this.assertUnchanged(library)
      await this.root(id, true)
      if (await this.metadata(root, id)) return
      await writeState(root, '.llmwiki/library.json', { libraryId: id, formatVersion: 1, protocolVersion: 1 })
      await writeState(root, '.llmwiki/policy.json', defaultPolicy())
    })
    return await this.policy(id)
  }
  async policy(id: string): Promise<PolicyView> {
    const library = this.registration(id)
    if (library.kind === 'whalefall') return { policy: defaultPolicy(), revision: '', initialized: false, writable: false, message: 'whalefall 沿用已有 Wiki 和原生维护流程。' }
    const root = await actualPath(library.wikiPath)
    let sharedMessage: string | undefined
    if (library.mode === 'shared') {
      try { await this.sharedCompatibility(library, root) }
      catch (error) { sharedMessage = error instanceof Error ? error.message : '无法核对 Obsidian 共管协议。' }
    }
    let metadata: Metadata | undefined
    try { metadata = await this.metadata(root, id) }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') { /* 未初始化 */ }
      // 只读接入不使用随库策略；身份不符只提示，不阻断查询和其他库的设置。
      else if (!isWritable(library)) return { policy: defaultPolicy(), revision: '', initialized: false, writable: false,
        message: '只读接入，查询不受影响。库目录记录的身份与本登记不一致，如需改为生成维护，请移除登记后用“登记已有 Wiki”重新登记该目录。' }
      else throw error
    }
    if (!metadata) return { policy: defaultPolicy(), revision: '', initialized: false, writable: false,
      message: sharedMessage ?? (isWritable(library) ? '尚未初始化随库状态。初始化只创建状态区，不生成 Wiki 页面。' : '只读接入，不在原库创建状态区。') }
    const file = await safePath(root, '.llmwiki/policy.json')
    const raw = await readFile(file, 'utf8')
    const policy = policySchema.parse(JSON.parse(raw))
    if (library.kind === 'local' || library.kind === 'siyuan') policy.extractionGranularity = granularityTier(policy).name
    return { policy, revision: signature(raw), initialized: true,
      writable: isWritable(library) && !sharedMessage, message: sharedMessage ?? (library.mode === 'shared' ? '双方共管协议已确认，Obsidian 关闭时也可更新；提交前仍会核对版本。' : '随库策略已读取。') }
  }
  async savePolicy(id: string, value: unknown, revision: string, expectedKey?: string): Promise<PolicyView> {
    const policy = policySchema.parse(value)
    const library = this.registration(id, expectedKey)
    if (library.kind === 'local' || library.kind === 'siyuan') policy.extractionGranularity = granularityTier(policy).name
    const root = await this.root(id, true)
    await withLibraryLock(root, 'policy', async () => {
      if (!await this.metadata(root, id)) throw new Error('请先初始化随库状态。')
      const current = await this.policy(id)
      if (current.revision !== revision) throw Object.assign(new Error('随库策略已被修改，请重新加载后再保存。'), { httpStatus: 409 })
      this.assertUnchanged(library)
      await this.root(id, true)
      if(signature(JSON.stringify(processingPolicy(current.policy)))===signature(JSON.stringify(processingPolicy(policy)))&&
        (['analysisConcurrency','pageGenerationConcurrency','batchDelayMs'] as const).some(key=>current.policy[key]!==policy[key])){
        await writeState(root,`.llmwiki/policy-history/${current.revision}.json`,{revision:current.revision,policy:current.policy})
      }
      await writeState(root, '.llmwiki/policy.json', policy)
    })
    return await this.policy(id)
  }
}
