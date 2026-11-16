import { expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fixture } from './query-pages-audit-fixture.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'
import { createLocalHost } from '../src/local/host.js'
import { createMcpHandler } from '../src/mcp/server.js'
import { answerGuidance } from '../src/wiki/page-search.js'
import { buildRegistrationKey } from '../src/domain/build-identity.js'
import { sameExtractionContext } from '../src/layered/vector-build.js'
import { createLibraryDiscovery, searchDiscovered } from '../src/wiki/library-reader.js'
import { WikiQuery } from '../src/wiki/query.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

async function setup(contextWindow = 32000, onCall?: () => Promise<void>) {
  const f = await fixture()
  f.library.description = '审查公开来源证据'
  f.library.models.unified = { provider: 'compatible:answer', model: 'answer' }; f.library.models.layeredRoutes = {}
  f.registry.compatibleProviders = { 'compatible:answer': { baseUrl: 'https://offline.invalid/v1', model: 'answer', api: 'openai-completions', contextWindowTokens: contextWindow } }
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    const body = JSON.parse(String(init?.body)), input = JSON.parse(body.messages.at(-1).content[0].text)
    expect(input.evidence[0].segments.length).toBeGreaterThan(0)
    expect(input.evidence[0]).toHaveProperty('unverified')
    expect(input.evidence[0]).toHaveProperty('truncated')
    expect(JSON.stringify(body)).toContain('单人观点不能推广到群体')
    await onCall?.()
    return Response.json({ choices: [{ message: { content: '{"units":[{"block":"paragraph","text":"公开证据。","citationIds":[1]}]}' }, finish_reason: 'stop' }] })
  })
  const host = createLocalHost(f.registry, { request })
  return { ...f, host, request, cleanup: () => { host.dispose(); cleanupLayeredFixtures(); f.cleanup() } }
}

it('未指定库的 MCP 查询与回答先选库，保留回答约束和逐段定位，无匹配不扫描', async () => {
  const f = await setup(), handle = createMcpHandler(f.host)
  try {
    const metadata = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
    expect(await handle({ id: 0, method: 'initialize' })).toMatchObject({ result: { serverInfo: { version: metadata.version } } })
    const search = await f.host.query.search('公开来源证据')
    expect(search).toMatchObject({ selectedLibraries: [f.library.id], answerGuidance })
    expect(search.results.some(hit => hit.snippetSegments.length && hit.excerpts.some(excerpt => excerpt.segments?.length))).toBe(true)
    const response: any = await handle({ id: 1, method: 'tools/call', params: { name: 'wiki_answer', arguments: { question: '公开来源证据' } } })
    expect(response.result.isError).toBeUndefined()
    const value = JSON.parse(response.result.content[0].text)
    expect(value).toMatchObject({ selectedLibraries: [f.library.id], answerGuidance })
    expect(value.answers[0].citations[0].segments.length).toBeGreaterThan(0)
    expect(f.request).toHaveBeenCalledTimes(1)
    const missing = await f.host.query.search('zzzz-unmatched-991')
    expect(missing).toMatchObject({ results: [], selectedLibraries: [] })
    await expect(f.host.query.search('公开来源证据', '不存在的库')).rejects.toThrow('未找到')
  } finally { handle.dispose(); f.cleanup() }
})

it('分层回答超过可用上下文时零派发', async () => {
  const f = await setup(1000)
  try { await expect(f.host.answer(f.library.id, '公开来源证据')).rejects.toThrow(/预算/); expect(f.request).not.toHaveBeenCalled() }
  finally { f.cleanup() }
})

it('回答派发后撤权拒绝返回旧证据且不重复调用模型', async () => {
  let revoke: () => Promise<void> = async () => {}
  const f = await setup(32000, () => revoke())
  revoke = () => f.put('state/revocations.json', { generation: 1, sources: [{ source_id: 'S-0002', current_path: 'S-0002.md', reason: '测试撤权', revoked_at: '2026-11-15', generation: 1 }] })
  try { await expect(f.host.answer(f.library.id, '公开来源证据')).rejects.toThrow(/变化|撤权/); expect(f.request).toHaveBeenCalledTimes(1) }
  finally { f.cleanup() }
})

it('旧 pending 的查询字段与新续跑身份兼容，内容策略变化仍拒绝', async () => {
  const f = await fixture()
  try {
    const old = JSON.parse(buildRegistrationKey(f.library)); old.queryUnderstanding = { enabled: false }
    old.layered.queryEmbeddingTimeoutMs = 1; old.layered.searchRelevanceThreshold = 0.1
    f.library.queryUnderstanding = { enabled: true, model: { provider: 'new', model: 'new' } }
    f.library.layered = { ...f.library.layered, searchRelevanceThreshold: 0.8 }
    const left = { registrationKey: JSON.stringify(old), policyRevision: 'policy' }, right = { registrationKey: buildRegistrationKey(f.library), policyRevision: 'policy' }
    expect(sameExtractionContext(left, right)).toBe(true)
    expect(sameExtractionContext(left, { ...right, policyRevision: 'changed' })).toBe(false)
  } finally { cleanupLayeredFixtures(); f.cleanup() }
})

it('显式库同样受会话可见性约束，检索期间隐藏则拒绝返回旧结果', async () => {
  const f = await setup()
  let visible = false
  const discovery = createLibraryDiscovery(f.host.store, () => visible), search = WikiQuery.prototype.search
  const called = vi.spyOn(WikiQuery.prototype, 'search').mockImplementation(async function (...args) {
    const result = await search.apply(this, args); visible = false; return result
  })
  try {
    await expect(searchDiscovered(f.host.store, discovery, '公开来源证据', f.library.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(called).not.toHaveBeenCalled()
    visible = true
    await expect(searchDiscovered(f.host.store, discovery, '公开来源证据', f.library.id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(called).toHaveBeenCalledOnce()
  } finally { called.mockRestore(); f.cleanup() }
})
