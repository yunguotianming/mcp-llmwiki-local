import { expect, it } from 'vitest'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { publicResult } from '../src/host/public-results.js'
import { createLocalHost } from '../src/local/host.js'
import { createMcpHandler } from '../src/mcp/server.js'

function registryFixture() {
  const registry = emptyRegistry(), library = newLibrary('library1')
  library.name = '库名1'; library.description = JSON.stringify({ detail: JSON.stringify({ key: '1' }) })
  library.wikiPath = 'C:/public-result-fixture1/.llmwiki'; library.sourceRoots = ['C:/public-result-fixture1']
  library.layered = { localEmbeddingModel: 'qwen3:1b', cloudEmbeddingKeyEnv: 'FIXTURE_KEY1', writerTakeoverToken: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' }
  registry.libraries = [library]; registry.activeLibraryId = library.id
  registry.compatibleProviders = { 'compatible:fixture1': { baseUrl: 'https://offline.invalid/v1', model: 'model1', api: 'openai-responses', apiKey: '1' } }
  return registry
}

it('公共登记保留可回填控制配置，移除凭据并遮蔽用户文本', () => {
  const registry = registryFixture(), result = publicResult({ registry, registryRevision: 'revision1' }, ['1'], 'registry/get') as { registry: typeof registry; registryRevision: string }
  expect(result.registryRevision).toBe('revision1'); expect(result.registry.activeLibraryId).toBe('library1')
  const library = result.registry.libraries[0]!
  expect(library).toMatchObject({ id: 'library1', wikiPath: registry.libraries[0]!.wikiPath, models: registry.libraries[0]!.models,
    layered: { localEmbeddingModel: 'qwen3:1b', cloudEmbeddingKeyEnv: 'FIXTURE_KEY1' }, name: '库名[已脱敏]' })
  expect(library.layered).not.toHaveProperty('writerTakeoverToken')
  expect(library.description).not.toContain('"1"')
  expect(result.registry.compatibleProviders!['compatible:fixture1']).toEqual({ baseUrl: 'https://offline.invalid/v1', model: 'model1', api: 'openai-responses' })
})

it('没有可信操作上下文的同名path/status字段和多层错误仍默认脱敏', () => {
  const key = 'quoted-"key\\tail', value = { path: 'running', status: 'running', detail: JSON.stringify({ nested: JSON.stringify({ key }) }), count: 1, enabled: true }
  const safe = publicResult(value, ['running', key]) as typeof value
  expect(safe).toMatchObject({ path: '[已脱敏]', status: '[已脱敏]', count: 1, enabled: true })
  expect(JSON.parse(JSON.parse(safe.detail).nested).key).toBe('[已脱敏]')
})

it('正文改变时引用范围对应当前字符串并失效，未改正文的附加来源题名仍脱敏', () => {
  const source = { sourceId: 'S-0001', sourceVersion: 'sha256:1', path: 'sources/S-0001.md', title: '题名1' }
  const segment = { start: 0, end: 4, anchor: '^p1', locator: 'L1-L1', contextLocator: 'L1-L1', truncated: false, unverified: false, sources: [source] }
  const answer = { answer: '', question: '', createdAt: '', historyUsed: 0, citations: [{ number: 1, path: source.path, title: '题名1', excerpt: '原始正文', hash: 'sha256:1', version: 'v000001', segments: [segment] }] }
  let safe = publicResult(answer, ['1'], 'wiki_answer') as typeof answer
  expect(safe.citations[0]!.segments[0]).toMatchObject({ anchor: '^p1', end: 4, sources: [{ ...source, title: '题名[已脱敏]' }] })
  answer.citations[0]!.excerpt = '正文1尾'
  safe = publicResult(answer, ['1'], 'wiki_answer') as typeof answer
  const citation = safe.citations[0]!
  expect(citation).toMatchObject({ path: source.path, version: 'v000001', excerpt: '正文[已脱敏]尾' })
  expect(citation.segments).toEqual([{ start: 0, end: citation.excerpt.length, anchor: '', locator: '', contextLocator: '', truncated: true, unverified: true, sources: [] }])
})

it('主仓MCP资源与工具入口传递可信类型，URI身份保持且名称遮蔽', async () => {
  const host = createLocalHost(registryFixture()), handle = createMcpHandler(host)
  try {
    const response = await handle({ id: 1, method: 'resources/list' }) as { result: { resources: { uri: string; name: string }[] } }
    expect(response.result.resources[0]).toMatchObject({ uri: 'llmwiki://libraries/library1/card', name: '库名[已脱敏]' })
    const tools = await handle({ id: 2, method: 'tools/call', params: { name: 'wiki_list_libraries', arguments: {} } }) as { result: { content: { text: string }[] } }
    expect(JSON.parse(tools.result.content[0]!.text).libraries[0]).toMatchObject({ libraryId: 'library1', cardUri: 'llmwiki://libraries/library1/card', name: '库名[已脱敏]' })
  } finally { handle.dispose(); host.dispose() }
})
