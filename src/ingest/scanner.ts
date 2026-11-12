import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { readFile, readdir, stat, realpath } from 'node:fs/promises'
import type { LibraryStore } from '../storage/libraries.js'
import { safePath, validateRoots, within } from '../storage/paths.js'
import { readOptional, saveObject, signature, writeState } from '../storage/files.js'
import { withLibraryLock } from '../storage/lock.js'
import { readGenerateJobSummaries } from '../storage/jobs.js'
import { parseMarkdown, partitionText, separateImages } from './markdown.js'
import { matchSourceIdentities } from './source-identity.js'
import { layeredSettings } from '../domain/config.js'
import type { ImageOccurrence, SourceChunk, TextMapping } from './markdown.js'
import { decodeSourceText } from './text.js'
export interface SourceRecord { id: string; root: string; relativePath: string; absolutePath: string; hash: string;
  bytes: number; state: 'active' | 'missing' | 'withdrawn'; previousPaths: string[]; aliasPaths?: string[]; segmentHashes?: string[]; resourceHash?: string; committedHash?: string; committedPath?: string }
export interface SourceVersion { sourceId: string; hash: string; parserVersion: 1|2; chunkBudget: number; textObject: string; snapshotObject: string; images: Omit<ImageOccurrence, 'url'>[];
  mapping: TextMapping[]; chunks: Omit<SourceChunk, 'text'>[] }
export interface ScanFile { sourceId: string; path: string; previousPath?: string; change: 'new' | 'changed' | 'unchanged' | 'moved' | 'missing' | 'withdrawn'; bytes: number; chunks: number; images: number; pendingImages: number; needsGeneration?: boolean; generation?: 'new' | 'update' | 'current' | 'inactive' }
export interface ScanJob { id: string; libraryId: string; stage: 'scanned'; createdAt: string; files: ScanFile[];
  errors: { path: string; message: string }[]; excluded: { path: string; reason: string }[]; textChars: number; bytes: number }

export async function stableRead(file: string): Promise<Buffer> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await stat(file), bytes = await readFile(file), after = await stat(file)
    if (before.size === after.size && before.mtimeMs === after.mtimeMs && signature(bytes) === signature(await readFile(file))) return bytes
  }
  throw new Error('读取时文件持续变化，请稍后重试。')
}
export async function scanSourceFiles(sourceRoots: string[], outputRoot: string, signal?: AbortSignal) {
  const inputs: { sourceRoot: string; actual: string; hash?: string }[] = []
  const errors: ScanJob['errors'] = [], excluded: ScanJob['excluded'] = []
  const failedDirectories: string[] = [], failedFiles = new Set<string>(), visited = new Set<string>()
  const fileKey = (file: string) => process.platform === 'win32' ? path.resolve(file).toLowerCase() : path.resolve(file)
  const walk = async (sourceRoot: string, current: string): Promise<void> => {
    signal?.throwIfAborted()
    let entries
    try { entries = await readdir(current, { withFileTypes: true }) }
    catch (error) { failedDirectories.push(current); errors.push({ path: current, message: error instanceof Error ? error.message : '目录读取失败。' }); return }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      signal?.throwIfAborted()
      const file = path.join(current, entry.name)
      if (within(outputRoot, file)) { excluded.push({ path: file, reason: 'Wiki 输出目录不参与资料扫描。' }); continue }
      if (entry.isSymbolicLink() || /^\.llmwiki(?:-|\.bak-|$)/i.test(entry.name) || entry.name === '.git') { excluded.push({ path: file, reason: '链接目录或插件状态不参与资料扫描。' }); continue }
      if (entry.isDirectory()) { await walk(sourceRoot, file); continue }
      if (!entry.isFile() || !/\.(md|markdown|txt|text)$/i.test(entry.name)) continue
      try {
        const actual = await realpath(file)
        if (!within(sourceRoot, actual) || within(outputRoot, actual)) { excluded.push({ path: file, reason: '实际路径越出资料范围或属于 Wiki 输出。' }); continue }
        if (visited.has(fileKey(actual))) continue
        visited.add(fileKey(actual)); inputs.push({ sourceRoot, actual })
      } catch (error) {
        signal?.throwIfAborted(); failedFiles.add(fileKey(file))
        errors.push({ path: file, message: error instanceof Error ? error.message : '资料读取失败。' })
      }
    }
  }
  for (const sourceRoot of sourceRoots) await walk(sourceRoot, sourceRoot)
  return { inputs, errors, excluded, failedDirectories, failedFiles, visited }
}
async function imageAsset(root: string, sourceRoot: string, file: string, occurrence: ImageOccurrence): Promise<Omit<ImageOccurrence, 'url'>> {
  const { url, ...view } = occurrence
  try {
    let bytes: Buffer
    if (/^data:/i.test(url)) {
      const match = /^data:image\/[a-zA-Z0-9.+-]+;base64,([a-zA-Z0-9+/=\s]+)$/i.exec(url)
      if (!match) return { ...view, reason: '保留原始图片引用，未另存资源。' }
      bytes = Buffer.from(match[1]!, 'base64')
      if (!bytes.length) throw new Error('内嵌图片为空。')
    } else if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) || url.startsWith('//')) {
      return { ...view, reason: '保留原始远程图片引用，不自动下载或识别。' }
    } else {
      const target = await realpath(path.resolve(path.dirname(file), decodeURIComponent(url.split(/[?#]/)[0]!)))
      if (!within(sourceRoot, target) || within(root, target)) throw new Error('图片路径超出已选资料范围或属于 Wiki 输出。')
      bytes = await readFile(target)
    }
    return { ...view, assetId: await saveObject(root, bytes) }
  } catch (error) { return { ...view, state: 'failed', reason: error instanceof Error ? error.message : '图片未能解析。' } }
}
export async function scanLibrary(store: LibraryStore, id: string, signal?: AbortSignal, maxChars = 12000): Promise<ScanJob> {
  const library = store.registration(id)
  const root = await store.root(id, true)
  if (!(await store.policy(id)).initialized) throw new Error('请先初始化随库状态。')
  const paths = await validateRoots(root, library.sourceRoots)
  if (!paths.sources.length) throw new Error('请先登记原始资料目录。')
  return await withLibraryLock(root, 'scan', async () => {
    if((await readGenerateJobSummaries(root)).some(job=>job.status==='running'))throw new Error('该库有运行中的生成任务，请先停止并保存检查点，再扫描资料。')
    const catalogPath = await safePath(root, '.llmwiki/sources/catalog.json')
    const records = await readOptional<SourceRecord[]>(catalogPath) ?? []
    const fileKey=(file:string)=>process.platform==='win32'?path.resolve(file).toLowerCase():path.resolve(file)
    const seen = new Set<string>()
    const job: ScanJob = { id: randomUUID(), libraryId: id, stage: 'scanned', createdAt: new Date().toISOString(), files: [], errors: [], excluded: [], textChars: 0, bytes: 0 }
    const { inputs, errors, excluded, failedDirectories, failedFiles } = await scanSourceFiles(paths.sources, root, signal)
    job.errors.push(...errors); job.excluded.push(...excluded)
    const segmentHashes = (text: string) => parseMarkdown(text).children.flatMap(node => node.position
      ? [signature(text.slice(node.position.start.offset!, node.position.end.offset!))] : [])
    const resourceHash = (images: SourceVersion['images']) => signature(JSON.stringify(images.map(image => [image.id, image.assetId ?? image.reason])))
    const prepared: { path: string; hash: string; segments: string[]; bytes: Buffer; rawHash: string; sourceRoot: string;
      parsed: ReturnType<typeof separateImages>; images: SourceVersion['images']; resources: string }[] = []
    for(const input of inputs){
      try {
        signal?.throwIfAborted()
        const bytes = await stableRead(input.actual), rawHash = await saveObject(root, bytes), text = decodeSourceText(bytes)
        const parsed = separateImages(text, /\.(md|markdown)$/i.test(input.actual)), images: SourceVersion['images'] = []
        for (const image of parsed.images) images.push(await imageAsset(root, input.sourceRoot, input.actual, image))
        const resources = resourceHash(images)
        prepared.push({ path: input.actual, hash: rawHash + ':' + resources, segments: segmentHashes(text), bytes, rawHash, sourceRoot: input.sourceRoot, parsed, images, resources })
      }catch(error){if(signal?.aborted)throw error;failedFiles.add(fileKey(input.actual));job.errors.push({path:input.actual,message:error instanceof Error?error.message:'资料读取失败。'})}
    }
    const identities = await Promise.all(records.filter(record => record.state !== 'missing').map(async record => {
      const version = await readOptional<SourceVersion>(await safePath(root, `.llmwiki/sources/${record.id}/${record.hash}.json`))
      const oldText = record.segmentHashes ? undefined : await readFile(await safePath(root, '.llmwiki/objects/' + record.hash))
      return { record, id: record.id, path: record.absolutePath, aliases: record.aliasPaths,
        hash: record.hash + ':' + (record.resourceHash ?? resourceHash(version?.images ?? [])), segments: record.segmentHashes ?? segmentHashes(decodeSourceText(oldText!)) }
    }))
    const matches = matchSourceIdentities(prepared, identities, layeredSettings(library.layered).sourceMatchThreshold)
    for(const group of matches.groups){
      const { sourceRoot, path: actual, bytes, rawHash: hash, parsed, images, resources, segments } = group.documents[0]!
      const previous = group.previous?.record
      signal?.throwIfAborted()
      if (previous) seen.add(previous.id)
      try {
        const previousPath=previous&&previous.absolutePath!==actual?previous.absolutePath:undefined
        const record:SourceRecord=previous??{id:randomUUID(),root:sourceRoot,relativePath:path.relative(sourceRoot,actual),absolutePath:actual,hash,bytes:bytes.length,state:'active',previousPaths:[]}
        const change:ScanFile['change']=record.state==='withdrawn'?'withdrawn':!previous?'new':previous.hash!==hash?'changed':previousPath?'moved':'unchanged'
        const versionPath=`.llmwiki/sources/${record.id}/${hash}.json`
        let version=await readOptional<SourceVersion>(await safePath(root,versionPath))
        if(!version||version.parserVersion!==2||resourceHash(version.images)!==resources){
          const chunks=partitionText(parsed,maxChars)
          version={sourceId:record.id,hash,parserVersion:2,chunkBudget:maxChars,snapshotObject:hash,textObject:await saveObject(root,Buffer.from(parsed.text)),mapping:parsed.mapping,images,chunks:chunks.map(({text:_text,...chunk})=>chunk)}
          await writeState(root,versionPath,version)
        }
        if(previousPath){
          if(record.committedHash&&!record.committedPath)record.committedPath=previousPath
          record.previousPaths=[...new Set([...record.previousPaths,previousPath])]
          record.absolutePath=actual;record.relativePath=path.relative(sourceRoot,actual);record.root=sourceRoot
        }
        record.hash=hash;record.bytes=bytes.length
        record.segmentHashes = segments; record.resourceHash = resources
        const aliases = group.documents.slice(1).map(document => document.path).sort()
        record.previousPaths = [...new Set([...record.previousPaths, ...(record.aliasPaths ?? []).filter(file => file !== actual && !aliases.includes(file))])]
        record.aliasPaths = aliases
        if(record.state==='missing')record.state='active'
        if(!previous)records.push(record)
        seen.add(record.id)
        const needsUpdate=record.committedHash!==record.hash||!!record.committedPath&&record.committedPath!==record.absolutePath
        for (const document of group.documents) {
          job.bytes+=document.bytes.length;job.textChars+=document.parsed.text.length
          job.files.push({sourceId:record.id,path:document.path,...(previousPath?{previousPath}:{}),change,bytes:document.bytes.length,chunks:version.chunks.length,images:version.images.length,pendingImages:version.images.filter(image=>image.state==='failed').length,
            needsGeneration:record.state==='active'&&needsUpdate,generation:record.state!=='active'?'inactive':record.committedHash===undefined?'new':needsUpdate?'update':'current'})
        }
      }catch(error){if(signal?.aborted)throw error;job.errors.push({path:actual,message:error instanceof Error?error.message:'资料读取失败。'})}
    }
    for (const record of records) if (!seen.has(record.id) && !failedFiles.has(fileKey(record.absolutePath)) && paths.sources.some(sourceRoot => within(sourceRoot, record.absolutePath)) && !failedDirectories.some(failed => within(failed, record.absolutePath))) {
      record.state = record.state === 'withdrawn' ? 'withdrawn' : 'missing'
      job.files.push({ sourceId: record.id, path: record.absolutePath, change: 'missing', bytes: record.bytes, chunks: 0, images: 0, pendingImages: 0 })
    }
    signal?.throwIfAborted()
    await store.root(id, true)
    store.assertUnchanged(library)
    await writeState(root, '.llmwiki/sources/catalog.json', records)
    await writeState(root, `.llmwiki/jobs/${job.id}.json`, job)
    return job
  })
}
