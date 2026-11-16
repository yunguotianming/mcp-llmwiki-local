import { expect, it, vi } from 'vitest'
import { assembleAnswerEvidence, selectAnswerEvidence } from '../src/wiki/answer-evidence.js'
import { evidenceHit, pendingTopicReview, sourcePage } from './answer-evidence-fixture.js'

it('待核实主题候选去重和截断保留状态，片段统一标未核实', () => {
  const hit = evidenceHit('topics/T-0001.md', ['培养路线提供带薪训练。'.repeat(60)])
  hit.pendingReview = pendingTopicReview()
  const selected = selectAnswerEvidence('培养路线', [hit, structuredClone(hit)], 'v000001', { budget: 300, limit: 3 })
  expect(selected).toHaveLength(1)
  expect(selected[0]).toMatchObject({ pendingReview: hit.pendingReview, unverified: true, truncated: true })
  expect(selected[0]!.segments.every(segment => segment.unverified)).toBe(true)
  expect(Buffer.byteLength(selected[0]!.content)).toBeLessThanOrEqual(300)
  const normal = selectAnswerEvidence('培养路线', [evidenceHit('topics/T-0002.md', ['培养路线包括实践。'])], 'v000001', { budget: 300, limit: 1 })
  expect(normal[0]).not.toHaveProperty('pendingReview')
})

it('同文同引用的来源和待核实主题不合并迁移状态', () => {
  const text = '培养路线提供带薪训练。[S-0001@sha256:test#L8-L8]', refs = [{ sourceId: 'S-0001', sourceVersion: 'sha256:test' }]
  const topic = evidenceHit('topics/T-0001.md', [text], refs), source = evidenceHit('sources/S-0001.md', [text], refs)
  topic.pendingReview = pendingTopicReview()
  for (const hits of [[topic, source], [source, topic]]) {
    const selected = selectAnswerEvidence('培养路线', hits, 'v000001', { budget: 3000, limit: 3 })
    expect(selected).toHaveLength(2)
    expect(selected.find(item => item.path === topic.path)).toMatchObject({ pendingReview: topic.pendingReview, unverified: true })
    expect(selected.find(item => item.path === source.path)).not.toHaveProperty('pendingReview')
    expect(selected.find(item => item.path === source.path)!.unverified).toBe(false)
  }
})

it('按真实引用补读来源时不继承主题待核实状态', async () => {
  const hit = evidenceHit('topics/T-0001.md', ['培养路线包括实践。[S-0001@sha256:test#L8-L8]'], [{ sourceId: 'S-0001', sourceVersion: 'sha256:test' }])
  hit.pendingReview = pendingTopicReview()
  const read = vi.fn(async () => sourcePage('S-0001', '# 原始来源\n\n培养路线提供带薪训练。[S-0001@sha256:test#L9-L9]'))
  const selected = await assembleAnswerEvidence('培养路线', [hit], 'v000001', { budget: 3000, limit: 3, read })
  expect(selected.find(item => item.path === hit.path)).toMatchObject({ pendingReview: hit.pendingReview, unverified: true })
  const source = selected.find(item => item.path === 'sources/S-0001.md')!
  expect(source).toBeDefined(); expect(source).not.toHaveProperty('pendingReview'); expect(source.unverified).toBe(false)
})
