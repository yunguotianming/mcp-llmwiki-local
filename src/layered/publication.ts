import { expandCitationVersions } from './anchors.js'
import { preparePageVectors } from './vector-build.js'
import type { BuildLayeredOptions } from './schema.js'
import { matchQuotation } from './quotation.js'
import { evidenceBlockIds, migrateAnchors, sectionBlockId } from './anchors.js'
import { putPage, readCurrent, readManifest, readVersion, versionPage, writeVersion } from './objects.js'
import { withInventoryLock, collectGarbage, validateCompleteVersion } from './retention.js'
import { refreshReadingCopy } from './reading-copy.js'
import { checkWriter } from './devices.js'
import { resumeRevocationCleanup } from './revocation-cleanup.js'
import { lstat, mkdir, readFile, readdir, rename, rm, unlink } from 'node:fs/promises'
import path from 'node:path'
import { parse, stringify } from 'yaml'
import { safePath, initializePartitionLayout, stateDirectory } from '../storage/paths.js'
import { clearHiddenAttribute, readOptional } from '../storage/files.js'
import { decodeSourceText } from '../ingest/text.js'
import { appendLog, atomicWrite, hash, libraryRoot, readVerifiedObject, withRevocationLock, writeJson } from './files.js'
import { locatorRange, processingFingerprint, renderSource, resultFingerprint, sameProcessing } from './extraction.js'
import { formatVersion } from './schema.js'
import type { Dependencies, Extraction, LibraryCard, PendingBuild, Point, SnapshotManifest } from './schema.js'
import { checkGeneration, indexDependencies, readRevocations, revocationLog } from './revocations.js'
import { topicHeader, topicInputFingerprint, topicPointHashes } from './topics.js'
import { topicReviewFingerprint } from './topic-review.js'
import { citedTopicPoints } from './topic-metadata.js'
import type { TopicEvidenceSource } from './topic-metadata.js'
import { layeredSettings } from '../domain/config.js'
import { costMarkdown, costReport, saveCosts } from './costs.js'
import { pageLink, topicDepth, topicPath } from './hierarchy.js'
import { validSourceId } from './revocations.js'
import { validateSiyuanSnapshot } from './siyuan.js'
import { prepareTags, mergedTags, personalTag, tagStatus } from './tags.js'
import { publicationCreated, publicationMetadata } from './frontmatter.js'

export { readLayeredPage } from './revocations.js'
export { readCurrent, readManifest } from './objects.js'

function settledValue<T>(result: PromiseSettledResult<T>): T {
  if (result.status === 'rejected') throw result.reason
  return result.value
}
function rootLinks(text: string, sourcePage: string, exists: (page: string) => boolean, diagnostic = false): string {
  return text.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (_link, label: string, target: string) => {
    if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(target)) return `[${label}](${target})`
    const split = target.search(/[?#]/), file = split < 0 ? target : target.slice(0, split), suffix = split < 0 ? '' : target.slice(split)
    const resolved = file ? path.posix.normalize(path.posix.join(path.posix.dirname(sourcePage), file)) : sourcePage
    if (!exists(resolved)) {
      // 缺口可能指向已隔离的页面；保留诊断文字，不为不存在的页面制造导航。
      if (diagnostic) return label
      throw new Error('根索引相对链接目标不存在：' + resolved)
    }
    return `[${label}](${resolved}${suffix})`
  })
}

export async function initializeLibrary(knowledgeRoot: string, card: LibraryCard, takeoverToken?: string, legacyLibraryAction?: 'backup', selectedRoot?: string): Promise<string> {
  const root = selectedRoot ?? (card.origin_type === 'siyuan' ? knowledgeRoot : await libraryRoot(knowledgeRoot))
  let exists = false, compatible = false, backupPath: string | undefined
  try { exists = (await lstat(root)).isDirectory(); if (!exists) throw new Error('Wiki 路径不是目录。') }
  catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
  if (exists) {
    try {
      const saved = parse(await readFile(await safePath(root, 'library.yaml'), 'utf8'))
      if (saved?.format_version !== undefined && saved.format_version !== formatVersion) throw new Error('旧分层库格式不兼容，请重建；原有数据已保留。')
      compatible = saved?.format_version === formatVersion
    }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
    if (compatible) await checkWriter(root, takeoverToken)
    if (!compatible) {
      if (card.origin_type === 'siyuan' && (await readdir(root)).some(name => name !== '.llmwiki-build.lock')) throw new Error('思源库目录已有不兼容内容，请选择空目录。')
      const entries = await readdir(root, { recursive: true, withFileTypes: true })
      // 设置与检查记录尚未生成 Wiki；原文件全部保留，不把旧页面或分析对象纳入此例外。
      const settingsOnly = entries.every(entry => {
        const physical = path.relative(root, path.join(entry.parentPath, entry.name)).replaceAll('\\', '/')
        const relative = physical.replace(/^data\//, '')
        return !entry.isSymbolicLink() && (['README.md', 'data/layout.json'].includes(physical) || physical === 'data' || (entry.isDirectory() ? ['state', 'state/coordination', 'state/policy-history', 'state/reports', 'state/reports/maintenance'].includes(relative)
          : ['state/layout.json', 'state/library.json', 'state/policy.json'].includes(relative) || /^state\/(?:policy-history|reports\/maintenance)\/[a-f0-9]{64}(?:-smart)?\.json$/.test(relative)))
      })
      if (card.origin_type !== 'siyuan' && entries.length && !settingsOnly) {
      if (legacyLibraryAction !== 'backup') throw new Error("检测到旧格式 Wiki 库，需先备份。确认保留旧目录并新建时，请显式传入 legacyLibraryAction: 'backup'；旧目录将整体改名为同级 .llmwiki.bak-YYYYMMDD-HHmmss。")
      const now = new Date(), pad = (value: number) => String(value).padStart(2, '0')
      const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
      let suffix = 0, backup: string
      for (;;) {
        backup = await safePath(knowledgeRoot, `.llmwiki.bak-${timestamp}${suffix ? '-' + suffix : ''}`)
        try { await lstat(backup); suffix++ }
        catch (error) { if (error instanceof Error && 'code' in error && error.code === 'ENOENT') break; throw error }
      }
      await rename(root, backup)
      backupPath = backup
      }
    }
  }
  await mkdir(root, { recursive: true })
  if (!compatible && await stateDirectory(root) !== 'data/state') {
    const oldState = await stateDirectory(root)
    await initializePartitionLayout(root)
    if (oldState === 'state') await rename(path.join(root, 'state'), await safePath(root, 'state'))
  }
  await clearHiddenAttribute(root, message => appendLog(root, `\n- 警告：${message.replace(/[\r\n]/g, ' ')}\n`))
  await Promise.all(['wiki', 'objects', 'versions', 'state', 'work', 'logs'].map(async name => mkdir(await safePath(root, name), { recursive: true })))
  if (backupPath) await writeJson(root, 'state/legacy-backup.json', { backupPath })
  if (!compatible) await atomicWrite(root, 'library.yaml', stringify(card))
  if (!await readOptional(await safePath(root, 'state/revocations.json'))) {
    if (await readCurrent(root)) throw new Error('撤权表缺失，不能为已发布库重置撤权代次。')
    await writeJson(root, 'state/revocations.json', { generation: 0, sources: [] })
  }
  await resumeRevocationCleanup(root)
  return root
}
export async function readExtraction(root: string, relative: string): Promise<Extraction> {
  const extraction = await readVerifiedObject(root, relative, 'extraction:1', bytes => {
    const extraction = JSON.parse(bytes.toString('utf8')) as Extraction
    if (!extraction || extraction.format_version !== 1) throw new Error('提取快照缺失或格式无效。')
    return extraction
  }).catch(error => { if (error.code === 'ENOENT') throw new Error('提取快照缺失或格式无效。'); throw error })
  return structuredClone(extraction)
}
export async function validatePublication(root: string, version: string): Promise<void> {
  const manifest = await readVersion(root, version)
  const revocations = await readRevocations(root)
  if (manifest.sources.some(source => revocations.sources.some(item => item.source_id === source.source_id && source.revocation_generation < item.generation))) throw new Error('发布内容仍含撤权来源。')
  const deps = manifest.deps!, aliases = manifest.aliases!
  for (const [id, target] of Object.entries(aliases)) {
    if (!/^T-\d{4,}(?:-\d{2,})*$/.test(id) || !/^T-\d{4,}(?:-\d{2,})*$/.test(target) || id === target || aliases[target] || !deps.pages[topicPath(target)] || deps.pages[topicPath(id)]) throw new Error('主题别名目标无效。')
  }
  const ids = new Set<string>(), pointIds = new Set<string>(), pointValues = new Map<string, Point>()
  for (let offset = 0; offset < manifest.sources.length; offset += 8) {
    const results = await Promise.allSettled(manifest.sources.slice(offset, offset + 8).map(async entry => {
      if (!validSourceId(entry.source_id) || ids.has(entry.source_id)) throw new Error('来源编号重复或无效。')
      ids.add(entry.source_id)
      const page = `sources/${entry.source_id}.md`
      const [sourceRead, extractionRead, pageRead] = await Promise.allSettled([
        safePath(root, entry.files.source).then(file => readFile(file)),
        readExtraction(root, entry.extract.path),
        versionPage(root, manifest, page),
      ])
      const bytes = settledValue(sourceRead), text = entry.origin_type === 'siyuan' ? await validateSiyuanSnapshot(root, entry) : decodeSourceText(bytes), lines = text.split(/\r?\n/)
      if (entry.origin_type === 'local' && (hash(bytes) !== entry.content_hash || entry.source_version !== entry.content_hash)) throw new Error('正文快照哈希不匹配。')
      for (const asset of entry.files.assets) if (hash(await readFile(await safePath(root, asset.path))) !== asset.hash) throw new Error('附件快照哈希不匹配。')
      const extraction = settledValue(extractionRead)
      if (extraction.source_id !== entry.source_id || extraction.source_hash !== entry.content_hash || !sameProcessing(extraction.processing, entry.extract.processing)) throw new Error('提取结果与来源版本不匹配。')
      if (resultFingerprint(extraction) !== entry.extract.processing_fingerprint) throw new Error('篇级处理指纹不匹配。')
      if (extraction.segments.length !== entry.segments.length) throw new Error('段落数量不匹配。')
      const dependencies = deps.pages[page]
      if (!dependencies || JSON.stringify(dependencies.sources) !== JSON.stringify([entry.source_id])) throw new Error('来源页依赖缺失。')
      for (const [index, segment] of extraction.segments.entries()) {
        if (segment.text_hash !== hash(text.slice(segment.start, segment.end)) || segment.text_hash !== entry.segments[index]?.text_hash || segment.locator !== entry.segments[index]?.locator || segment.processing_fingerprint !== processingFingerprint(extraction.processing, segment.resource_hashes)) throw new Error('段落哈希、定位或处理指纹不匹配。')
        for (const point of segment.points) {
          if (pointIds.has(point.point_id) || !point.point_id.startsWith(`${entry.source_id}:${segment.text_hash}:`) || point.text_hash !== segment.text_hash || point.source_version !== entry.source_version || !point.evidence.length) throw new Error('要点编号或来源版本无效。')
          pointIds.add(point.point_id)
          pointValues.set(point.point_id, point)
          if (!dependencies.points.some(input => input.point_id === point.point_id && input.text_hash === point.text_hash) || !deps.reverse[point.point_id]?.includes(page)) throw new Error('要点依赖或反向依赖缺失。')
          for (const evidence of point.evidence) {
            if (entry.origin_type === 'siyuan') {
              const evidenceSegment = extraction.segments.find(candidate => candidate.locator === evidence.locator)
              if (evidence.source_id !== entry.source_id || evidence.source_version !== entry.source_version || !evidenceSegment
                || !matchQuotation(text.slice(evidenceSegment.start, evidenceSegment.end), evidence.quote)) throw new Error('思源引文版本、块定位或正文无效。')
              continue
            }
            const [first, last] = locatorRange(evidence.locator)
            const evidenceSegment = extraction.segments.find(candidate => {
              const [start, end] = locatorRange(candidate.locator)
              return first >= start && last <= end
            })
            if (evidence.source_id !== entry.source_id || evidence.source_version !== entry.source_version || !evidenceSegment
              || !matchQuotation(lines.slice(first - 1, last).join('\n'), evidence.quote)) throw new Error('引文版本、定位或正文无效。')
          }
        }
      }
      const pointLimit = extraction.point_limit ?? extraction.processing.tier
      if (!Number.isSafeInteger(pointLimit) || pointLimit < 1 || extraction.segments.flatMap(segment => segment.points).length > pointLimit) throw new Error('篇级要点超过提取配额上限。')
      for (const call of extraction.calls) if (!Number.isFinite(call.input_limit) || call.input_limit <= 0 || call.input_bytes > call.input_limit) throw new Error('提取调用超出上下文上限。')
      const content = settledValue(pageRead)
      if (content !== renderSource(entry, extraction)) {
        // 旧版本未记录重试标记，也未渲染提示；只接受这一处格式差异，其他正文仍须逐字匹配。
        const legacy = manifest.source_page_format === undefined && extraction.gaps?.length && extraction.gaps.every(gap => gap.retryable === undefined)
          ? { ...extraction, gaps: extraction.gaps.map(gap => ({ ...gap, retryable: false })) } : undefined
        if (!legacy || content !== renderSource(entry, legacy)) throw new Error('来源页与提取快照不一致。')
      }
    }))
    for (const result of results) settledValue(result)
  }
  const anchors = evidenceBlockIds(pointValues.values())
  const anchoredPoints = new Map([...anchors].flatMap(([id, blocks]) => blocks.map(block => [id.split(':')[0] + '#^' + block, pointValues.get(id)!] as const)))
  const indexed = indexDependencies(structuredClone(deps))
  if (JSON.stringify(indexed.reverse) !== JSON.stringify(deps.reverse) || JSON.stringify(indexed.reverse_sources) !== JSON.stringify(deps.reverse_sources)) throw new Error('依赖反向索引不完整。')
  for (const [page, dependencies] of Object.entries(deps.pages)) {
    if (dependencies.sources.some(id => !ids.has(id))) throw new Error('页面依赖了不存在的来源。')
    for (const point of dependencies.points) {
      const actual = pointValues.get(point.point_id)
      if (!actual || actual.text_hash !== point.text_hash || !dependencies.sources.includes(point.point_id.split(':')[0]!)) throw new Error('依赖要点不存在或段落哈希不匹配。')
    }
    for (const child of dependencies.children ?? []) if (!deps.pages[child.page] || child.version !== version) throw new Error('子页依赖版本无效。')
    for (const call of dependencies.calls ?? []) if (!Number.isFinite(call.input_limit) || call.input_limit <= 0 || call.input_bytes > call.input_limit) throw new Error('主题调用超出上下文上限。')
    if (page.startsWith('terms/')) {
      if (page.includes('#')) continue
      const content = await versionPage(root, manifest, page), header = topicHeader(content), index = page.includes('/index-')
      if (!(index ? ['term-index', 'index'] : ['term']).includes(String(header.page_type)) || header.term_kind !== (index ? 'index' : 'synthesis') || header.source_type !== (index ? '索引' : '综合')
        || header.id !== (index ? path.basename(page, '.md').replace('index-', 'TI-') : path.basename(page, '.md')) || !header.title || !header.updated || !header.source_date || header.source_version !== undefined
        || JSON.stringify(header.sources) !== JSON.stringify(dependencies.sources)) throw new Error(`术语 YAML 字段或来源依赖不一致：${page}。不支持自动恢复旧索引头部，请重新生成该术语索引。`)
      for (const child of dependencies.children ?? []) if (!content.split('\n').some(line => /^## /.test(line) && line.endsWith(' ' + child.page.split('#')[1]))) throw new Error('术语分节缺失。')
      for (const record of dependencies.terms ?? []) for (const contribution of record.contributions) {
        const source = manifest.sources.find(source => source.source_id === contribution.source_id)
        if (!source || source.source_version !== contribution.source_version || !source.segments.some(segment => segment.text_hash === contribution.text_hash)) throw new Error('术语贡献版本无效。')
        if (source.origin_type === 'siyuan') {
          if (!source.segments.some(segment => segment.locator === contribution.locator && segment.text_hash === contribution.text_hash)) throw new Error('思源术语块定位无效。')
          continue
        }
        const [first, last] = locatorRange(contribution.locator)
        if (!source.segments.some(segment => { const [start, end] = locatorRange(segment.locator); return first >= start && last <= end })) throw new Error('术语贡献定位无效。')
      }
      continue
    }
    if (!page.startsWith('topics/')) continue
    const content = await versionPage(root, manifest, page), header = topicHeader(content)
    if (header.page_type !== 'topic' || header.source_type !== '综合' || header.id !== path.basename(page, '.md') || !header.title || !header.source_date || !header.updated
      || !['high', 'medium', 'low', 'unknown', 'mixed'].includes(String(header.credibility)) || header.source_version !== undefined || header.term_kind !== undefined
      || JSON.stringify(header.sources) !== JSON.stringify(dependencies.sources)) throw new Error('主题 YAML 字段或来源元数据无效。')
    if (dependencies.children?.length) {
      if (!content.includes('## 子主题导航') || content.includes('## 来源导航')) throw new Error('父页必须列出子主题导航。')
      if (!dependencies.points.length) continue
      if (!content.includes('## 本页保留要点')) throw new Error('父页直接要点缺少正文。')
    } else {
      for (const section of ['共识', '分歧', '适用条件', '来源导航']) if (!content.includes('## ' + section)) throw new Error('主题页缺少必需段落。')
    }
    const citations = [...expandCitationVersions(content).matchAll(/\[((?:S-\d{4,}|\d{14}-[a-z0-9]{7}))@([^\]#]+)#(L\d+-L\d+|block:\d{14}-[a-z0-9]{7})\]\((?:\.\.\/)+sources\/(S-\d{4,}|\d{14}-[a-z0-9]{7})\.md#([^\s)]+)\)/g)]
    if (header.archived === true && !dependencies.points.length && !citations.length) continue
    if (!citations.length) throw new Error('主题页缺少有效要点引用。')
    for (const citation of citations) {
      const point = anchoredPoints.get(citation[4] + '#' + citation[5])
      if (!point || !dependencies.points.some(item => item.point_id === point.point_id) || citation[1] !== citation[4]
        || !point.evidence.some(evidence => evidence.source_id === citation[1] && evidence.source_version === citation[2] && evidence.locator === citation[3])) throw new Error('主题要点引用无法解析到对应快照版本。')
    }
  }
  const index = await versionPage(root, manifest, 'index.md')
  for (const entry of manifest.sources) if (!index.includes(`sources/${entry.source_id}.md`)) throw new Error('导航缺少来源。')
  for (const page of Object.keys(deps.pages).filter(page => page.startsWith('topics/'))) if (!index.includes(page)) throw new Error('导航缺少主题。')
  await checkGeneration(root, manifest.revocation_generation)
}
export async function finishPublication(root: string, pending: PendingBuild): Promise<void> {
  await checkGeneration(root, pending.manifest.revocation_generation)
  const current = await readCurrent(root)
  if (!pending.version || current?.version !== pending.version) throw new Error('不能清理尚未发布的待更新清单。')
  const manifest = await readVersion(root, pending.version)
  await withRevocationLock(root, async () => {
    await checkGeneration(root, pending.manifest.revocation_generation)
    await refreshReadingCopy(root, manifest)
    if (pending.topics) {
      pending.topics.state.version = pending.version
    }
    const log = (manifest.log ?? '') + revocationLog(await readRevocations(root), manifest.revocation_generation)
    const results = await Promise.allSettled([
      atomicWrite(root, 'library.yaml', stringify(manifest.card)), atomicWrite(root, 'logs/build.md', log),
      ...(pending.topics ? [writeJson(root, 'state/topics.json', pending.topics.state)] : []),
      saveCosts(root, pending, pending.version!),
    ])
    for (const result of results) settledValue(result)
    await rm(await safePath(root, 'logs/failures'), { recursive: true, force: true })
    await writeJson(root, 'state/gc-pending.json', { version: pending.version })
    await unlink(await safePath(root, 'work/pending.json'))
  })
  await collectGarbage(root)
}
export async function publishLibrary(root: string, pending: PendingBuild, signal?: AbortSignal, activate = true, options?: BuildLayeredOptions): Promise<string> {
  await checkGeneration(root, pending.manifest.revocation_generation)
  if (pending.topics) {
    const topics = pending.topics
    // 兼容旧 pending：收缩合并已转移要点，但曾同时保存源主题的归档实体和重定向。
    const redirects = new Map(topics.state.topics.filter(topic => topic.archived && topics.aliases?.[topic.id])
      .map(topic => [topic.path, topicPath(topics.aliases![topic.id]!)]))
    if (redirects.size) {
      const changed = new Set<string>()
      for (const topic of topics.state.topics) if (redirects.has(topic.path) && topic.parent_id) changed.add(topic.parent_id)
      topics.state.topics = topics.state.topics.filter(topic => !redirects.has(topic.path))
      for (const page of redirects.keys()) delete topics.pages[page]
      const redirectLinks = (content: string, page: string) => content.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (link, label: string, target: string) => {
        if (/^(?:[a-z][a-z\d+.-]*:|\/)/i.test(target)) return link
        const split = target.search(/[?#]/), file = split < 0 ? target : target.slice(0, split), suffix = split < 0 ? '' : target.slice(split)
        const destination = redirects.get(file ? path.posix.normalize(path.posix.join(path.posix.dirname(page), file)) : page)
        return destination ? `[${label}](${pageLink(page, destination)}${suffix})` : link
      })
      for (const [page, value] of [...Object.entries(topics.pages), ...Object.entries(pending.terms?.pages ?? {})]) {
        const content = redirectLinks(value.content, page)
        if (content !== value.content) {
          const topic = topics.state.topics.find(topic => topic.path === page)
          if (topic) changed.add(topic.id)
        }
        value.content = content
        // 合并的是兄弟叶页，父页保留目标依赖，去掉源页依赖。
        if (value.dependencies.children) value.dependencies.children = value.dependencies.children.filter(child => !redirects.has(child.page))
      }
      for (const topic of topics.state.topics) {
        const summary = redirectLinks(topic.summary, topic.path)
        if (summary !== topic.summary && topic.parent_id) changed.add(topic.parent_id)
        topic.summary = summary
      }
      // 兼容清理只改本地链接；检查点中的三处指纹必须与续跑判定使用同一公式。
      const points = new Map<string, Point>(), contexts = new Map<string, TopicEvidenceSource>()
      const affected = topics.state.topics.filter(topic => changed.has(topic.id) && topics.pages[topic.path])
      const reviewSources = new Set(affected.filter(topic => topics.pages[topic.path]!.dependencies.review)
        .flatMap(topic => topic.point_ids.map(id => id.split(':')[0]!)))
      for (const source of pending.manifest.sources) {
        const extraction = await readExtraction(root, source.extract.path)
        for (const point of extraction.segments.flatMap(segment => segment.points)) points.set(point.point_id, point)
        if (!reviewSources.has(source.source_id)) continue
        const input = source.siyuan?.input ?? source.files.source, bytes = await readFile(await safePath(root, input))
        const expected = source.siyuan ? source.siyuan.objects.find(object => object.path === input)?.hash : source.content_hash
        if (!expected || hash(bytes) !== expected) throw new Error('主题核对来源快照校验失败：' + source.source_id)
        contexts.set(source.source_id, { title: source.metadata.title, source_version: source.source_version,
          text: decodeSourceText(bytes), segments: source.segments })
      }
      const pointHashes = topics.point_hashes ?? topicPointHashes(points, pending.manifest.sources)
      const settings = layeredSettings(options?.topics || {}, options?.tier)
      for (const topic of affected) {
        const page = topics.pages[topic.path]!, header = topicHeader(page.content)
        page.input_fingerprint = topicInputFingerprint(topic, topics.state, pointHashes)
        page.content = page.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,
          '---\n' + stringify({ ...header, input_fingerprint: page.input_fingerprint }).trimEnd() + '\n---\n')
        if (page.dependencies.review) {
          let members = topic.point_ids.map(id => points.get(id)!).filter(Boolean)
          if ((page.dependencies.review.removed.length || page.dependencies.review.metadata_members) && !page.content.includes('## 子主题导航')) {
            const cited = citedTopicPoints(page.content, members)
            if (cited.length) members = cited
          }
          page.dependencies.review.fingerprint = topicReviewFingerprint(page.content, members, settings.contradictionReview, contexts)
        }
      }
    }
  }
  // 失败的发布尝试不确定首次发布时间；只继承已发布版本固化的时间。
  pending.manifest.page_created = pending.base_version ? (await readVersion(root, pending.base_version)).page_created ?? {} : {}
  const publishRoot = await safePath(root, 'versions')
  await mkdir(publishRoot, { recursive: true })
  const versions = (await readdir(publishRoot)).filter(name => /^v\d{6,}\.json$/.test(name)).map(name => Number(name.slice(1, -5)))
  const version = 'v' + String(Math.max(0, Number(pending.version?.slice(1) ?? 0), ...versions) + 1).padStart(6, '0')
  pending.version = version; pending.manifest.version = version
  pending.card.source_count = pending.manifest.sources.length; pending.card.updated_at = new Date().toISOString()
  await writeJson(root, 'work/pending.json', pending)
  const files: [string, string][] = [], allPoints: Point[] = []
  const publicationTags = pending.terms ? prepareTags(pending.terms.records) : undefined
  const gaps: string[] = (pending.manifest.gaps ?? []).map(gap => `- 导出缺口 ${gap.source_id}：${hash(JSON.stringify(gap))}`)
  const topicGaps = (pending.manifest.topic_gaps ?? []).map(gap => `- 主题缺口 ${gap.topic_id}：${gap.message.replace(/[\r\n]/g, ' ')}；${gap.point_ids.length} 条成员要点保留在来源页。`)
  gaps.push(...topicGaps)
  const deps: Dependencies = { pages: {}, reverse: {} }
  for (let offset = 0; offset < pending.manifest.sources.length; offset += 8) {
    const entries = pending.manifest.sources.slice(offset, offset + 8)
    signal?.throwIfAborted()
    const extractions = await Promise.allSettled(entries.map(entry => readExtraction(root, entry.extract.path)))
    for (const [index, entry] of entries.entries()) {
      const extraction = settledValue(extractions[index]!), page = `sources/${entry.source_id}.md`
      const pendingPoints = pending.manifest.vector_state?.pending_points.filter(id => id.startsWith(entry.source_id + ':')) ?? []
      if (pendingPoints.length) entry.pending_topic_points = pendingPoints
      else delete entry.pending_topic_points
      allPoints.push(...extraction.segments.flatMap(segment => segment.points))
      signal?.throwIfAborted()
      const policy = pending.manifest.tag_policy
      const candidates = extraction.tag_candidates ?? extraction.tags ?? [], tags = publicationTags ?? prepareTags(extraction.segments.flatMap(segment => segment.terms))
      entry.tags = mergedTags(tags.canonical(candidates, policy?.vocabulary, policy?.only, policy?.limit), pending.manifest.tag_merges)
      const minimum = Math.min(3, policy?.limit ?? 8, policy?.only && policy.vocabulary.length ? tags.canonical(policy.vocabulary).length : 3)
      entry.tag_status = tagStatus(entry.tags, (extraction.tag_status?.personal_information_removed ?? 0) + candidates.filter(personalTag).length, minimum)
      // 来源字段已由结构化状态确定，直接渲染一次，省去整页 YAML 的解析和再次序列化。
      publicationCreated(pending, page, entry)
      files.push([page, renderSource(entry, extraction)])
      for (const gap of extraction.gaps ?? []) gaps.push(`- 提取缺口 ${entry.source_id}（${gap.kind === 'unverified_claim' ? '未核实要点' : gap.kind === 'point' ? '要点' : gap.kind === 'group' ? '提取组' : gap.kind === 'summary' ? '摘要' : '术语'}）：${hash(JSON.stringify(gap))}；条数：${gap.reasons.length}`)
      const points = extraction.segments.flatMap(segment => segment.points).map(point => ({ point_id: point.point_id, text_hash: point.text_hash }))
      deps.pages[page] = { sources: [entry.source_id], points }
      for (const point of points) (deps.reverse[point.point_id] ??= []).push(page)
    }
  }
  for (const [page, topic] of Object.entries(pending.topics?.pages ?? {}).sort(([a], [b]) => a.localeCompare(b))) { signal?.throwIfAborted(); files.push([page, topic.content]); deps.pages[page] = topic.dependencies }
  for (const [page, term] of Object.entries(pending.terms?.pages ?? {}).sort(([a], [b]) => a.localeCompare(b))) { files.push([page, term.content]); deps.pages[page] = term.dependencies }
  Object.assign(deps.pages, pending.terms?.section_dependencies ?? {})
  // 旧待发布状态也只重渲染，提取对象与模型缓存不变。
  const anchors = evidenceBlockIds(allPoints)
  for (const file of files) if (!file[0].startsWith('sources/')) file[1] = migrateAnchors(file[1], anchors)
  const blockRef = (page: string) => page.includes('#') && !page.includes('#^') ? page.split('#')[0] + '#^' + sectionBlockId(page.split('#')[1]!) : page
  deps.pages = Object.fromEntries(Object.entries(deps.pages).map(([page, dependency]) => {
    for (const child of dependency.children ?? []) child.page = blockRef(child.page)
    return [blockRef(page), dependency]
  }))
  for (const dependency of Object.values(deps.pages)) for (const child of dependency.children ?? []) child.version = version
  // 父页来源由本页保留要点与最终子页重新求并集，不能把纠正前的继承来源当成直接依赖。
  for (const [page, dependency] of Object.entries(deps.pages)) if (page.startsWith('topics/') && dependency.children?.length) {
    dependency.sources = [...new Set(dependency.points.map(point => point.point_id.split(':')[0]!))].sort()
  }
  indexDependencies(deps)
  for (const topic of pending.topics?.state.topics ?? []) topic.sources = [...deps.pages[topic.path]!.sources]
  const card = pending.card, navigation = [`# ${card.name}`, card.domain, `来源数：${card.source_count}；更新时间：${card.updated_at}`, '## 来源',
    ...pending.manifest.sources.map(entry => `- [${entry.source_id} ${entry.metadata.title.replace(/[\r\n]+/g, ' ').replaceAll('[', '\\[').replaceAll(']', '\\]')}](sources/${entry.source_id}.md) — ${entry.metadata.source_type.replace(/[\r\n]+/g, ' ')}；${entry.metadata.source_date}；${entry.current_path.replace(/[\r\n]/g, ' ')}`)]
  if (!pending.manifest.sources.length) navigation.push('当前库没有来源')
  if (pending.manifest.gaps?.length) navigation.push('## 导出缺口', ...pending.manifest.gaps.map(gap => `- ${gap.source_id}（${gap.status}）：${gap.message}`))
  if (topicGaps.length) navigation.push('## 主题缺口', ...topicGaps.map((text, index) => rootLinks(text,
    topicPath(pending.manifest.topic_gaps![index]!.topic_id), page => files.some(([file]) => file === page), true)))
  if (pending.manifest.tag_merge_gap) navigation.push('## 标签归并缺口', pending.manifest.tag_merge_gap.message.replace(/[\r\n]/g, ' '))
  if (pending.manifest.term_gaps?.length) navigation.push('## 术语缺口', ...pending.manifest.term_gaps.map(gap => `- ${gap.term_id}${gap.section_id ? '/' + gap.section_id : ''}：${gap.message.replace(/[\r\n]/g, ' ')}`))
  const topicNavigation = ['## 主题', ...(pending.topics?.state.topics ?? []).slice().sort((a, b) => a.id.localeCompare(b.id)).map(topic =>
    `${'  '.repeat(topicDepth(topic))}- [${topic.id} ${topic.title.replace(/[\r\n]+/g, ' ').replaceAll('[', '\\[').replaceAll(']', '\\]')}](${topic.path}) — ${rootLinks(topic.summary, topic.path, page => files.some(([file]) => file === page)).replace(/[\r\n]+/g, ' ')}；来源数：${topic.sources.length}`)]
  topicNavigation.push('## 术语', ...Object.keys(pending.terms?.pages ?? {}).filter(page => page.includes('/index-')).sort().map(page => `- [${topicHeader(pending.terms!.pages[page]!.content).title}](${page})`))
  navigation.splice(3, 0, ...topicNavigation)
  files.push(['index.md', navigation.join('\n\n') + '\n'])
  await preparePageVectors(root, pending, files, options)
  const previousLog = await readFile(await safePath(root, 'logs/build.md'), 'utf8').catch(error => {
    if (error.code === 'ENOENT' && !pending.base_version) return '# 建库历史\n'
    throw error
  })
  const log = previousLog
    + `\n## [${card.updated_at}] build | ${version}\n- 新增：${pending.added.join('、') || '无'}；来源：${card.source_count}\n- 重建或修订主题：${pending.topics?.rewritten.join('、') || '无'}\n- 重写术语节：${pending.terms?.rewritten.join('、') || '无'}\n- 成本：提取 ${pending.costs?.stages['提取']?.actual_calls ?? pending.model_calls} 次；提取后核对 ${pending.costs?.stages['提取后核对']?.actual_calls ?? 0} 次；主题 ${pending.costs?.stages['主题']?.actual_calls ?? pending.topics?.model_calls ?? 0} 次；主题后核对 ${pending.costs?.stages['主题后核对']?.actual_calls ?? 0} 次；术语 ${pending.terms?.model_calls ?? 0} 次\n`
    + Object.entries(pending.changes ?? {}).map(([kind, ids]) => `- ${kind}：${ids.join('、')}\n`).join('') + gaps.join('\n') + '\n' + costMarkdown(pending.costs ?? costReport(pending.started_at))
  pending.manifest.pages = {}
  // 未发布目录内的独立文件有界并行；失败也等本批写入结束，才释放建库锁。
  for (let offset = 0; offset < files.length; offset += 8) {
    const results = await withRevocationLock(root, () => Promise.allSettled(files.slice(offset, offset + 8).map(async ([relative, value]) => {
      signal?.throwIfAborted()
      pending.manifest.pages![relative] = await putPage(root, relative.startsWith('sources/') ? value : publicationMetadata(pending, relative, value, deps.pages[relative]?.sources, publicationTags))
    })))
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }
  pending.manifest.anchor_format = 'obsidian-block-v1'
  pending.manifest.source_page_format = 'retryable-gaps-v1'
  pending.manifest.pages = Object.fromEntries(Object.entries(pending.manifest.pages).sort(([a], [b]) => a.localeCompare(b)))
  pending.manifest.deps = deps; pending.manifest.aliases = pending.topics?.aliases ?? {}
  if (pending.topics) { pending.topics.state.version = version; pending.manifest.topics = pending.topics.state }
  pending.manifest.card = card; pending.manifest.log = log
  pending.manifest.cost_report = costMarkdown(pending.costs ?? costReport(pending.started_at))
  await writeJson(root, 'work/pending.json', pending)
  delete pending.manifest.rebuild_pages
  await writeVersion(root, pending.manifest)
  await validatePublication(root, version)
  await validateCompleteVersion(root, pending.manifest, !options?.vectorDeferred)
  if (!activate) {
    await writeJson(root, 'work/preview.json', { version, base_version: pending.base_version })
    return version
  }
  return activatePublication(root, pending, signal)
}
export async function activatePublication(root: string, pending: PendingBuild, signal?: AbortSignal): Promise<string> {
  const version = pending.version!
  const current = await readCurrent(root)
  if ((current?.version ?? null) !== pending.base_version) throw new Error('发布基线已变化，保留待更新清单。')
  signal?.throwIfAborted()
  await withInventoryLock(root, () => withRevocationLock(root, async () => {
    await checkWriter(root)
    if ((await readCurrent(root))?.version !== current?.version) throw new Error('发布基线已变化。')
    await checkGeneration(root, pending.manifest.revocation_generation)
    signal?.throwIfAborted()
    await writeJson(root, 'state/current.json', { version, revocation_generation: pending.manifest.revocation_generation, history: current ? [current.version] : [] })
  }))
  await finishPublication(root, pending)
  await unlink(await safePath(root, 'work/preview.json')).catch(error => { if (error.code !== 'ENOENT') throw error })
  return version
}
