/** 模型目录名只取向量身份；全文和词项向量使用同一个名称。 */
export function embeddingStandardName(identity: { model?: string; provider?: string; embeddingMode?: string }): string {
  if (identity.embeddingMode === 'none' || identity.provider === 'lexical') return 'fulltext'
  const name = (identity.model ?? '').toLowerCase().replaceAll('-embedding', '').replaceAll(':', '-').replaceAll('.', '').replace(/[^a-z0-9-]/g, '')
  if (!name || !/[a-z0-9]/.test(name)) throw new Error('向量模型名称无法换算为库目录名。')
  return name
}
export const isLibraryDirectoryName = (name: string): boolean => /^\.llmwiki(?:-[a-z0-9-]+)?$/.test(name)
