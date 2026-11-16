import path from 'node:path'
import { cp, lstat, mkdir, readdir, rm, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { stringify } from 'yaml'
import { embeddingEndpoint, layeredSettings, type LayeredSettings } from '../domain/config.js'
import { embeddingStandardName } from '../domain/embedding-name.js'
import { actualPath, directory, safePath, within } from '../storage/paths.js'
import { replaceIdentity } from '../storage/identity.js'
import { createEmbeddingClient } from './cloud-embedding.js'
import { localDevice } from './devices.js'
import { embedInputs } from './embedding.js'
import { atomicWrite, hash, withBuildLock, withRevocationLock, writeJson } from './files.js'
import { readCurrent, readManifest, writeVersion } from './objects.js'
import { readExtraction } from './publication.js'
import { readRevocations } from './revocations.js'
import { validateCompleteVersion } from './retention.js'
import { identityKey, probeIdentity, selection } from './vector-identity.js'
import { clusteringVersion } from './clustering.js'
import { buildConfiguration } from './build-configuration.js'
import type { EmbeddingClient } from './schema.js'
import { artifactId, isProductionFormat, readProvenance, writeProvenance } from './models.js'
import { readVersionCosts, writeVersionCosts } from './costs.js'
import { storageJson } from './vectors.js'

const model = z.string().trim().min(1)
export const copyEmbeddingTargetSchema = z.discriminatedUnion('embeddingMode', [
  z.strictObject({ embeddingMode: z.literal('ollama'), localEmbeddingModel: model, localEmbeddingUrl: z.url().optional() }),
  z.strictObject({ embeddingMode: z.literal('cloud'), cloudEmbeddingModel: model, cloudEmbeddingUrl: z.url(), cloudEmbeddingKeyEnv: model }),
])
export type CopyEmbeddingTarget = z.infer<typeof copyEmbeddingTargetSchema>
export const copyEmbeddingRequestSchema = z.strictObject({ libraryId: model, target: copyEmbeddingTargetSchema, confirm: z.literal(true) })

// 复制阶段持有同资料根建库锁及源库库存锁；嵌入阶段只操作独立副本。
export async function copyWithEmbedding(source: string, target: CopyEmbeddingTarget, confirm: boolean,
  options: { embeddingClient?: EmbeddingClient; signal?: AbortSignal | undefined; settings?: Partial<LayeredSettings> | undefined;
    register?: (result: { path: string; libraryId: string; name: string; settings: LayeredSettings }) => Promise<void> } = {}) {
  if (confirm !== true) throw new Error('必须显式确认“复制并切换向量模型”。')
  const selected = copyEmbeddingTargetSchema.parse(target), sourceRoot = await directory(source), parent = path.dirname(sourceRoot)
  const selectedSettings = { ...options.settings, ...Object.fromEntries(Object.entries(selected).filter(([, value]) => value !== undefined)), topicSimilarityThreshold: 0.65, topicAttachThreshold: 0.60 }
  let settings = layeredSettings(selectedSettings)
  delete settings.embeddingChangeToken; delete settings.writerTakeoverToken
  const standard = embeddingStandardName({ model: embeddingEndpoint(settings).model }), targetRoot = await actualPath(path.join(parent, '.llmwiki-' + standard))
  if (path.dirname(targetRoot) !== parent || targetRoot === sourceRoot) throw new Error('目标库目录已存在或越出资料根，拒绝覆盖。')
  return withBuildLock(parent, async () => {
    options.signal?.throwIfAborted()
    // 独占占位，失败清理只触及本次成功创建的目录。
    try { await mkdir(targetRoot) } catch (error) { if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new Error('目标库目录已存在，拒绝覆盖。'); throw error }
    try {
      const manifest = await withRevocationLock(sourceRoot, async () => {
        const current = await readCurrent(sourceRoot), value = await readManifest(sourceRoot, current)
        if (!current || value.card?.origin_type !== 'local') throw new Error('请选择已经发布的本地资料库。')
        if (value.revocation_generation !== (await readRevocations(sourceRoot)).generation) throw new Error('撤权尚未完成，请稍后复制。')
        for (const entry of await readdir(sourceRoot)) await cp(path.join(sourceRoot, entry), path.join(targetRoot, entry), { recursive: true, force: false, errorOnExist: true, filter: async file => {
          options.signal?.throwIfAborted()
          const relative = path.relative(sourceRoot, file).replaceAll('\\', '/')
          if (/^(?:data\/)?(?:work|logs\/model-accepts|logs\/model-runs)(?:\/|$)/.test(relative) || /(?:^|\/)(?:[^/]*\.lock|inventory-lock\.sqlite(?:-.*)?)$/.test(relative)) return false
          if ((await lstat(file)).isSymbolicLink()) throw new Error('库中含链接，无法保证独立复制，请先核对：' + relative)
          return true
        } })
        return value
      })
      const originalChecksum = hash(storageJson(manifest))
      const production = await isProductionFormat(targetRoot) ? await readProvenance(targetRoot, manifest.version!, originalChecksum) : undefined
      const costs = production ? await readVersionCosts(targetRoot, manifest.version!, originalChecksum) : undefined
      const libraryId = randomUUID(), name = `${manifest.card!.name}（${standard}）`, metadata = { libraryId, formatVersion: 1, protocolVersion: 1 }
      settings = layeredSettings(selectedSettings, manifest.sources[0]?.extract.processing.tier)
      delete settings.embeddingChangeToken; delete settings.writerTakeoverToken
      manifest.card!.name = name
      manifest.build_configuration = buildConfiguration(layeredSettings(settings, manifest.sources[0]?.extract.processing.tier))
      await replaceIdentity(targetRoot, [metadata, metadata, { ...await localDevice(), registered_at: new Date().toISOString(), consumed_takeovers: [] }], () => options.signal?.throwIfAborted())
      const texts = new Map<string, string>(), points = new Map<string, string>(), oldIds = new Map<string, string>()
      const add = (text: string, id?: string) => { const input = hash(text); texts.set(input, text); if (id) oldIds.set(id, input); return input }
      for (const source of manifest.sources) for (const segment of (await readExtraction(targetRoot, source.extract.path)).segments) {
        for (const point of segment.points) points.set(point.point_id, add(point.text, manifest.topics?.vectors[point.point_id]?.vector_id))
        for (const term of segment.terms) add([term.name, ...term.aliases].join('；'))
      }
      for (const page of Object.values(manifest.deps?.pages ?? {})) for (const term of page.terms ?? []) for (const item of term.contributions) add([item.name, ...item.aliases].join('；'), item.vector_id)
      for (const page of Object.values(manifest.vector_state?.page_vectors ?? {})) for (const ref of page.vectors) {
        if (!texts.has(ref.input_hash)) throw new Error('页面向量缺少可验证的原文，停止复制。')
        oldIds.set(ref.vector_id, ref.input_hash)
      }
      const client = options.embeddingClient ?? createEmbeddingClient(settings), identity = await probeIdentity(client, settings, options.signal)
      // 复用正式缓存边界，后续无变化建库及增量均可命中目标模型缓存。
      const references = await embedInputs(targetRoot, [...texts.values()], settings, client, options.signal, 1, identity)
      const embedded = new Map([...texts.keys()].map((key, index) => [key, references[index]!]))
      if (manifest.topics) {
        for (const [id, ref] of Object.entries(manifest.topics.vectors)) {
          const input = points.get(id), replacement = input && embedded.get(input)
          if (!replacement) throw new Error('要点向量缺少原文，停止复制。')
          Object.assign(ref, replacement)
        }
        manifest.topics.embedding = { ...embeddingEndpoint(settings), precision: identity.precision, identity }
        manifest.topics.clustering_fingerprint = hash(JSON.stringify([clusteringVersion, settings.topicSimilarityThreshold, settings.topicAttachThreshold,
          settings.topicMergeMinSources, settings.topicMaxPoints, settings.topicClusterBlockSize, settings.topicNeighborCount, identity]))
      }
      for (const page of Object.values(manifest.vector_state?.page_vectors ?? {})) for (const ref of page.vectors) Object.assign(ref, embedded.get(oldIds.get(ref.vector_id)!)!)
      for (const page of Object.values(manifest.deps?.pages ?? {})) for (const term of page.terms ?? []) for (const item of term.contributions) {
        item.vector_id = embedded.get(hash([item.name, ...item.aliases].join('；')))!.vector_id; item.embedding = identityKey(identity)
      }
      manifest.vector_state = { ...manifest.vector_state, mode: selected.embeddingMode, identity, generation: (manifest.vector_state?.generation ?? 0) + 1,
        selection: selection(settings), coverage: { embedded: [...points.keys()].sort(), missing: [] }, pending_points: [] }
      delete manifest.vector_state.message
      const previous = manifest.version!, versions = (await readdir(await safePath(targetRoot, 'versions'))).filter(file => /^v\d{6,}\.json$/.test(file))
      manifest.version = 'v' + String(Math.max(0, ...versions.map(file => Number(file.slice(1, -5)))) + 1).padStart(6, '0')
      if (manifest.topics) manifest.topics.version = manifest.version
      for (const dependency of Object.values(manifest.deps?.pages ?? {})) for (const child of dependency.children ?? []) child.version = manifest.version
      await writeVersion(targetRoot, manifest)
      if (production) {
        for (const artifact of Object.values(production.artifacts)) artifact.inheritedFrom = { version: previous, artifactId: artifactId(artifact), productionIds: artifact.productionIds }
        production.version = manifest.version; production.manifestChecksum = hash(storageJson(manifest))
        await writeProvenance(targetRoot, production)
        await writeVersionCosts(targetRoot, manifest.version, production.manifestChecksum, [], costs!)
      }
      await validateCompleteVersion(targetRoot, manifest, true)
      if (manifest.topics) await writeJson(targetRoot, 'state/topics.json', manifest.topics)
      await writeJson(targetRoot, 'state/current.json', { version: manifest.version, revocation_generation: manifest.revocation_generation, history: [previous] })
      // 阅读页面保留原字节，库卡片和登记使用副本名称。
      await atomicWrite(targetRoot, 'library.yaml', stringify(manifest.card))
      await unlink(await safePath(targetRoot, 'state/query-vectors.json')).catch(error => { if (error.code !== 'ENOENT') throw error })
      await mkdir(await safePath(targetRoot, 'work'), { recursive: true })
      options.signal?.throwIfAborted()
      await options.register?.({ path: targetRoot, libraryId, name, settings })
      return { path: targetRoot, libraryId, name, identity, version: manifest.version, vectors: embedded.size, points: points.size, generation_calls: 0, generation_tokens: 0 }
    } catch (error) {
      if (!within(parent, targetRoot) || path.dirname(targetRoot) !== parent || targetRoot === sourceRoot) throw new Error('副本清理目录越界。', { cause: error })
      await rm(targetRoot, { recursive: true, force: true }); throw error
    }
  })
}
