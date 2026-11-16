import { expect, it, vi } from 'vitest'
import { evidenceBlockIds } from '../src/layered/anchors.js'
import { checkedVerdicts, reviewOutput } from '../src/layered/review.js'
import { schemaExample, schemaJSON } from '../src/llm/protocol.js'
import { reviewTopicContent, topicSentences } from '../src/layered/topic-review.js'
import type { BuildLayeredOptions, Point } from '../src/layered/schema.js'

// L3 只保存了调用元数据；这些是协议反例，不冒充现场三次未保存的响应。
function fixture() {
  const members: Point[] = [{ point_id: 'S-0001:护理', text: '护理需要支持。', text_hash: '护理', section: '主要发现',
    locator: 'L1-L1', source_version: 'v1', evidence: [{ source_id: 'S-0001', source_version: 'v1', locator: 'L1-L1', quote: '护理需要支持。' }] }]
  const link = '[证据](../sources/S-0001.md#^' + evidenceBlockIds(members).get(members[0]!.point_id)![0] + ')'
  const body = '- 护理需要支持。 ' + link
  const content = '# 护理支持\n范围：护理支持。\n## 适用条件\n' + body
  const requests: { prompt: string; input: any }[] = []
  const call = vi.fn<BuildLayeredOptions['client']['call']>(async (_task, prompt, raw) => {
    const input = JSON.parse(raw)
    requests.push({ prompt, input })
    return JSON.stringify(input.review_stage === 'topic-correction' ? { sentences: [] } : supported(input))
  })
  const options: BuildLayeredOptions = { knowledgeRoot: '内存', topics: { topicReview: true, topicReviewInputBudget: 120000 }, client: {
    call, concurrency: () => 1, info: async () => ({ provider: '离线', id: '主题协议', name: '主题协议桩', context: { contextWindow: 131072 } }),
  } }
  return { members, link, body, content, requests, call, options }
}

function supported(input: any) {
  return { items: input.sentences.map((sentence: any) => ({ id: sentence.id, support: '完整支撑', missing: null,
    ...(sentence.original_text !== undefined ? { claim_preserved: true } : {}),
    ...(input.review_stage === 'topic-block' ? { findings: '引文支撑原句。', point_ids: input.members.map((member: any) => member.point_id) } : {}),
  })) }
}

function example(prompt: string) {
  return JSON.parse(prompt.split('合法JSON示例：\n')[1]!)
}

function validReviewExample(prompt: string) {
  const value = example(prompt)
  expect(value.items[0].id).toBe('S0')
  expect(checkedVerdicts(JSON.stringify(value), ['S0'])).toEqual([expect.objectContaining({ support: '完整支撑', missing: '' })])
  return value
}

it('主题同源示例使用句 ID，照例返回 S0 时不会被成员编号误导', async () => {
  const f = fixture()
  f.call.mockImplementation(async (_task, prompt) => JSON.stringify(example(prompt)))
  const result = await reviewTopicContent('T-0001', '# 护理支持', f.members, f.options)
  expect(result.failure).toBeUndefined()
  expect(result.calls).toBe(1)
  validReviewExample(f.call.mock.calls[0]![1])
  expect(schemaExample(schemaJSON(reviewOutput))).toEqual({ items: [{ id: 'P1', support: '完整支撑', missing: null }] })
})

it('分块与合并核对同源示例均满足句 ID 和判定约束', async () => {
  const f = fixture()
  const members = Array.from({ length: 6 }, (_, index) => ({ ...f.members[0]!, point_id: 'S-0001:p' + index,
    text: '完整事实。'.repeat(180), evidence: [{ ...f.members[0]!.evidence[0]!, quote: '完整引文。'.repeat(180) }] }))
  f.options.topics = { topicReview: true, topicReviewInputBudget: 8500 }
  const stages = new Set<string>()
  f.call.mockImplementation(async (_task, prompt, raw) => {
    const input = JSON.parse(raw), value = validReviewExample(prompt)
    stages.add(input.review_stage)
    if (input.review_stage === 'topic-block') {
      expect(value.items[0].findings.trim()).not.toBe('')
      expect(value.items[0].point_ids).toEqual(['P1'])
    }
    return JSON.stringify(supported(input))
  })
  const result = await reviewTopicContent('T-0001', '# 护理支持', members, f.options)
  expect(result.failure).toBeUndefined()
  expect(stages).toEqual(new Set(['topic-block', 'topic-merge']))
})

it('正文纠正与最终核对示例保持判定一致，最终句仍需主张保持判定', async () => {
  const f = fixture(), stages: string[] = []
  f.call.mockImplementation(async (_task, prompt, raw) => {
    const input = JSON.parse(raw)
    stages.push(input.review_stage)
    if (input.review_stage === 'topic-correction') {
      const value = example(prompt).sentences[0]
      expect(value.id).toBe('S0')
      expect(value.support === '完整支撑' ? value.missing === null : Boolean(value.missing?.trim())).toBe(true)
      return JSON.stringify({ sentences: input.sentences.map((sentence: any) => ({ id: sentence.id, text: sentence.text,
        point_ids: sentence.point_ids, support: '完整支撑', missing: null })) })
    }
    const value = validReviewExample(prompt)
    if (input.sentences.some((sentence: any) => sentence.original_text !== undefined)) expect(value.items[0].claim_preserved).toBe(true)
    const output = supported(input)
    if (stages.length === 1) {
      output.items.find((item: any) => item.id === 'S2').support = '不支撑'
      output.items.find((item: any) => item.id === 'S2').missing = '需要补证。'
    }
    return JSON.stringify(output)
  })
  const result = await reviewTopicContent('T-0001', f.content, f.members, f.options)
  expect(result.failure).toBeUndefined()
  expect(result.content).toBe(f.content)
  expect(stages).toEqual(['topic', 'topic-correction', 'topic'])
})

it.each(['缺项', '重复', '非法判定', '判定说明矛盾'])('%s仍拒绝，协议缺口保留原句', async mode => {
  const f = fixture()
  f.call.mockImplementation(async (_task, _prompt, raw) => {
    const input = JSON.parse(raw)
    if (input.review_stage === 'topic-correction') return JSON.stringify({ sentences: [] })
    const item = { id: 'S0', support: mode === '非法判定' ? '通过' : '完整支撑', missing: mode === '判定说明矛盾' ? '缺少证据。' : null }
    return JSON.stringify({ items: mode === '缺项' ? [] : mode === '重复' ? [item, item] : [item] })
  })
  const result = await reviewTopicContent('T-0001', '# 护理支持', f.members, f.options)
  expect(result.failure).toContain('S0；核对协议缺口：')
  expect(result.content).toBe('# 护理支持')
  expect(result.review?.removed).toEqual([])
})

it('导航与成员列表拒绝时保留失败和原文，不能进入正文纠正或删句记录', async () => {
  const f = fixture()
  const content = f.content + '\n## 来源导航\n- [S-0001 护理](../sources/S-0001.md) — v1\n## 成员列表\n- 护理需要支持。 ' + f.link
  const navigation = topicSentences(content).filter(sentence => sentence.navigation), ids = new Set(navigation.map(sentence => sentence.id))
  const before = structuredClone(f.members)
  f.call.mockImplementation(async (_task, _prompt, raw) => {
    const input = JSON.parse(raw)
    f.requests.push({ prompt: _prompt, input })
    if (input.review_stage === 'topic-correction') return JSON.stringify({ sentences: [] })
    return JSON.stringify({ items: supported(input).items.map((item: any) => ids.has(item.id)
      ? { ...item, support: '不支撑', missing: '导航归属不一致。' } : item) })
  })
  const result = await reviewTopicContent('T-0001', content, f.members, f.options)
  expect(result.failure).toContain(navigation[0]!.id)
  expect(result.failure).toContain('导航')
  expect(f.requests.some(request => request.input.review_stage === 'topic-correction')).toBe(false)
  expect(result.content).toBe(content)
  expect(result.review?.removed).toEqual([])
  expect(f.members).toEqual(before)
})

it('完整合法逐句回复保留正文证据绑定、导航与别名，并复用通过的核对', async () => {
  const f = fixture(), before = structuredClone(f.members)
  const content = '---\naliases: [护理]\n---\n' + f.content + '\n## 来源导航\n- [S-0001 护理](../sources/S-0001.md) — v1'
  const result = await reviewTopicContent('T-0001', content, f.members, f.options)
  expect(result.failure).toBeUndefined()
  expect(result.content).toBe(content)
  const input = f.requests[0]!.input
  expect(input.sentences.find((sentence: any) => sentence.text === f.body).point_ids).toEqual(['P1'])
  expect(input.sentences.map((sentence: any) => sentence.id)).toEqual(['S0', 'S1', 'S2', 'S3', 'A0'])
  expect(f.requests[0]!.prompt).toContain('members.point_id')
  expect(f.requests[0]!.prompt).toContain('sentences.id')
  expect(f.members).toEqual(before)
  const cached = await reviewTopicContent('T-0001', content, f.members, f.options, result.review)
  expect(cached.calls).toBe(0)
})
