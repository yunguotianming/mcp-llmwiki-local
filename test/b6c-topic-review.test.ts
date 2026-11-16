import { expect, it, vi } from 'vitest'
import { evidenceBlockIds } from '../src/layered/anchors.js'
import { reviewTopicContent, topicSentences } from '../src/layered/topic-review.js'
import { topicClaimText } from '../src/layered/topic-metadata.js'
import type { BuildLayeredOptions, Point, TopicRepairState } from '../src/layered/schema.js'

function fixture(count = 4) {
  const members: Point[] = Array.from({ length: count }, (_, i) => {
    const id = 'S-' + String(i + 1).padStart(4, '0'), text = `研究${i + 1}报告护理需要支持。`
    return { point_id: id + ':point', text, text_hash: 'hash', section: '主要发现', locator: 'L1-L1', source_version: 'v1',
      evidence: [{ source_id: id, source_version: 'v1', locator: 'L1-L1', quote: text }] }
  })
  const anchors = evidenceBlockIds(members)
  const lines = members.map(point => `- ${point.text} [${point.point_id.split(':')[0]}](../sources/${point.point_id.split(':')[0]}.md#^${anchors.get(point.point_id)![0]})`)
  const content = ['---', 'title: 护理研究', 'aliases: []', 'sources: []', '---', '# 护理研究', '范围：护理研究。', '## 适用条件', ...lines].join('\n')
  const call = vi.fn<BuildLayeredOptions['client']['call']>(async (_task, _prompt, raw) => {
    const input = JSON.parse(raw)
    return JSON.stringify(input.review_stage === 'topic-correction' ? { sentences: [] } : {
      items: input.sentences.map((s: any) => ({ id: s.id, support: '完整支撑', missing: null, ...(s.original_text ? { claim_preserved: true } : {}) })),
    })
  })
  const options: BuildLayeredOptions = { knowledgeRoot: '内存', topics: { topicReview: true, topicReviewInputBudget: 120000 }, client: { call,
    info: async () => ({ id: '桩', provider: '离线', name: '确定性桩', context: { contextWindow: 131072 } }) } }
  return { members, content, lines, call, options }
}

it('四项现场切句输入及多编号后缀保持引用绑定与原偏移', () => {
  const link = '[S-0001](../sources/S-0001.md#^p1)'
  const inputs = ['- 研究报告护士需要支持。\\[P1\\]\\[P2\\] ' + link, '- 研究报告护士需要支持。（P1） ' + link,
    '- 研究报告护士需要支持。 ' + link, '- Wang, Y. 报告护理研究。 ' + link, '- 事实。（P1、P2） ' + link]
  for (const input of inputs) {
    const sentences = topicSentences(input)
    expect(sentences).toHaveLength(1)
    expect(input.slice(sentences[0]!.start, sentences[0]!.end)).toBe(input)
    expect(topicClaimText(input)).not.toMatch(/P[12]/)
    expect(topicClaimText(input)).toContain(link)
  }
})

it('占位范围按最终成员原话重建，并在接受前重新核对', async () => {
  const f = fixture(1)
  const result = await reviewTopicContent('T-0001', f.content.replace('护理研究。', '按成员证据阅读。'), f.members, f.options)
  expect(result.failure).toBeUndefined()
  expect(result.content).not.toContain('按成员证据阅读')
  expect(result.content).toContain('范围：' + f.members[0]!.text)
  expect(f.call.mock.calls.some(call => JSON.parse(call[2]).sentences.some((s: any) => s.text === '范围：' + f.members[0]!.text))).toBe(true)
  expect(result.content).toContain(f.lines[0])
})

it('第二轮仍缩减成员可继续收敛，最后正文与范围均有最终成员证据', async () => {
  const f = fixture(), original = f.call.getMockImplementation()!
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (input.review_stage === 'topic' && input.members.length > 1) return JSON.stringify({ items: input.sentences.map((s: any) => ({
      id: s.id, support: s.text.startsWith('- 研究' + input.members.length) ? '不支撑' : '完整支撑',
      missing: s.text.startsWith('- 研究' + input.members.length) ? '该句无据' : null,
    })) })
    return original(...args)
  })
  const result = await reviewTopicContent('T-0001', f.content, f.members, f.options)
  expect(result.failure).toBeUndefined()
  expect(result.review?.metadata_members).toEqual([f.members[0]!.point_id])
  expect(result.content).toContain(f.lines[0])
  expect(result.content).not.toMatch(/研究[234]/)
  expect(result.review?.removed).toHaveLength(3)
})

it('预算耗尽自动恢复不刷新额度，显式续跑从当前稿承接', async () => {
  const f = fixture(1), original = f.call.getMockImplementation()!
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (input.review_stage === 'topic') return JSON.stringify({ items: input.sentences.map((s: any) => ({ id: s.id,
      support: s.text.startsWith('范围：') ? '不支撑' : '完整支撑', missing: s.text.startsWith('范围：') ? '范围仍未通过' : null })) })
    return original(...args)
  })
  let state: TopicRepairState | undefined
  const save = async (value: TopicRepairState) => { state = structuredClone(value) }
  const first = await reviewTopicContent('T-0001', f.content, f.members, f.options, undefined, false, undefined, { runId: '运行一', save })
  expect(first.failure).toContain('预算耗尽')
  expect(state!.rounds).toBe(6)
  f.call.mockClear()
  const automatic = await reviewTopicContent('T-0001', f.content, f.members, f.options, undefined, false, undefined, { state, runId: '运行一', save })
  expect(automatic.failure).toContain('预算耗尽')
  expect(f.call).not.toHaveBeenCalled()
  f.call.mockImplementation(original)
  const resumed = await reviewTopicContent('T-0001', f.content, f.members, f.options, undefined, false, undefined, { state, runId: '运行二', save })
  expect(resumed.failure).toBeUndefined()
  expect(JSON.parse(f.call.mock.calls[0]![2]).sentences.some((s: any) => s.text === '范围：' + f.members[0]!.text)).toBe(true)
  expect(state!.total_rounds).toBe(7)
})

it('核对中断保留当前阶段和成员，续接不恢复已经删除的句子', async () => {
  const f = fixture(2), original = f.call.getMockImplementation()!
  let state: TopicRepairState | undefined
  f.call.mockImplementation(async (...args) => {
    const input = JSON.parse(args[2])
    if (input.review_stage === 'topic' && input.members.length === 2) return JSON.stringify({ items: input.sentences.map((s: any) => ({ id: s.id,
      support: s.text.startsWith('- 研究2') ? '不支撑' : '完整支撑', missing: s.text.startsWith('- 研究2') ? '无据' : null })) })
    if (input.review_stage === 'topic' && input.members.length === 1) throw Object.assign(new Error('中断'), { name: 'AbortError' })
    return original(...args)
  })
  const save = async (value: TopicRepairState) => { state = structuredClone(value) }
  await expect(reviewTopicContent('T-0001', f.content, f.members, f.options, undefined, false, undefined, { runId: '运行一', save })).rejects.toThrow('中断')
  expect(state!.content).not.toContain('研究2')
  expect(state!.stage).toBe('metadata')
  f.call.mockImplementation(original); f.call.mockClear()
  const result = await reviewTopicContent('T-0001', f.content, f.members, f.options, undefined, false, undefined, { state, runId: '运行二', save })
  expect(result.failure).toBeUndefined()
  expect(result.content).not.toContain('研究2')
})
