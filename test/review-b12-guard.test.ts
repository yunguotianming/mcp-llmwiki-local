import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { preservesClaimFacts } from '../src/layered/corrections.js'
import { reviewTopicContent } from '../src/layered/topic-review.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'
import { point, reviewFixture } from './quality-fix2-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
beforeEach(() => vi.stubGlobal('fetch', () => { throw new Error('离线护栏测试禁止联网') }))
afterEach(() => { cleanupLayeredFixtures(); vi.unstubAllGlobals() })
const samples = JSON.parse(readFileSync(new URL('./fixtures/topic-guard-review.json', import.meta.url), 'utf8'))
const link = '[依据](../sources/S-0001.md#p)'
const body = (text: string) => text.replace(/^[-*] /, '').replace(/\[[^\]]*\]\([^)]*\)/g, '').trim()

async function correct(originals: string[], changes: string[], verdict: { support?: string; claim_preserved?: boolean } = {}) {
  const f = reviewFixture(), members = [point('独立的证据要点。', '主要发现', 'S-0001:p')]
  f.call.mockImplementation(async (_task, _system, raw) => {
    const d = JSON.parse(raw)
    if (d.review_stage === 'topic-correction') return JSON.stringify({ sentences: d.sentences.map((s: any) => ({
      id: s.id, text: changes[originals.findIndex(text => s.text.includes(text))] + link,
      point_ids: ['P1'], support: '完整支撑', missing: null,
    })) })
    return JSON.stringify({ items: d.sentences.map((s: any) => {
      const final = typeof s.original_text === 'string'
      const support = final ? verdict.support ?? '完整支撑' : originals.some(text => s.text.includes(text)) ? '不支撑' : '完整支撑'
      return { id: s.id, support, missing: support === '完整支撑' ? null : '证据缺少对应事实',
        ...(final ? { claim_preserved: verdict.claim_preserved ?? true } : {}) }
    }) })
  })
  const result = await reviewTopicContent('T-001', '# 主题\n' + originals.map(text => text + link).join('\n'), members, f.options)
  return { ...result, requests: f.call.mock.calls.map(args => JSON.parse(args[2])) }
}

it.each(samples.examples)('B12 $id 反例拒收', async ({ id, original, corrected }: any) => {
  // C9 的开放角色改写由最终等价性核对裁决，其余显式事实变化不能被模型通过推翻。
  const result = await correct([original], [corrected], { claim_preserved: id !== 'C9' })
  expect(result.content).not.toContain(corrected)
  expect(result.review!.removed).toHaveLength(1)
})

it.each(samples.accepted)('B12 $id 真实误拦修复后收下', async ({ original, corrected }: any) => {
  const result = await correct([body(original)], [body(corrected)])
  expect(result.content).toContain(body(corrected))
  expect(result.review!.removed).toEqual([])
  expect(result.requests.filter(d => d.sentences?.some((s: any) => s.original_text))).toHaveLength(1)
})

it.each([
  ['提高降低', '研究显示，护士提高满意度。', '研究显示，护士降低满意度。'],
  ['参与使用', '研究显示，护士参与研究。', '研究显示，护士使用研究。'],
  ['支持反对', '研究显示，护士支持方案。', '研究显示，护士反对方案。'],
  ['模态增强', '研究显示，干预可能改善睡眠。', '研究显示，干预一定改善睡眠。'],
  ['义务改许可', '研究显示，患者须签署同意书。', '研究显示，患者可签署同意书。'],
])('B12 %s硬拒收不被最终通过覆盖', async (_name, original, corrected) => {
  const result = await correct([original!], [corrected!])
  expect(result.content).not.toContain(corrected)
  expect(result.requests.some(d => d.sentences?.some((s: any) => s.original_text))).toBe(false)
  expect(result.review!.removed.join('')).toContain('改变原主张')
})

it.each([
  ['缩写复数', '研究显示，CRN负责协调。', '研究表明，CRNs负责协调。'],
  ['不一定', '研究显示，结论不一定代表机构观点。', '研究表明，结论未必代表机构观点。'],
  ['一无所知', '研究显示，参与者对流程一无所知。', '研究表明，参与者对流程毫不了解。'],
  ['非临床', '研究显示，非临床人员参与研究。', '研究表明，非临床人员参与研究。'],
  ['独立否定分句', '研究显示，护士采用访谈；研究未提供经费信息。', '研究显示，护士采用访谈。'],
])('B12 %s不作机械误拦', async (_name, original, corrected) => {
  const result = await correct([original!], [corrected!])
  expect(result.content).toContain(corrected)
  expect(result.review!.removed).toEqual([])
})

it.each([
  ['改变原主张', { claim_preserved: false }],
  ['证据不完整', { support: '部分支撑' }],
])('B12 最终核对%s记不同缺口', async (reason, verdict) => {
  const result = await correct(['研究显示，护士负责访谈。'], ['研究表明，护士负责访谈。'], verdict as any)
  expect(result.content).not.toContain('研究表明')
  expect(result.review!.removed.join('')).toContain(reason)
  expect((result.review as any).reasons).toEqual([expect.objectContaining({ reason })])
})

it('B12 同主题多条改句一次批量核对且携带原句和所引要点', async () => {
  const originals = ['研究显示，护士负责访谈。', '研究显示，护士负责录音。']
  const changes = originals.map(text => text.replace('显示', '表明'))
  const result = await correct(originals, changes)
  changes.forEach(text => expect(result.content).toContain(text))
  const finals = result.requests.filter(d => d.sentences?.some((s: any) => s.original_text))
  expect(finals).toHaveLength(1)
  expect(finals[0].sentences).toHaveLength(2)
  expect(finals[0].sentences.map((s: any) => s.original_text)).toEqual(originals.map(text => text + link))
  expect(finals[0].sentences.every((s: any) => s.point_ids.join() === 'P1')).toBe(true)
})

it.each([
  ['条件', '经伦理批准后，数据可申请。', '数据可申请。'],
  ['例外', '除急诊患者外，患者均须登记。', '患者均须登记。'],
  ['时间', '随访期间，患者接受检查。', '患者接受检查。'],
  ['比较基准', '与对照组相比，结果提高。', '结果提高。'],
  ['对象限定', '研究向回复邀请且符合条件的护士发出邀请。', '研究向符合条件的护士发出邀请。'],
])('B12 删除%s硬拒收', (_name, original, corrected) => {
  expect(preservesClaimFacts(original!, corrected!)).toBe(false)
})

it('B12 来源标题按来源身份绑定，标题词不作事实锚点且不同来源不可互换', () => {
  const sources = [{ source_id: 'S-0001', source_title: 'Many Nurses Improve Outcomes' }, { source_id: 'S-0002', source_title: 'Other Study' }]
  expect(preservesClaimFacts('《Many Nurses Improve Outcomes》报告，CRN负责访谈。', 'S-0001报告，CRNs负责访谈。', sources)).toBe(true)
  expect(preservesClaimFacts('《Many Nurses Improve Outcomes》报告，CRN负责访谈。', '《Other Study》报告，CRN负责访谈。', sources)).toBe(false)
})

it('B12 主语换说法未获最终等价性确认仍拒收', async () => {
  const sample = samples.accepted[0]
  const result = await correct([body(sample.original)], [body(sample.corrected)], { claim_preserved: false })
  expect(result.requests.some(d => d.sentences?.some((s: any) => s.original_text))).toBe(true)
  expect(result.content).not.toContain(body(sample.corrected))
  expect(result.review!.removed.join('')).toContain('改变原主张')
})

it('B12 参与者称谓不被当成参与谓词，最终核对保留身份判断', () => {
  expect(preservesClaimFacts('她后来参加GCP课程。', '该参与者后来参加GCP课程。')).toBe(true)
})

it('B12 分块纠正后合并候选批量终核，任一块主张变化不能被合并通过推翻', async () => {
  const f = reviewFixture(), requests: any[] = []
  const members = Array.from({ length: 3 }, (_, i) => ({ ...point('成员资料。'.repeat(300), '主要发现', 'S-0001:p' + i),
    evidence: [{ source_id: 'S-0001', source_version: 'v1', locator: 'L1-L1', quote: '原始引文。'.repeat(300) }] }))
  f.options.topics = { topicReviewInputBudget: 17000 }
  f.call.mockImplementation(async (_task, system, raw) => {
    const d = JSON.parse(raw); requests.push(d)
    expect(Buffer.byteLength(system + raw)).toBeLessThanOrEqual(17000)
    const final = d.sentences.some((s: any) => s.original_text !== undefined)
    if (d.review_stage === 'topic-correction') return JSON.stringify({ sentences: d.sentences.filter((s: any) =>
      d.members.some((m: any) => m.point_id === (s.text.includes('访谈') ? 'P1' : 'P2'))).map((s: any) => ({
      id: s.id, text: s.text.replace('显示', '表明'), point_ids: [s.text.includes('访谈') ? 'P1' : 'P2'], support: '完整支撑', missing: null,
    })) })
    return JSON.stringify({ items: d.sentences.map((s: any) => ({ id: s.id,
      support: final || s.text.startsWith('#') ? '完整支撑' : '不支撑', missing: final || s.text.startsWith('#') ? null : '待纠正',
      ...(d.review_stage === 'topic-block' ? { findings: '当前块引文的完整判断。', point_ids: d.members.map((m: any) => m.point_id) } : {}),
      ...(final ? { claim_preserved: d.review_stage !== 'topic-block' } : {}),
    })) })
  })
  const result = await reviewTopicContent('T-002', '# 主题\n研究显示，护士负责访谈。' + link + '\n研究显示，护士负责录音。' + link, members, f.options)
  expect(requests.filter(d => d.review_stage === 'topic-correction').length).toBeGreaterThan(1)
  expect(requests.some(d => d.review_stage === 'topic-block' && d.sentences.some((s: any) => s.original_text))).toBe(true)
  expect(result.content).not.toContain('研究表明')
  expect(result.review!.removed.join('')).toContain('改变原主张')
})

it('B12 最终核对缺少主张字段时拒收，不能借未引用成员补证', async () => {
  const f = reviewFixture(), requests: any[] = []
  const members = [point('已引成员。', '主要发现', 'S-0001:p'), point('未引成员。', '主要发现', 'S-0002:p')]
  f.call.mockImplementation(async (_task, _system, raw) => {
    const d = JSON.parse(raw); requests.push(d)
    if (d.review_stage === 'topic-correction') return JSON.stringify({ sentences: d.sentences.map((s: any) => ({ id: s.id,
      text: s.text.replace('显示', '表明'), point_ids: ['P1'], support: '完整支撑', missing: null })) })
    const final = d.sentences.some((s: any) => s.original_text !== undefined)
    return JSON.stringify({ items: d.sentences.map((s: any) => ({ id: s.id, support: final || s.text.startsWith('#') ? '完整支撑' : '不支撑',
      missing: final || s.text.startsWith('#') ? null : '待纠正' })) })
  })
  const result = await reviewTopicContent('T-003', '# 主题\n研究显示，护士负责访谈。' + link, members, f.options)
  const final = requests.find(d => d.sentences.some((s: any) => s.original_text !== undefined))
  expect(final.members.map((m: any) => m.point_id)).toEqual(['P1'])
  expect(result.content).not.toContain('研究表明')
  expect(result.review!.removed.join('')).toContain('证据不完整')
})
