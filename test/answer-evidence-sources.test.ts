import { expect, it, vi } from 'vitest'
import { assembleAnswerEvidence } from '../src/wiki/answer-evidence.js'
import { evidenceHit, sourcePage } from './answer-evidence-fixture.js'

it('只跟随片段实际引用，补出16k之后的方法，并绑定题名及未核实状态', async () => {
  const sourceVersions = ['S-0001', 'S-0002'].map(sourceId => ({ sourceId, sourceVersion: 'sha256:test' }))
  const seed = evidenceHit('topics/T-0001.md', ['甲研究没有直接专问双重性。[S-0001@sha256:test#L87-L87](../sources/S-0001.md#^p87)'], sourceVersions)
  seed.excerpts[0]!.segments![0]!.unverified = true
  const content = '# 甲研究\n\n' + '背景说明。'.repeat(3500) + '\n\n## 方法\n\n解释现象学分析纳入10人，采用面对面半结构访谈。[S-0001@sha256:test#L23-L23]\n\n' + '结尾。'.repeat(3000)
  const page = sourcePage('S-0001', content, '甲研究的完整题名')
  const read = vi.fn(async (_path: string, maxChars: number) => ({ ...page, content: content.slice(0, maxChars), truncated: content.length > maxChars }))
  const selected = await assembleAnswerEvidence('甲研究采用什么分析方法、多少人及访谈形式？', [seed], 'v000001', { budget: 4000, limit: 3, read })
  const method = selected.find(item => item.content.includes('面对面半结构访谈'))!
  expect(method).toBeDefined()
  expect(method.unverified).toBe(true)
  expect(method.sources).toEqual([{ sourceId: 'S-0001', sourceVersion: 'sha256:test', path: 'sources/S-0001.md', title: '甲研究的完整题名' }])
  expect(method.segments[0]!.sources).toEqual(method.sources)
  expect(read.mock.calls.map(call => call[0])).toEqual(['sources/S-0001.md', 'sources/S-0001.md'])
  expect(Buffer.byteLength(selected.map(item => item.content).join(''))).toBeLessThanOrEqual(4000)
})

it('主题依赖列表不能单独触发来源补读', async () => {
  const hit = evidenceHit('topics/T-0001.md', ['编码分歧由两位研究者讨论。'], [{ sourceId: 'S-0001', sourceVersion: 'sha256:test' }])
  const read = vi.fn(async () => sourcePage('S-0001', '编码分歧已核实。'))
  const selected = await assembleAnswerEvidence('编码分歧', [hit], 'v000001', { budget: 4000, limit: 3, read })
  expect(read).not.toHaveBeenCalled()
  expect(selected[0]!.sources).toEqual([])
})

it('来源版本不符不能用同ID新版本的正文和题名替代', async () => {
  const hit = evidenceHit('topics/T-0001.md', ['编码条件见甲研究。[S-0001@sha256:test#L8-L8]'], [{ sourceId: 'S-0001', sourceVersion: 'sha256:test' }])
  const read = vi.fn(async () => ({ ...sourcePage('S-0001', '编码采用未经引用的新方法。', '新版本题名'), sourceVersions: [{ sourceId: 'S-0001', sourceVersion: 'sha256:new' }] }))
  const selected = await assembleAnswerEvidence('编码条件', [hit], 'v000001', { budget: 4000, limit: 3, read })
  expect(read).toHaveBeenCalledTimes(1)
  expect(JSON.stringify(selected)).not.toContain('新版本题名')
  expect(JSON.stringify(selected)).not.toContain('未经引用的新方法')
})

it('来源快照错误必须向上传递', async () => {
  const hit = evidenceHit('topics/T-0001.md', ['编码证据。[S-0001@sha256:test#L8-L8]'], [{ sourceId: 'S-0001', sourceVersion: 'sha256:test' }])
  await expect(assembleAnswerEvidence('编码', [hit], 'v000001', { budget: 4000, limit: 3, read: async () => { throw new Error('来源快照校验失败') } })).rejects.toThrow('来源快照校验失败')
})

it('来源补读最多八次轻读和四次深读，总读取小于128k字符', async () => {
  const hits = Array.from({ length: 10 }, (_, i) => {
    const id = 'S-' + String(i + 1).padStart(4, '0')
    return evidenceHit(`topics/T-${i}.md`, [`编码条件见来源。[${id}@sha256:test#L8-L8]`], [{ sourceId: id, sourceVersion: 'sha256:test' }])
  })
  const read = vi.fn(async (path: string, maxChars: number) => ({ ...sourcePage(path.slice(8, -3), '编码条件由团队核对。'), path, content: '编码条件由团队核对。'.repeat(Math.ceil(maxChars / 11)).slice(0, maxChars), truncated: true }))
  await assembleAnswerEvidence('编码条件', hits, 'v000001', { budget: 4000, limit: 3, read })
  expect(read.mock.calls.filter(call => call[1] === 512)).toHaveLength(8)
  expect(read.mock.calls.filter(call => call[1] === 30000)).toHaveLength(4)
  expect(read.mock.calls.reduce((sum, call) => sum + call[1], 0)).toBeLessThanOrEqual(128000)
})
