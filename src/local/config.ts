import { randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, readdir, stat, writeFile, rename, unlink, open } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { z } from 'zod'
import { defaultWikiPath, emptyRegistry, newLibrary, parseRegistry } from '../domain/config.js'
import type { Registry, LayeredSettings } from '../domain/config.js'
import { importConfig } from '../domain/config-io.js'
import { registeredEmbedding } from '../storage/embedding-registration.js'
import { readOptional } from '../storage/files.js'
import { safePath } from '../storage/paths.js'

const endpoint = z.url().refine(value => {
  const url = new URL(value)
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash
}, '地址不能包含凭据、查询参数或片段').transform(value => value.replace(/\/+$/, ''))
const runtimeSchema = z.strictObject({ codexExecutable: z.string().min(1).default('codex'), codexContextWindowTokens: z.number().int().min(8192).default(256000), deepseekBaseUrl: endpoint.default('https://api.deepseek.com/v1') })
export type RuntimeSettings = z.infer<typeof runtimeSchema>
export type LocalConfig = { registry: Registry; runtime: RuntimeSettings }
export type RegistryWriter = (next: Registry, expected: Registry) => Promise<void>

export function parseLocalConfig(value: unknown): LocalConfig {
  const data = z.strictObject({ registry: z.unknown(), runtime: runtimeSchema.prefault({}) }).parse(value)
  // 使用源库可移植配置的完整字段校验，保留非宿主字段及跨字段约束。
  const registry = importConfig(JSON.stringify({ format: 'dsh-llmwiki', version: 1, registry: data.registry }), emptyRegistry(), 'replace')
  return { registry, runtime: data.runtime }
}

export class LocalConfigStore {
  readonly file: string
  private value!: LocalConfig
  constructor(readonly home = path.resolve(process.env.LLMWIKI_LOCAL_HOME || path.join(homedir(), '.llmwiki-local'))) {
    this.file = path.join(home, 'config.json')
  }
  async load(): Promise<LocalConfig> {
    await mkdir(this.home, { recursive: true })
    try { this.value = parseLocalConfig(JSON.parse(await readFile(this.file, 'utf8'))) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      const value = parseLocalConfig({ registry: emptyRegistry() })
      try { await writeFile(this.file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }) }
      catch (cause) { if ((cause as NodeJS.ErrnoException).code !== 'EEXIST') throw cause }
      this.value = parseLocalConfig(JSON.parse(await readFile(this.file, 'utf8')))
    }
    return this.snapshot()
  }
  snapshot(): LocalConfig { return structuredClone(this.value) }
  secrets(): string[] {
    const registry = this.value?.registry
    return [...Object.values(registry?.compatibleProviders ?? {}), registry?.embeddingService]
      .flatMap(config => [config?.apiKey, config?.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined])
      .filter((value): value is string => !!value?.trim()).map(value => value.trim())
  }
  registry = (): Registry => this.snapshot().registry
  writeRegistry: RegistryWriter = async (next, expected) => {
    const lock = path.join(this.home, 'config.lock')
    let handle
    try { handle = await open(lock, 'wx') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('配置正在被占用，请稍后重试。'); throw error }
    const temporary = path.join(this.home, 'config-' + randomUUID() + '.tmp')
    try {
      const current = parseLocalConfig(JSON.parse(await readFile(this.file, 'utf8')))
      if (JSON.stringify(current.registry) !== JSON.stringify(expected)) throw new Error('配置已被其他进程修改，请重新加载。')
      const value = parseLocalConfig({ ...current, registry: next })
      await writeFile(temporary, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
      await rename(temporary, this.file)
      this.value = value
    } finally { await handle.close(); await unlink(lock); await unlink(temporary).catch(() => {}) }
  }
  async add(directory: string, name?: string) {
    const source = await realpath(path.resolve(directory))
    if (!(await stat(source)).isDirectory()) throw new Error('资料路径必须是目录。')
    const previous = this.registry(), library = newLibrary(randomUUID())
    const existing = (await readdir(source, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^\.llmwiki(?:-[a-z0-9-]+)?$/i.test(entry.name))
    // 多库同目录时要求明确目标，避免登记任意一个模型库。
    let wikiPath: string
    if (/^\.llmwiki(?:-[a-z0-9-]+)?$/i.test(path.basename(source))) wikiPath = source
    else if (existing.length > 1) throw new Error('资料目录含多个 Wiki，请直接传入要登记的 .llmwiki-模型 目录。')
    else wikiPath = existing.length ? path.join(source, existing[0]!.name) : defaultWikiPath([source])
    const sourceRoot = path.dirname(wikiPath)
    if (previous.libraries.some(item => path.resolve(item.wikiPath).toLowerCase() === wikiPath.toLowerCase())) throw new Error('该库已登记。')
    let embedding: Partial<LayeredSettings> | undefined
    const exists = await stat(wikiPath).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    if (exists && await stat(path.join(wikiPath, 'library.yaml')).catch(() => undefined)) embedding = (await registeredEmbedding(wikiPath)).embeddingSettings
    const metadata = exists ? await readOptional<{ libraryId: string }>(await safePath(wikiPath, 'state/library.json'))
      ?? await readOptional<{ libraryId: string }>(await safePath(wikiPath, '.llmwiki/library.json')) : undefined
    if (metadata?.libraryId) library.id = metadata.libraryId
    Object.assign(library, { name: name?.trim() || path.basename(sourceRoot), sourceRoots: [sourceRoot], wikiPath, ...(embedding ? { layered: embedding } : {}) })
    const next = structuredClone(previous); next.libraries.push(library); next.activeLibraryId = library.id
    await this.writeRegistry(parseRegistry(next), previous)
    return library
  }
  async remove(id: string) {
    const previous = this.registry(), next = structuredClone(previous)
    if (!next.libraries.some(library => library.id === id)) throw new Error('未找到数据库登记：' + id)
    next.libraries = next.libraries.filter(library => library.id !== id)
    if (next.activeLibraryId === id) next.activeLibraryId = next.libraries[0]?.id ?? ''
    await this.writeRegistry(next, previous)
    return { libraryId: id, removed: true, message: '已删除登记，库文件保留。' }
  }
}
