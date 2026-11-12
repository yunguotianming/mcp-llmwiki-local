import path from 'node:path'
import { stat } from 'node:fs/promises'
import { defaultWikiPath, type LayeredSettings } from '../domain/config.js'
import { isLibraryDirectoryName } from '../domain/embedding-name.js'
import { actualPath, isLayeredRoot } from './paths.js'

export async function resolveLibraryRoot(knowledgeRoot: string, selected?: string, settings?: Partial<LayeredSettings>): Promise<string> {
  if (await isLayeredRoot(knowledgeRoot)) return knowledgeRoot
  if (selected) {
    const root = await actualPath(selected)
    if (path.dirname(root) !== knowledgeRoot || !isLibraryDirectoryName(path.basename(root))) throw new Error('库目录必须是资料根下的 .llmwiki 或 .llmwiki-<模型标准名>。')
    return root
  }
  const legacy = path.join(knowledgeRoot, '.llmwiki')
  if (!settings || await stat(legacy).then(() => true, error => { if (error.code === 'ENOENT') return false; throw error })) return actualPath(legacy)
  return actualPath(defaultWikiPath([knowledgeRoot], settings))
}
