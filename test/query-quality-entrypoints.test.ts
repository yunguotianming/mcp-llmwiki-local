import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { answerGuidance } from '../src/wiki/page-search.js'
import { askWiki } from '../src/wiki/chat.js'
import { WikiQuery } from '../src/wiki/query.js'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { temporaryWorkspace } from './temp.js'
import { fixture } from './query-pages-audit-fixture.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

it('分层门面在 hits 模式仍返回片段绑定和回答约束', async () => {
  const f = await fixture()
  try {
    const result = await f.query.search('公开来源证据', undefined, undefined, 5, undefined, { include: 'hits', variants: ['公开来源'] })
    expect(result.answerGuidance).toBe(answerGuidance)
    expect(result.results.length).toBeGreaterThan(0)
    for (const hit of result.results) {
      expect(hit.excerpts).toEqual([])
      if (hit.snippet) expect(hit.snippetSegments.length).toBeGreaterThan(0)
    }
  } finally { cleanupLayeredFixtures(); await f.cleanup() }
})

it('旧版检索与问答将裁剪状态传到调用边界，保留有据回答及引用', async () => {
  const temp = await temporaryWorkspace(), library = newLibrary('quality'), registry = emptyRegistry()
  library.wikiPath = path.join(temp.root, 'wiki'); library.models.unified = { provider: 'fake', model: 'fake' }
  registry.libraries = [library]; registry.readMaxChars = 300
  const store = new LibraryStore(() => registry)
  try {
    await store.initialize(library.id); await mkdir(path.join(library.wikiPath, 'concepts'))
    await writeFile(path.join(library.wikiPath, 'concepts/a.md'), '# 试点条件\n\n在试点条件下招募10人。' + '背景。'.repeat(300))
    const search = await new WikiQuery(store).search('试点条件', undefined, undefined, 5, undefined, { variants: ['招募'] })
    expect(search.results[0]!.snippetSegments[0]!.truncated).toBe(true)
    let calls = 0
    const answer = await askWiki(store, library.id, '试点条件', [], {
      async resolveModelInfo(provider, id) { return { provider, id, name: id, context: { contextWindow: 10000 } } },
      async *stream(options) {
        calls++
        const serialized = JSON.stringify(options)
        expect(serialized).toContain('单人观点不能推广到群体')
        expect(serialized).toContain('truncated\\":true')
        expect(serialized).toContain('在试点条件下招募10人')
        yield { type: 'text-delta', text: '{"units":[{"block":"paragraph","text":"在试点条件下招募10人。","citationIds":[1]}]}' }
        yield { type: 'finish', reason: { kind: 'stop' } }
      },
    })
    expect(calls).toBe(1)
    expect(answer.answer).toBe('在试点条件下招募10人。 [1]')
    expect(answer.citations[0]!.excerpt).toContain('在试点条件下招募10人')
  } finally { await temp.cleanup() }
})
