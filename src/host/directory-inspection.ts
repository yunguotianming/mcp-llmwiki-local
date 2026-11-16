import path from 'node:path'
import { readdir, stat } from 'node:fs/promises'
import { directory, safePath } from '../storage/paths.js'
import { readOptional } from '../storage/files.js'
import { readCurrent, readManifest } from '../layered/objects.js'
import { findLayeredLibrary } from '../wiki/query.js'
import type { LibraryStore } from '../storage/libraries.js'
import { registeredEmbedding } from '../storage/embedding-registration.js'

// 复制进来的锁不属于本机任何进程；只报告，不在检查时删除。
const lockFiles = ['.llmwiki-build.lock', '.llmwiki/coordination/write.lock', 'coordination/write.lock']
async function leftoverLocks(root: string): Promise<string[]> {
  const found: string[] = []
  for (const relative of lockFiles) {
    try { if ((await stat(await safePath(root, relative))).isFile()) found.push(relative) }
    catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error }
  }
  return found
}

export async function inspectDirectory(input: string, signal?: AbortSignal, store?: LibraryStore) {
  const root = await directory(input)
  // 分层库（资料根或其 .llmwiki 成果根）按已发布版本计页，复制到别处后可直接重新登记。
  const layered = await findLayeredLibrary(root)
  if (layered) {
    signal?.throwIfAborted()
    const manifest = await readManifest(layered.root, await readCurrent(layered.root))
    const knowledgeRoot = /^\.llmwiki(?:-[a-z0-9-]+)?$/i.test(path.basename(layered.root)) ? path.dirname(layered.root) : layered.root
    const locks = [...new Set([...await leftoverLocks(knowledgeRoot), ...await leftoverLocks(layered.root)])]
    return { path: root, name: layered.card.name || path.basename(root), pageCount: Object.keys(manifest.pages ?? {}).length, layered: true as const,
      wikiPath: layered.root, sourceRoot: knowledgeRoot, ...await registeredEmbedding(layered.root),
      ...store ? await store.copiedIdentity(layered.root) : {},
      ...(manifest.version ? { version: manifest.version } : {}), ...(locks.length ? { locks } : {}) }
  }
  let pageCount = 0
  let directoryCount = 0
  const pending = (await readdir(root, { withFileTypes: true }))
    .filter(item => ['entities', 'concepts', 'sources'].includes(item.name) && item.isDirectory() && !item.isSymbolicLink())
    .map(item => path.join(root, item.name))
  while (pending.length) {
    signal?.throwIfAborted()
    const current = pending.pop()!
    if (++directoryCount > 10_000) throw new Error('目录过大，请选择具体的 Wiki 文件夹。')
    for (const item of await readdir(await safePath(root, path.relative(root, current)), { withFileTypes: true })) {
      // 不跟随链接、不扫描隐藏状态与依赖目录；登记只统计成果文件，不读取正文。
      if (item.name.startsWith('.') || item.name === 'node_modules' || item.isSymbolicLink()) continue
      if (item.isDirectory()) pending.push(path.join(current, item.name))
      else if (item.isFile() && item.name.toLowerCase().endsWith('.md')) pageCount++
      if (pageCount > 100_000 || pending.length > 10_000) throw new Error('目录过大，请选择具体的 Wiki 文件夹。')
    }
  }
  signal?.throwIfAborted()
  const metadata = await readOptional<{ libraryId?: unknown }>(await safePath(root, '.llmwiki/library.json'))
  return { path: root, name: path.basename(root), pageCount,
    ...(typeof metadata?.libraryId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(metadata.libraryId) ? { libraryId: metadata.libraryId } : {}) }
}
