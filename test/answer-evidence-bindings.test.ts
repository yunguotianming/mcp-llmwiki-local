import { expect, it } from 'vitest'
import { selectAnswerEvidence } from '../src/wiki/answer-evidence.js'
import { evidenceHit } from './answer-evidence-fixture.js'

it('同页同正文去重时合并未核实和裁剪标记，不能被前面的副本洗掉', () => {
  const first = evidenceHit('sources/S-0001.md', ['编码分歧由团队讨论。']), duplicate = structuredClone(first)
  duplicate.excerpts[0]!.segments![0]!.unverified = true
  duplicate.excerpts[0]!.segments![0]!.truncated = true
  const selected = selectAnswerEvidence('编码分歧', [first, duplicate], 'v000001', { budget: 4000, limit: 3 })
  expect(selected).toHaveLength(1)
  expect(selected[0]).toMatchObject({ unverified: true, truncated: true, segments: [{ unverified: true, truncated: true }] })
})

it('复合摘录拆分后各段只绑定自己正文中的实际来源', () => {
  const sourceVersions = ['S-0001', 'S-0002'].map(sourceId => ({ sourceId, sourceVersion: 'sha256:test' }))
  const texts = ['编码由甲研究执行。[S-0001@sha256:test#L8-L8]', '编码由乙研究执行。[S-0002@sha256:test#L9-L9]']
  const hit = evidenceHit('topics/T-0001.md', texts, sourceVersions), first = hit.excerpts[0]!, second = hit.excerpts[1]!
  first.content += '\n' + second.content
  first.segments!.push({ ...second.segments![0]!, start: texts[0]!.length + 1, end: first.content.length })
  hit.excerpts = [first]
  const selected = selectAnswerEvidence('编码研究', [hit], 'v000001', { budget: 4000, limit: 3 })
  expect(selected).toHaveLength(2)
  expect(selected.find(item => item.content.includes('甲研究'))!.sources.map(source => source.sourceId)).toEqual(['S-0001'])
  expect(selected.find(item => item.content.includes('乙研究'))!.sources.map(source => source.sourceId)).toEqual(['S-0002'])
  expect(selected.every(item => item.segments[0]!.sources.length === 1)).toBe(true)
})
