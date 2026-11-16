import { expect, it } from 'vitest'
import { selectAnswerEvidence } from '../src/wiki/answer-evidence.js'
import { evidenceHit } from './answer-evidence-fixture.js'

const source = { sourceId: 'S-0101', sourceVersion: 'sha256:fixture' }
const ref = (line: number, anchor = `p${line}`) => `[S-0101@sha256:fixture#L${line}-L${line}](../sources/S-0101.md#^${anchor})`

it('补读的原始锚点与展开引用合并，保留真实引用和两种保护标记', () => {
  const expanded = evidenceHit('sources/S-0101.md', [`培养路线提供带薪训练。 ${ref(12)}`], [source])
  const raw = evidenceHit('sources/S-0101.md', ['培养路线提供带薪训练。 [证据](#^p12)'], [source])
  expanded.excerpts[0]!.segments![0]!.unverified = true
  raw.excerpts[0]!.segments![0]!.truncated = true
  const another = evidenceHit('sources/S-0101.md', [`培养路线通常持续三年。 ${ref(16)}`], [source])
  for (const hits of [[expanded, raw, another], [raw, expanded, another]]) {
    const selected = selectAnswerEvidence('培养路线', hits, 'v000001', { budget: 4000, limit: 2 })
    expect(selected).toHaveLength(2)
    const merged = selected.find(item => item.content.includes('带薪'))!
    expect(merged.content).toContain(ref(12))
    expect(merged).toMatchObject({ unverified: true, truncated: true })
    expect(merged.segments[0]).toMatchObject({ unverified: true, truncated: true })
    expect(selected.some(item => item.content.includes('三年'))).toBe(true)
  }
})

it('相同主张绑定不同原文或不同来源版本时不能合并', () => {
  const hits = [evidenceHit('sources/S-0101.md', [`培养路线提供带薪训练。 ${ref(12)}`, `培养路线提供带薪训练。 ${ref(16)}`], [source]),
    evidenceHit('sources/S-0101.md', ['培养路线提供带薪训练。 [S-0101@sha256:second#L12-L12]'], [{ ...source, sourceVersion: 'sha256:second' }])]
  expect(selectAnswerEvidence('培养路线', hits, 'v000001', { budget: 4000, limit: 8 })).toHaveLength(3)
})

it('明确题名的跨语言原文保留多个片段，不被背景词候选挤空', () => {
  const target = evidenceHit('sources/S-0101.md', ['A practitioner changes roles.', 'Which situation describes the transition?', 'A. Experienced practitioner and novice instructor.']
    .map((body, index) => `${body} ${ref(index + 21)}`), [source], 'FIELD GUIDE')
  const backgrounds = Array.from({ length: 9 }, (_, index) => evidenceHit(`sources/S-${200 + index}.md`, ['双重身份在实践中形成张力，测验涉及身份改变。']))
  const selected = selectAnswerEvidence('《FIELD GUIDE》关于“测验中的双重身份”的原文证据在哪里？', [target, ...backgrounds], 'v000001', { budget: 4000, limit: 8 })
  expect(selected.filter(item => item.path === target.path)).toHaveLength(3)
  expect(selected.some(item => item.content.includes('novice instructor'))).toBe(true)
})

it('明确比较两个题名时保留两边真实引用，题名相同但无引用的背景不抢先', () => {
  const first = evidenceHit('sources/S-0101.md', [`共同条件为甲。 ${ref(21)}`], [source], 'FIRST GUIDE')
  const second = evidenceHit('sources/S-0102.md', ['The corresponding condition is beta. [S-0102@sha256:fixture#L9-L9]'], [{ sourceId: 'S-0102', sourceVersion: 'sha256:fixture' }], 'SECOND GUIDE')
  const unrelated = evidenceHit('topics/T-0101.md', Array.from({ length: 8 }, () => '共同条件包括身份与专业身份。'), [], 'FIRST GUIDE')
  const selected = selectAnswerEvidence('《FIRST GUIDE》和《SECOND GUIDE》的共同条件是什么？', [unrelated, first, second], 'v000001', { budget: 4000, limit: 2 })
  expect(new Set(selected.map(item => item.path))).toEqual(new Set([first.path, second.path]))
})

it('同样的正文和引用集合但逐句引用归属不同，不能合并', () => {
  const first = `培养路线有薪。 ${ref(12)} 学位路线三年。 ${ref(16)}`
  const second = `培养路线有薪。 ${ref(16)} 学位路线三年。 ${ref(12)}`
  const selected = selectAnswerEvidence('培养路线', [evidenceHit('sources/S-0101.md', [first, second], [source])], 'v000001', { budget: 4000, limit: 8 })
  expect(selected).toHaveLength(2)
})
