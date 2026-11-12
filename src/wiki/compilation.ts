import { readFile } from 'node:fs/promises'
import type { LibraryPolicy } from '../domain/policy.js'
import type { LibraryRegistration } from '../domain/config.js'
import type { SourceRecord } from '../ingest/scanner.js'
import type { KnowledgeCatalog } from './documents.js'
import { blockSignature } from './documents.js'
import { processingPolicy } from '../domain/policy.js'
import { signature } from '../storage/files.js'
import { safePath } from '../storage/paths.js'
import { SYNTHESIS_VERSION } from './synthesis.js'

export interface Compilation { version: 1; inputKey: string; analysisKey?: string; sources?: { id: string; hash: string; path: string; state: SourceRecord['state'] }[]; files: { path: string; hash: string }[];incompleteSources?:string[] }
export function compilationKey(library: LibraryRegistration, policy: LibraryPolicy, schema: string | null, records: SourceRecord[], extractionVersion: string): string {
  return signature(JSON.stringify([library.name, library.models, processingPolicy(policy), schema, extractionVersion, SYNTHESIS_VERSION,
    records.map(record => [record.id, record.hash, record.absolutePath, record.relativePath, record.state]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]))
}
export async function unchangedCompilation(root: string, catalog: KnowledgeCatalog, key: string, records: SourceRecord[]): Promise<boolean> {
  if (catalog.compilation?.version !== 1 || catalog.compilation.inputKey !== key||catalog.quality?.complete===false||catalog.compilation.incompleteSources?.length) return false
  // 已提交输入相同仍核对原文与受管区；人工区的独立编辑不触发重新生成。
  for (const record of records.filter(record => record.state === 'active')) {
    if (signature(await readFile(record.absolutePath)) !== record.hash) throw new Error('来源已变化，请先扫描：' + record.relativePath)
  }
  const known = new Map(catalog.pages.map(page => [page.path, page]))
  for (const file of catalog.compilation.files) {
    const raw = await readFile(await safePath(root, file.path), 'utf8'), page = known.get(file.path)
    if (page ? blockSignature(raw) !== page.blockHash : signature(raw) !== file.hash) throw new Error('已发布页面发生外部修改，请先核对：' + file.path)
  }
  return true
}
