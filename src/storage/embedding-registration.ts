import path from 'node:path'
import { layeredSettings, type LayeredSettings } from '../domain/config.js'
import { embeddingStandardName } from '../domain/embedding-name.js'
import { readCurrent, readManifest } from '../layered/objects.js'
import { libraryVectorState, lockedEmbeddingSettings } from '../layered/vector-identity.js'

export async function registeredEmbedding(root: string, configured: Partial<LayeredSettings> = {}): Promise<{ embeddingSettings?: LayeredSettings; embeddingLocked?: boolean; embeddingNotice?: string }> {
  const state = await libraryVectorState(root, await readManifest(root, await readCurrent(root)), configured)
  if (!state || !state.identity && state.mode !== 'none') return {}
  const settings = layeredSettings(configured), identity = state.identity
  if (state.mode === 'none' || identity?.provider === 'lexical') settings.embeddingMode = 'none'
  else if (identity) lockedEmbeddingSettings(settings, identity)
  const standard = embeddingStandardName({ ...identity ? { model: identity.model, provider: identity.provider } : {}, embeddingMode: settings.embeddingMode })
  const actual = path.basename(root), expected = '.llmwiki-' + standard
  return { embeddingSettings: settings, embeddingLocked: true,
    ...(actual.startsWith('.llmwiki-') && actual !== expected ? { embeddingNotice: `目录名 ${actual} 与库内向量身份不一致；以库内 ${identity?.model ?? 'fulltext'} 为准，标准目录名为 ${expected}。` } : {}) }
}
