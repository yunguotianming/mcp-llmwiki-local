import { readFile, unlink } from 'node:fs/promises'
import { safePath } from '../storage/paths.js'
import { readOptional } from '../storage/files.js'
import { atomicWrite, hash, hashName, withRevocationLock, writeJson } from './files.js'
import { putPage, readPageObject, readVersion } from './objects.js'
import { pinVersion } from './retention.js'
import type { SnapshotManifest } from './schema.js'

export interface ReadingCopyState {
  version: string | null; target: string | null; materialized: Record<string, string>
  desired?: Record<string, string>; failures: Record<string, string>
  warning?: string
}
const statePath = 'state/reading-copy.json'
const validPage = (page: string) => page === 'index.md' || /^(sources|topics|terms)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.md$/.test(page)
export async function refreshReadingCopy(root: string, manifest: SnapshotManifest): Promise<void> {
  const saved = await readOptional<ReadingCopyState>(await safePath(root, statePath))
  if (saved?.version === manifest.version && !saved.target && !saved.warning) return
  const pinned = await pinVersion(root, undefined, false)
  try {
  manifest = pinned.manifest
  if (saved?.version === manifest.version && !saved.target && saved.warning === pinned.warning) return
  return await withRevocationLock(root, async () => {
  manifest = await readVersion(root, manifest.version!)
  const state = await readOptional<ReadingCopyState>(await safePath(root, statePath)) ?? { version: null, target: null, materialized: {}, failures: {} }
  if (state.version === manifest.version && !state.target && state.warning === pinned.warning) return
  const desired = { ...manifest.pages }
  if (pinned.warning && desired['index.md']) desired['index.md'] = await putPage(root, `> ${pinned.warning}\n\n` + await readPageObject(root, desired['index.md']))
  if (pinned.warning) state.warning = pinned.warning; else delete state.warning
  const pages = [...new Set([...Object.keys(state.materialized), ...Object.keys(desired)])].filter(validPage)
    .sort((a, b) => a === 'index.md' ? 1 : b === 'index.md' ? -1 : a.localeCompare(b))
  // intent 先落盘；写文件后、记录哈希前崩溃时，能够识别上一次成功替换的内容。
  const interrupted = state.desired ?? {}
  state.target = manifest.version; state.desired = desired; state.failures = {}
  await writeJson(root, statePath, state)
  const refresh = async (page: string): Promise<void> => {
    const old = state.materialized[page], next = desired[page]
    try {
      const file = await safePath(root, 'wiki/' + page)
      const bytes = await readFile(file).catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
      const disk = bytes ? hash(bytes) : undefined
      if (disk === next) {
        if (next) state.materialized[page] = next; else delete state.materialized[page]
        return
      }
      const owned = disk === old && old !== undefined || disk !== undefined && disk === interrupted[page]
      if (!owned && (old !== undefined || disk !== undefined)) {
        await writeJson(root, `conflicts/${hashName(hash(page + '\0' + manifest.version))}.json`, {
          page, version: manifest.version, previous_object: old ?? null, disk_hash: disk ?? null,
          new_object: next ?? null, detected_at: new Date().toISOString(), reason: disk ? '阅读页已被用户修改，保留磁盘内容。' : '阅读页已被用户删除，保留删除。',
        })
        return
      }
      if (next) await atomicWrite(root, 'wiki/' + page, await readPageObject(root, next))
      else if (owned) {
        for (let attempt = 0; ; attempt++) {
          try { await unlink(file); break }
          catch (error) {
            if (error instanceof Error && 'code' in error && error.code === 'ENOENT') break
            if (attempt >= 2 || !(error instanceof Error && 'code' in error && ['EBUSY', 'EPERM', 'EACCES'].includes(String(error.code)))) throw error
            await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)))
          }
        }
      }
      if (next) state.materialized[page] = next; else delete state.materialized[page]
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && ['EBUSY', 'EPERM', 'EACCES'].includes(String(error.code)))) throw error
      state.failures[page] = String(error)
    }
  }
  // 页面独立刷新，失败后等待本批退出；导航仍在全部正文处理结束后替换。
  const body = pages.filter(page => page !== 'index.md')
  for (let offset = 0; offset < body.length; offset += 8) {
    const results = await Promise.allSettled(body.slice(offset, offset + 8).map(refresh))
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }
  if (pages.includes('index.md')) await refresh('index.md')
  if (!Object.keys(state.failures).length) { state.version = manifest.version; state.target = null; delete state.desired }
  await writeJson(root, statePath, state)
  })
  } finally { await pinned.release() }
}
export async function resumeReadingCopy(root: string, version?: string): Promise<void> {
  if (version) await refreshReadingCopy(root, await readVersion(root, version))
}
