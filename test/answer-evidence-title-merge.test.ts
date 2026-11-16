import { expect, it } from 'vitest'
import { selectAnswerEvidence } from '../src/wiki/answer-evidence.js'
import { evidenceHit } from './answer-evidence-fixture.js'

it('主题副本先到时合并后仍保留来源页的明确题名和真实来源元数据', () => {
  const sources = [{ sourceId: 'S-0101', sourceVersion: 'sha256:fixture' }]
  const content = 'The participant changed roles. [S-0101@sha256:fixture#L12-L12](../sources/S-0101.md#^p12)'
  const topic = evidenceHit('topics/T-0101.md', [content], sources, '角色转换')
  topic.excerpts[0]!.segments![0]!.unverified = true
  const source = evidenceHit('sources/S-0101.md', [content], sources, 'FIELD GUIDE')
  const background = evidenceHit('topics/T-0102.md', ['双重身份转换涉及身份张力。'])
  const selected = selectAnswerEvidence('《FIELD GUIDE》关于双重身份转换的原文是什么？', [topic, source, background], 'v000001', { budget: 4000, limit: 1 })
  expect(selected).toHaveLength(1)
  expect(selected[0]).toMatchObject({ path: source.path, content, unverified: true })
  expect(selected[0]!.sources[0]!.title).toBe('FIELD GUIDE')
})
