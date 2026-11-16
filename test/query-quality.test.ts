import { expect, it } from 'vitest'
import { answerGuidance, excerpts, tokenCost } from '../src/wiki/page-search.js'
import { answerHash, compareAnswers, scoreAnswers } from './query-quality-replay.js'
import type { AnswerRecord, AnswerReview, QualityQuestion } from './query-quality-replay.js'

const question: QualityQuestion = { id: '条件', split: '锁定', facts: ['条件', '数量'], sources: ['来源甲'], coverage: true }
const text = '在试点条件下招募10人。'
const record: AnswerRecord = { id: question.id, answer: text, refused: false, retrievedSources: ['来源甲'] }
const review: AnswerReview = { id: question.id, answerHash: answerHash(text), sentences: [{ text, supported: true, facts: question.facts, sources: ['来源甲'], basis: '固定原文：在试点条件下招募10人。' }] }

it('逐段保留自己的引用与定位，非连续摘录不共用合并行范围', () => {
  const content = '# 证据\n\n- 甲组招募10人。 [证据](#^pa)\n\n无关背景。\n\n- 乙组招募20人。 [证据](#^pb)'
  const result = excerpts({ library: '库', path: 'page.md', title: '招募', content }, ['招募'], 1000)[0]!
  expect(result.segments).toHaveLength(2)
  expect(result.segments!.map(s => result.content.slice(s.start, s.end))).toEqual([
    '- 甲组招募10人。 [证据](#^pa)', '- 乙组招募20人。 [证据](#^pb)',
  ])
  expect(result.segments!.map(s => [s.anchor, s.locator, s.truncated])).toEqual([['^pa', 'L3-L3', false], ['^pb', 'L7-L7', false]])
})

it('窗口裁去未核实前缀仍携带原段状态，不把完整句误当完整条件', () => {
  const link = '[来源甲](source.md)', answer = '关键条件为完成登记。'
  const content = '- 【未核实】' + '背景说明。'.repeat(20) + answer + '适用范围仅限试点。'.repeat(20) + ' ' + link
  const result = excerpts({ library: '库', path: 'page.md', title: '条件', content }, ['关键条件'], tokenCost(answer + ' ' + link))[0]!
  expect(result.content).toBe(answer + ' ' + link)
  expect(result.segments).toEqual([expect.objectContaining({ start: 0, end: result.content.length, truncated: true, unverified: true })])
  expect(answerGuidance).toContain('先回答有据部分')
  expect(answerGuidance).toContain('不借用相邻段落')
})

it('离线逐句对照计算五项指标和逐题变化，去掉外推而保留完整事实', () => {
  const bad = '所以所有地区必然有效。', beforeRecord = { ...record, answer: text + '\n' + bad }
  const beforeReview = { ...review, answerHash: answerHash(beforeRecord.answer), sentences: [...review.sentences,
    { text: bad, supported: false, facts: [], sources: [], basis: '原文仅陈述试点招募人数，没有地区推广和效果结论。' }] }
  const before = scoreAnswers([question], [beforeRecord], [beforeReview]), after = scoreAnswers([question], [record], [review])
  expect(before.overall.unsupported).toBe(1)
  expect(after.overall).toEqual({ total: 1, reviewed: 1, unsupported: 0, complete: 1, sourceRecall: 1, coverageHits: 1, refusalRate: 0 })
  expect(compareAnswers(before, after)).toMatchObject({ passed: true, changes: [{ id: '条件' }] })
})

it('历史检索没有回答时指标为未知，缺题或错绑标注不能冒充通过', () => {
  const historical = scoreAnswers([question], [{ ...record, answer: null, refused: null }], [])
  expect(historical.overall.unsupported).toBeNull()
  expect(historical.overall.refusalRate).toBeNull()
  expect(compareAnswers(historical, historical).passed).toBe(false)
  expect(() => scoreAnswers([question], [], [])).toThrow('完整覆盖')
  expect(scoreAnswers([question], [{ ...record, answer: text + '额外结论' }], [review]).overall.unsupported).toBeNull()
})

it('拒答、事实损失与来源漏召回在总体及锁定集中均不能通过门槛', () => {
  const before = scoreAnswers([question], [record], [review])
  const refusal = '本次证据不足。'
  const after = scoreAnswers([question], [{ ...record, answer: refusal, refused: true, retrievedSources: [] }],
    [{ ...review, answerHash: answerHash(refusal), sentences: [{ text: refusal, supported: true, facts: [], sources: [], basis: '固定拒答桩。' }] }])
  const result = compareAnswers(before, after)
  expect(result.passed).toBe(false)
  expect(result.failures).toEqual(expect.arrayContaining(['全部：complete 下降', '全部：sourceRecall 下降', '全部：coverageHits 下降', '全部：拒答率上升', '锁定：拒答率上升']))
})
