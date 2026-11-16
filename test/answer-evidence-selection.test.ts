import { expect, it } from 'vitest'
import { selectAnswerEvidence } from '../src/wiki/answer-evidence.js'
import { signature } from '../src/storage/files.js'
import { evidenceHit } from './answer-evidence-fixture.js'

it('单页多摘录不能吞掉其他页面的实质证据，同页仍可回填', () => {
  const hits = [evidenceHit('terms/TM-0001.md', Array.from({ length: 8 }, (_, i) => `访谈编码第${i}项由甲研究开展。`)),
    evidenceHit('sources/S-0002.md', ['访谈编码由乙研究独立开展。']), evidenceHit('sources/S-0003.md', ['访谈编码使用丙研究的工具。'])]
  const selected = selectAnswerEvidence('访谈编码', hits, 'v000001', { budget: 6000, limit: 8 })
  expect(selected).toHaveLength(8)
  expect(new Set(selected.map(item => item.path))).toEqual(new Set(hits.map(hit => hit.path)))
  expect(selected.filter(item => item.path === hits[0]!.path).length).toBeGreaterThan(1)
})

it('第十个候选也按问题相关性参与选择', () => {
  const hits = Array.from({ length: 9 }, (_, i) => evidenceHit(`topics/T-${i}.md`, ['参与者描述日常生活。']))
  hits.push(evidenceHit('sources/S-0010.md', ['研究采用解释现象学分析，访谈样本为10人。']))
  hits[9]!.excerpts = []
  const selected = selectAnswerEvidence('研究采用什么分析方法，访谈样本多少人？', hits, 'v000001', { budget: 4000, limit: 3 })
  expect(selected.some(item => item.path === 'sources/S-0010.md')).toBe(true)
  expect(selected.length).toBeLessThanOrEqual(3)
})

it('零相关新页和结构段不能挤掉同页高相关事实，旧版本不入选', () => {
  const relevant = evidenceHit('sources/S-0001.md', ['编码由两位分析人员独立进行。', '编码分歧通过讨论解决。'])
  const old = { ...evidenceHit('sources/S-0003.md', ['编码分歧通过自动算法解决。']), version: 'v000000' }
  const hits = [relevant, evidenceHit('terms/TM-0001.md', ['别称：无', '未提供依据。']), evidenceHit('topics/T-0002.md', ['天文观测采用大型望远镜。']), old]
  const selected = selectAnswerEvidence('编码分歧', hits, 'v000001', { budget: 4000, limit: 3 })
  expect(selected).toHaveLength(2)
  expect(selected.every(item => item.path === relevant.path)).toBe(true)
})

it('预算不足时只选完整句及其真实引用，并保持字节和定位边界', () => {
  const suffix = '[S-0001@sha256:test#L8-L8](../sources/S-0001.md#^p8)', text = `编码分歧由双方讨论解决。${'补充条件须在研究现场核对。'.repeat(8)} ${suffix}`
  const hit = evidenceHit('topics/T-0001.md', [text], [{ sourceId: 'S-0001', sourceVersion: 'sha256:test' }])
  const selected = selectAnswerEvidence('编码分歧', [hit], 'v000001', { budget: 120, limit: 1 })
  expect(selected).toHaveLength(1)
  const item = selected[0]!
  expect(Buffer.byteLength(item.content)).toBeLessThanOrEqual(120)
  expect(item.content).toContain('编码分歧由双方讨论解决。')
  expect(item.content).toContain(suffix)
  expect(item.content).not.toContain('补充条件')
  expect(item.hash).toBe(signature(item.content))
  expect(item.segments[0]).toMatchObject({ start: 0, end: item.content.length, truncated: true, locator: 'L1-L1' })
  expect(item.sources.map(source => source.sourceId)).toEqual(['S-0001'])
})

it('完整句和引用放不下时少返回，不能截出半句或保留被裁掉的来源', () => {
  const text = '仅当样本满足全部纳入条件且完成复核之后才能编码。[S-0001@sha256:test#L8-L8](../sources/S-0001.md#^p8)'
  const selected = selectAnswerEvidence('编码', [evidenceHit('topics/T-0001.md', [text], [{ sourceId: 'S-0001', sourceVersion: 'sha256:test' }])], 'v000001', { budget: 40, limit: 1 })
  expect(selected).toEqual([])
})
