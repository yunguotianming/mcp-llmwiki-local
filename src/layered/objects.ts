import { hash, hashName, immutableWrite, readVerifiedObject } from './files.js'
import { formatVersion } from './schema.js'
import type { SnapshotManifest } from './schema.js'
import { storageJson } from './vectors.js'
import { safePath } from '../storage/paths.js'
import { readOptional } from '../storage/files.js'
import type { CurrentVersion } from './schema.js'

export async function readCurrent(root: string): Promise<CurrentVersion | undefined> {
  const current = await readOptional<CurrentVersion>(await safePath(root, 'state/current.json'))
  if (current && (!/^v\d{6,}$/.test(current.version) || !Number.isSafeInteger(current.revocation_generation) || current.revocation_generation < 0)) throw new Error('当前版本指针无效。')
  return current
}
export async function readManifest(root: string, current?: CurrentVersion): Promise<SnapshotManifest> {
  if (!current) return { format_version: formatVersion, version: null, next_source_number: 1, revocation_generation: 0, sources: [] }
  const manifest = await readVersion(root, current.version)
  if (!manifest || manifest.format_version !== formatVersion || manifest.version !== current.version || manifest.revocation_generation !== current.revocation_generation) throw new Error('当前版本 manifest 无效。')
  return manifest
}

export const pageObjectPath = (id: string): string => {
  if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('页面对象 ID 无效。')
  return `objects/pages/${hashName(id)}.md`
}
export async function putPage(root: string, content: string): Promise<string> {
  const id = hash(content)
  await immutableWrite(root, pageObjectPath(id), Buffer.from(content))
  return id
}
export async function readPageObject(root: string, id: string): Promise<string> {
  return readVerifiedObject(root, pageObjectPath(id), id, bytes => {
    if (hash(bytes) !== id) throw new Error('页面对象校验失败。')
    return bytes.toString('utf8')
  })
}
export const manifestPath = (version: string): string => {
  if (!/^v\d{6,}$/.test(version)) throw new Error('版本号无效。')
  return `versions/${version}.json`
}
export async function readVersion(root: string, version: string): Promise<SnapshotManifest> {
  const manifest = await readVerifiedObject(root, manifestPath(version), `manifest:${formatVersion}:${version}`, bytes => {
    const envelope = JSON.parse(bytes.toString('utf8')) as { checksum: string; manifest: SnapshotManifest }
    const manifest = envelope.manifest
    if (!manifest || manifest.format_version !== formatVersion || manifest.version !== version || !manifest.pages || !manifest.deps || !manifest.aliases
      || hash(storageJson(manifest)) !== envelope.checksum) throw new Error('版本清单校验失败。')
    return manifest
  })
  return structuredClone(manifest)
}
export async function writeVersion(root: string, manifest: SnapshotManifest): Promise<void> {
  // 序列化一次后回读，校验的是实际落盘的无向量清单。
  const plain = JSON.parse(storageJson(manifest)) as SnapshotManifest
  await immutableWrite(root, manifestPath(manifest.version!), Buffer.from(storageJson({ checksum: hash(storageJson(plain)), manifest: plain })))
  await readVersion(root, manifest.version!)
}
export async function versionPage(root: string, manifest: SnapshotManifest, page: string): Promise<string> {
  const id = manifest.pages?.[page]
  if (!id) throw Object.assign(new Error('页面不在版本清单中：' + page), { code: 'ENOENT' })
  return readPageObject(root, id)
}
export async function publishedPage(root: string, version: string, page: string): Promise<string> {
  return versionPage(root, await readVersion(root, version), page)
}
