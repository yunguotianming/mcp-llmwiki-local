import { expect, it } from 'vitest'
import { auditFixture, envelope, point } from './speed-fix-audit-fixture.js'
import { coveragePurpose } from '../src/layered/longdoc.js'

it('A11 十类纯元数据中英文及大小写均不触发覆盖补提', async () => {
  const titles = ['AUTHOR INFORMATION', 'Author Contributions', 'ORCID', 'Conflicts of Interest', 'FUNDING', 'Acknowledgements', 'Publication information', 'Supplementary Materials', 'REFERENCES', 'Author Biographies',
    '作者信息', '作者贡献', '作者标识', '利益冲突', '资助', '致谢', '出版信息', '补充材料', '参考文献', '作者履历']
  const f = auditFixture(titles.map(t => '# ' + t + '\n\nAlice; https://example.org/0000').join('\n\n'))
  f.options.topics = { sourceChapterMinPoints: 1, sourcePackRatio: 0 }
  f.call.mockResolvedValue(JSON.stringify(envelope([])))
  const result = await f.run()
  expect(titles.map(t => coveragePurpose(t, 'Alice; https://example.org/0000'))).not.toContain('研究内容')
  expect(f.call).toHaveBeenCalledTimes(1); expect(result.gaps).toEqual([])
})

it('A12 编号元数据标题罗马数字和中文序号不应制造覆盖补提', async () => {
  const titles = ['IV. FUNDING', '（八）作者贡献', '9) Acknowledgments', '十、参考文献']
  const f = auditFixture(titles.map(t => '# ' + t + '\n\nAlice; https://example.org/0000').join('\n\n'))
  f.options.topics = { sourceChapterMinPoints: 1, sourcePackRatio: 0 }
  f.call.mockResolvedValue(JSON.stringify(envelope([])))
  await f.run()
  expect(f.call).toHaveBeenCalledTimes(1)
})

it('A13 元数据章中无白名单措辞的明确研究结果仍须保留', async () => {
  const f = auditFixture('# Funding\n\nThe intervention reduced mortality by 20% in 120 patients.')
  f.call.mockResolvedValue(JSON.stringify(envelope([point(f.parts[1]!)])))
  const result = await f.run()
  expect(result.segments.flatMap(s => s.points).map(p => p.text)).toEqual([f.parts[1]!.text])
})

it('A14 正文标题包含资助、利益冲突或参考文献词汇不得按前缀排除', () => {
  for (const title of ['研究资助背景下的护士角色', '资助背景下的护士角色', '利益冲突对临床决策的影响', 'References to prior experience in decision making']) {
    expect(coveragePurpose(title, '护士在资源不足的地区承担协调与培训职责。'), title).toBe('研究内容')
  }
})

it('A15 元数据章含明确研究关键词的事实保持逐字提取', async () => {
  const f = auditFixture('# 致谢\n\n研究结果显示死亡率降低20%。')
  f.call.mockResolvedValue(JSON.stringify(envelope([point(f.parts[1]!)])))
  const result = await f.run()
  expect(result.segments[1]!.points[0]!.evidence[0]!.quote).toBe(f.parts[1]!.text)
  expect(result.gaps).toEqual([])
})
