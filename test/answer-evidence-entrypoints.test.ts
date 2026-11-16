import { expect, it, vi } from 'vitest'
import { askWiki } from '../src/wiki/chat.js'
import { WikiQuery } from '../src/wiki/query.js'
import type { AnswerEvidence } from '../src/wiki/answer-evidence.js'
import { fixture } from './query-pages-audit-fixture.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

it('原生问答使用十个候选和精确库ID，题名绑定进入模型且只回答一次', async () => {
  const f = await fixture(), search = vi.spyOn(WikiQuery.prototype, 'search'), read = vi.spyOn(WikiQuery.prototype, 'read')
  try {
    f.library.models.unified = { provider: 'fake', model: 'fake' }
    f.runtime.resolveModelInfo.mockResolvedValue({ provider: 'fake', id: 'fake', name: 'fake', context: { contextWindow: 32768 } } as never)
    f.runtime.stream.mockImplementation(async function* (options) {
      const text = options.messages[0]!.content.find(part => part.type === 'text')!
      const input = JSON.parse('text' in text ? text.text : '') as { evidence: AnswerEvidence[] }
      expect(input.evidence.some(item => item.sources.some(source => source.sourceId === 'S-0002' && source.title === '审查证据S-0002'))).toBe(true)
      expect(input.evidence.reduce((sum, item) => sum + Buffer.byteLength(item.content), 0)).toBeLessThanOrEqual(6000)
      expect(input.evidence.length).toBeLessThanOrEqual(8)
      yield { type: 'text-delta', text: '{"units":[{"block":"paragraph","text":"公开证据见来源。","citationIds":[1]}]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const answer = await askWiki(f.store, f.library.id, '公开证据', [], f.runtime)
    expect(search).toHaveBeenCalledTimes(1)
    expect(search.mock.calls[0]![1]).toBe(f.library.id)
    expect(search.mock.calls[0]![3]).toBe(10)
    expect(read.mock.calls.length).toBeGreaterThan(0)
    expect(read.mock.calls.every(call => call[1] === f.library.id && call[4]?.version === 'v000001')).toBe(true)
    expect(f.runtime.stream).toHaveBeenCalledTimes(1)
    expect(answer.citations[0]!.segments?.every(segment => segment.end > segment.start)).toBe(true)
  } finally { vi.restoreAllMocks(); cleanupLayeredFixtures(); f.cleanup() }
})

it('模型调用后的来源撤权仍阻止返回回答，不追加理解或回答调用', async () => {
  const f = await fixture()
  try {
    f.library.models.unified = { provider: 'fake', model: 'fake' }
    f.runtime.stream.mockImplementation(async function* () {
      await f.put('state/revocations.json', { generation: 1, sources: [{ source_id: 'S-0002', generation: 1, current_path: 'S-0002.md', reason: '用户撤权', revoked_at: '2026-11-15T00:00:00Z' }] })
      yield { type: 'text-delta', text: '{"units":[{"block":"paragraph","text":"公开证据见来源。","citationIds":[1]}]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    await expect(askWiki(f.store, f.library.id, '公开证据', [], f.runtime)).rejects.toThrow(/变化|撤权/)
    expect(f.runtime.stream).toHaveBeenCalledTimes(1)
  } finally { cleanupLayeredFixtures(); f.cleanup() }
})
