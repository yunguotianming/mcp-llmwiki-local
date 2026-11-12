import { expect, it, vi } from 'vitest'
import { hash } from '../src/layered/files.js'
import { topicEvidenceContext } from '../src/layered/topic-metadata.js'
import { reviewTopicContent, topicSentences } from '../src/layered/topic-review.js'
import { extractionReviewPrompt } from '../src/layered/review.js'
import { topicContinuationRule, topicEvidenceContextRule, topicStudyRule } from '../src/layered/quality-prompts.js'
import type { BuildLayeredOptions } from '../src/layered/schema.js'
import { fullSentenceTopicFixture, referentialTopicFixture } from './fixtures/topic-sentence-context.js'

interface ReviewRequest {
  review_stage: string
  topic_id: string
  sentences: { id: string; text: string; original_text?: string; previous_sentence?: { id: string; text: string } | null }[]
  members: { point_id: string; text: string; source_title?: string;
    evidence: { source_id: string; locator: string; quote: string; context?: string }[] }[]
  validationFeedback?: { id: string; missing: string }[]
}

function harness(respond: (input: ReviewRequest) => unknown) {
  const requests: { prompt: string; input: ReviewRequest }[] = []
  const implementation: BuildLayeredOptions['client']['call'] = async (_task, prompt, raw) => {
    const input = JSON.parse(raw) as ReviewRequest
    requests.push({ prompt, input })
    return JSON.stringify(respond(input))
  }
  const call = vi.fn(implementation)
  const options: BuildLayeredOptions = {
    knowledgeRoot: '内存',
    topics: { topicReview: true, topicReviewInputBudget: 120000, topicMaxChars: 12000 },
    client: { call, concurrency: () => 1,
      info: async () => ({ provider: 'mock', id: 'topic-test', name: '主题测试', context: { contextWindow: 131072 } }) },
  }
  return { options, requests, call }
}

function verdicts(input: ReviewRequest, rejected: ReadonlySet<string> = new Set()) {
  return { items: input.sentences.map(sentence => ({ id: sentence.id,
    ...(sentence.original_text !== undefined ? { claim_preserved: true } : {}),
    support: rejected.has(sentence.id) ? '不支撑' : '完整支撑',
    missing: rejected.has(sentence.id) ? '成员没有支撑该过度推断。' : null })) }
}

function noCorrection(input: ReviewRequest) {
  return { sentences: (input.validationFeedback ?? []).map(item => ({
    id: item.id, text: '', point_ids: [], support: '不支撑', missing: item.missing,
  })) }
}

it('L227 引文附所在完整句，跨软换行但不扩成邻句或改写原引文', () => {
  const fixture = fullSentenceTopicFixture(), evidence = fixture.point.evidence[0]!
  const before = structuredClone(evidence)
  expect(topicEvidenceContext(evidence, fixture.source)).toBe(fixture.fullSentence)
  expect(topicEvidenceContext(evidence, fixture.source)).not.toContain('Another study')
  expect(fixture.source.text.split(/\r?\n/)[226]).toContain(fixture.quote)
  expect(evidence).toEqual(before)
  expect(() => topicEvidenceContext({ ...evidence, quote: '原文没有的引文' }, fixture.source))
    .toThrow('主题成员引文不逐字匹配其来源定位。')
  expect(() => topicEvidenceContext({ ...evidence, source_version: '旧版本' }, fixture.source))
    .toThrow('主题成员证据与来源快照版本不一致。')
  const blockLocator = 'block:20261110000000-abcdefg'
  expect(topicEvidenceContext({ ...evidence, locator: blockLocator }, {
    ...fixture.source, segments: fixture.source.segments.map(segment => ({ ...segment, locator: blockLocator })),
  })).toBe(fixture.fullSentence)
})

it('删去 S3 至 S7 后重新核对 S8，不把原研究身份机械承接到 S2', async () => {
  const fixture = referentialTopicFixture(), before = structuredClone(fixture.members)
  expect(topicSentences(fixture.content).find(sentence => sentence.id === 'S8')?.text).toBe(fixture.dependentText)
  const model = harness(input => {
    if (input.review_stage !== 'topic') return noCorrection(input)
    if (input.sentences[0]?.previous_sentence) return verdicts(input, new Set(['S8']))
    return verdicts(input, fixture.rejectedIds)
  })
  const result = await reviewTopicContent('T-0003-02-01', fixture.content, fixture.members, model.options)
  // 旧流程仅核对及纠正共 2 次；本反例新增 S8 复判及纠正，精确为 4 次，不改既有测试断言。
  expect(result.calls).toBe(4)
  expect(result.failure).toBeUndefined()
  const followup = model.requests.find(request => request.input.sentences[0]?.previous_sentence)
  expect(followup?.input.sentences).toEqual([{
    id: 'S8', text: fixture.dependentText, previous_sentence: { id: 'S2', text: fixture.priorText },
  }])
  expect(JSON.stringify(followup?.input)).not.toContain('已证明治疗具有普遍因果效果')
  expect(result.content).not.toContain('该研究的随访结果')
  expect(result.content).not.toContain('研究乙（2024）的随访结果')
  expect(result.content).toContain(fixture.priorText)
  expect(result.review?.removed).toHaveLength(6)
  expect(result.review?.metadata_members).toHaveLength(2)
  expect(fixture.members).toEqual(before)
  const cached = await reviewTopicContent('T-0003-02-01', result.content, fixture.members, model.options, result.review)
  expect(cached.calls).toBe(0)
  expect(model.call).toHaveBeenCalledTimes(4)
})

it('删句承接复判得到完整支撑时保留原句，不由指代词规则直接删句或改主张', async () => {
  const fixture = referentialTopicFixture()
  const model = harness(input => input.review_stage !== 'topic' ? noCorrection(input)
    : verdicts(input, input.sentences[0]?.previous_sentence ? new Set() : fixture.rejectedIds))
  const result = await reviewTopicContent('T-0003-02-01', fixture.content, fixture.members, model.options)
  // 旧流程为 2 次；复判完整支撑只增加 1 次，精确为 3 次，无额外纠正。
  expect(result.calls).toBe(3)
  expect(result.failure).toBeUndefined()
  expect(result.content).toContain(fixture.dependentText)
  expect(result.review?.removed).toHaveLength(5)
  expect(model.requests.filter(request => request.input.sentences[0]?.previous_sentence)).toHaveLength(1)
  expect(model.requests.filter(request => request.input.review_stage === 'topic-correction')).toHaveLength(1)
})

it('承接复判的协议缺口不能当作不支撑删句，纠正仍禁止块外编号和新增链接', async () => {
  const fixture = referentialTopicFixture(), before = structuredClone(fixture.members)
  const model = harness(input => {
    if (input.review_stage === 'topic') {
      if (input.sentences[0]?.previous_sentence) return { items: [] }
      return verdicts(input, fixture.rejectedIds)
    }
    if (input.sentences[0]?.id === 'S8') return { sentences: [{
      id: 'S8', text: '- 研究乙（2024）证明新结论。[新链接](../sources/S-9999.md#^new)',
      point_ids: ['P999'], support: '完整支撑', missing: null,
    }] }
    return noCorrection(input)
  })
  const result = await reviewTopicContent('T-0003-02-01', fixture.content, fixture.members, model.options)
  expect(result.calls).toBe(4)
  expect(result.failure).toContain('核对协议缺口：')
  expect(result.content).toContain(fixture.dependentText)
  expect(result.content).not.toContain('S-9999')
  expect(result.content).not.toContain('研究乙（2024）证明新结论')
  expect(result.review?.removed).toHaveLength(5)
  expect(fixture.members).toEqual(before)
})

it('核对与纠正均传完整句上下文，原引文不变且上下文变化使主题核对缓存失效', async () => {
  const fixture = fullSentenceTopicFixture(), members = [fixture.point], before = structuredClone(members)
  const content = '# 合成家庭访谈\n范围：访谈结果。\n## 适用条件\n- 家庭在随访中给出暂定评价。 ' + fixture.link + '\n'
  const corrected = '- 家庭在随访中给出暂定评价。 ' + fixture.link
  let reviewed = false
  const model = harness(input => {
    if (input.review_stage === 'topic') {
      const rejected = reviewed ? new Set<string>() : new Set(input.sentences.filter(sentence => sentence.text.includes('暂定评价')).map(sentence => sentence.id))
      reviewed = true
      return verdicts(input, rejected)
    }
    return { sentences: (input.validationFeedback ?? []).map(item => ({
      id: item.id, text: corrected, point_ids: [input.members[0]!.point_id], support: '完整支撑', missing: null,
    })) }
  })
  const result = await reviewTopicContent('T-0053-01', content, members, model.options, undefined, false, fixture.sources)
  // 补证后实际保留的句子也须独立最终核对，原有产物与上下文断言保持。
  expect(result.calls).toBe(3)
  expect(result.failure).toBeUndefined()
  expect(result.content).toContain(corrected)
  expect(result.review?.removed).toEqual([])
  expect(model.requests.map(request => request.input.review_stage)).toEqual(['topic', 'topic-correction', 'topic'])
  for (const request of model.requests) {
    expect(request.input.members[0]!.source_title).toBe(fixture.source.title)
    expect(request.input.members[0]!.evidence).toEqual([{
      source_id: 'S-0012', locator: 'L227-L227', quote: fixture.quote, context: fixture.fullSentence,
    }])
    expect(request.prompt).toContain(topicStudyRule)
    expect(request.prompt).toContain(topicEvidenceContextRule)
    expect(request.prompt).toContain(topicContinuationRule)
  }
  expect(members).toEqual(before)
  expect(extractionReviewPrompt).not.toContain(topicStudyRule)
  expect(extractionReviewPrompt).not.toContain(topicEvidenceContextRule)
  const cached = await reviewTopicContent('T-0053-01', result.content, members, model.options, result.review, false, fixture.sources)
  expect(cached.calls).toBe(0)
  // 即使上层成员正文与引文未变，完整句中的限定条件变化也不能复用旧核对。
  const changedText = fixture.source.text.replace('after the first interviews', 'after the second interviews')
  const difference = changedText.length - fixture.source.text.length
  const changedSource = { ...fixture.source, text: changedText,
    segments: fixture.source.segments.map(segment => ({ ...segment, end: segment.end + difference,
      text_hash: hash(changedText.slice(segment.start, segment.end + difference)) })) }
  const changed = await reviewTopicContent('T-0053-01', result.content, members, model.options, result.review, false,
    new Map([['S-0012', changedSource]]))
  expect(changed.calls).toBe(1)
  expect(changed.review?.fingerprint).not.toBe(result.review?.fingerprint)
  expect(model.requests.at(-1)!.input.members[0]!.evidence[0]!.quote).toBe(fixture.quote)
  expect(model.requests.at(-1)!.input.members[0]!.evidence[0]!.context).toContain('after the second interviews')
})
