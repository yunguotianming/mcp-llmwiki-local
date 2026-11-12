import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'vitest'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { generateDatabaseDescription } from '../src/wiki/database-description.js'
import { temporaryWorkspace } from './temp.js'

async function fixture(pageCount = 1) {
  const temp = await temporaryWorkspace(), library = newLibrary('summary')
  library.name = '研究 Wiki'; library.kind = 'obsidian'; library.mode = 'readonly'
  library.wikiPath = path.join(temp.root, 'wiki')
  library.models.unified = { provider: 'fake', model: 'summary-model' }
  const registry = emptyRegistry(); registry.libraries = [library]; registry.activeLibraryId = library.id
  const store = new LibraryStore(() => registry)
  for (const section of ['entities', 'concepts', 'sources/archive']) await mkdir(path.join(library.wikiPath, section), { recursive: true })
  for (let index = 0; index < pageCount; index++) {
    await writeFile(path.join(library.wikiPath, 'entities', `page-${index}.md`), `# 实体标题 ${index}\n\n正文机密：不能发送给模型。`)
  }
  await writeFile(path.join(library.wikiPath, 'concepts', 'method.md'), '---\ntitle: 研究方法\n---\n正文机密：不能发送给模型。')
  await writeFile(path.join(library.wikiPath, 'sources', 'note.md'), '# 来源材料\n正文机密：不能发送给模型。')
  await writeFile(path.join(library.wikiPath, 'sources', 'index.md'), '# 索引\n')
  await writeFile(path.join(library.wikiPath, 'sources', 'archive', 'old.md'), '# 已归档页面\n')
  return { ...temp, library, registry, store }
}

it('只将页面标题和分类数量交给模型，并清理与限制生成简介', async () => {
  const f = await fixture(82)
  let input = '', selectedModel = ''
  const runtime = {
    resolveModelInfo: async (provider: string, model: string) => { selectedModel = `${provider}/${model}`; return {} },
    stream: async function* (options: { messages: { content: { type: string; text?: string }[] }[] }) {
      input = options.messages[0]!.content[0]!.text!
      yield { type: 'text-delta', index: 0, text: '```text\n这本 Wiki 整理研究方法、相关实体和来源材料，收录 84 个可检索页面。\n```' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  } as unknown as ModelRuntime
  try {
    const result = await generateDatabaseDescription(f.store, f.library.id, JSON.stringify(f.library), runtime, new AbortController().signal)
    expect(result).toEqual({ description: '这本 Wiki 整理研究方法、相关实体和来源材料，收录 84 个可检索页面。', pageCount: 84 })
    expect(selectedModel).toBe('fake/summary-model')
    const sent = JSON.parse(input) as { pageCount: number; byType: Record<string, number>; titleSamples: string[] }
    expect(sent.pageCount).toBe(84)
    expect(sent.byType).toEqual({ entities: 82, concepts: 1, sources: 1 })
    expect(sent.titleSamples).toHaveLength(80)
    expect(input).toContain('研究方法')
    expect(input).not.toContain('正文机密')
    expect(input).not.toContain('已归档页面')
  } finally { await f.cleanup() }
})

it('登记在模型请求期间变化时，不返回基于旧登记生成的简介', async () => {
  const f = await fixture()
  const runtime = {
    resolveModelInfo: async () => ({}),
    stream: async function* () {
      f.registry.libraries[0]!.name = '已修改的名称'
      yield { type: 'text-delta', index: 0, text: '一段有效的数据库简介。' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  } as unknown as ModelRuntime
  try {
    await expect(generateDatabaseDescription(f.store, f.library.id, JSON.stringify(f.library), runtime, new AbortController().signal)).rejects.toThrow('数据库配置在操作期间发生变化')
  } finally { await f.cleanup() }
})

it('拒绝过期登记键和 whalefall 数据库', async () => {
  const f = await fixture()
  const runtime = { resolveModelInfo: async () => ({}), stream: async function* () {} } as unknown as ModelRuntime
  try {
    await expect(generateDatabaseDescription(f.store, f.library.id, 'stale', runtime, new AbortController().signal)).rejects.toThrow('数据库登记已变化')
    // f0f9856 起远端登记必须有稳定库身份，先满足登记校验再验证简介禁用。
    Object.assign(f.library, { kind: 'whalefall', mode: 'readonly', wikiPath: '', kbId: 'remote-wiki' })
    await expect(generateDatabaseDescription(f.store, f.library.id, JSON.stringify(f.library), runtime, new AbortController().signal)).rejects.toThrow('whalefall 数据库')
  } finally { await f.cleanup() }
})
