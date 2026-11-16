import { expect, it, vi } from 'vitest'
import { askWiki } from '../src/wiki/chat.js'
import { WikiQuery } from '../src/wiki/query.js'
import type { AnswerEvidence } from '../src/wiki/answer-evidence.js'
import { evidenceHit, pendingTopicReview } from './answer-evidence-fixture.js'
import { fixture } from './query-pages-audit-fixture.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

it('聊天模型输入及最终引用携带历史待核实状态，提示按原文确认范围回答', async () => {
  const f = await fixture(), hit = evidenceHit('topics/T-0001.md', ['培养路线提供带薪训练。'])
  hit.pendingReview = pendingTopicReview()
  vi.spyOn(WikiQuery.prototype, 'search').mockResolvedValue({ results: [hit], answerGuidance: '' } as never)
  vi.spyOn(WikiQuery.prototype, 'read').mockResolvedValue({ path: hit.path, title: hit.title, content: hit.snippet, status: 'ok',
    currentVersion: hit.version, version: hit.version, sourceVersions: [], pendingReview: hit.pendingReview } as never)
  try {
    f.library.models.unified = { provider: 'fake', model: 'fake' }
    f.runtime.resolveModelInfo.mockResolvedValue({ provider: 'fake', id: 'fake', name: 'fake', context: { contextWindow: 32768 } } as never)
    f.runtime.stream.mockImplementation(async function* (request) {
      const part = request.messages[0]!.content.find(part => part.type === 'text')!
      const input = JSON.parse('text' in part ? part.text : '') as { evidence: AnswerEvidence[] }
      expect(input.evidence[0]).toMatchObject({ pendingReview: hit.pendingReview, unverified: true })
      expect(input.evidence[0]!.segments.every(segment => segment.unverified)).toBe(true)
      expect(request.system).toContain('pendingReview 表示保留的历史主题尚待核实')
      expect(request.system).toContain('依据本次提供的来源原文确认后按可确认范围回答')
      yield { type: 'text-delta', text: '{"units":[{"block":"paragraph","text":"该主题保留了培养路线的历史表述。","citationIds":[1]}]}' }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })
    const answer = await askWiki(f.store, f.library.id, '培养路线', [], f.runtime)
    expect(answer.citations[0]).toMatchObject({ pendingReview: hit.pendingReview, segments: [{ unverified: true }] })
    expect(f.runtime.stream).toHaveBeenCalledTimes(1)
  } finally { vi.restoreAllMocks(); cleanupLayeredFixtures(); f.cleanup() }
})
