import { expect, it } from 'vitest'
import { excerpts, tokenCost } from '../src/wiki/page-search.js'

const version = 'sha256:' + 'a'.repeat(64), otherVersion = 'sha256:' + 'b'.repeat(64)
const first = `S-0001@${version}#L7-L7`, second = `S-0001@${otherVersion}#L13-L13`
const point = 'S-0001:sha256:' + 'c'.repeat(64) + ':01'
const source = (content: string) => ({ library: '测试库', path: 'sources/S-0001.md', title: '资料', content })
const page = (claim: string, a: string, b: string) => source(`## 结论\n\n- ${claim} [证据](#^pa)\n\n## 证据原文\n\n- ${point}：[${first}] ${a} ^pa\n- ${point}：[${second}] ${b} ^pb`)

it('复合主张展开全部引用，各证据沿用自己的版本与定位', () => {
  const result = excerpts(page('登记须满足甲条件及乙条件。', '甲条件。', '乙条件。'), ['登记条件'], 1400)
  const content = result.map(item => item.content).join('\n')
  expect(content).toContain(`[${first}](../sources/S-0001.md#^pa)`)
  expect(content).toContain(`[${second}](../sources/S-0001.md#^pb)`)
  expect(content).toContain('登记须满足甲条件及乙条件。')
  expect(result.flatMap(item => item.segments ?? []).every(segment => !segment.truncated)).toBe(true)
})

it('明确问原文时返回真实证据，每段保留自己的行号而非首行号', () => {
  const result = excerpts(page('登记须满足甲条件及乙条件。', '甲条件须年满十八岁。', '乙条件须事先完成登记。'), ['登记条件原文定位'], 2000)
  const segments = result.flatMap(item => (item.segments ?? []).map(segment => ({ ...segment, text: item.content.slice(segment.start, segment.end) })))
  expect(segments.some(segment => segment.text.includes('甲条件须年满十八岁。') && segment.text.includes(first))).toBe(true)
  expect(segments.some(segment => segment.text.includes('乙条件须事先完成登记。') && segment.text.includes(second))).toBe(true)
  expect(segments.every(segment => !segment.truncated)).toBe(true)
  expect(result.map(item => item.content).join('\n')).not.toContain('登记须满足甲条件及乙条件。')
})

it('预算不足时保持完整证据并标明复合证据未全覆盖，继承未核实状态', () => {
  const raw = page('【未核实】材料核验需要登记及缴费。', '背景说明。'.repeat(30), '登记须提交签字材料，且不能逾期。')
  const budget = tokenCost(`- ${point}：[${second}](../sources/S-0001.md#^pb) 登记须提交签字材料，且不能逾期。`)
  const result = excerpts(raw, ['登记原文定位'], budget)
  expect(result.map(item => item.content).join('\n')).toContain('登记须提交签字材料，且不能逾期。')
  expect(result.reduce((sum, item) => sum + item.tokens, 0)).toBeLessThanOrEqual(budget)
  expect(result.flatMap(item => item.segments ?? []).every(segment => segment.truncated && segment.unverified)).toBe(true)
  expect(result.map(item => item.content).join('\n')).not.toContain('材料核验需要登记及缴费。')
})

it('无旧 point_id 的页面沿 PointMatch 多锚点保留原文绑定', () => {
  const raw = source(`- 关键结论包括登记和核验。 [证据](#^pa)\n\n## 证据原文\n\n- [${first}] 登记需要签字。 ^pa\n- [${second}] 核验需要原件。 ^pb`)
  const result = excerpts(raw, ['关键结论原文定位'], 2000, [{ anchors: ['pa', 'pb'], score: 0.9 }])
  const content = result.map(item => item.content).join('\n')
  expect(content).toContain(`登记需要签字。`)
  expect(content).toContain(`核验需要原件。`)
  expect(content).toContain(first)
  expect(content).toContain(second)
})

it('同段补齐不挤掉更相关的独立事实，保留限制条件与否定', () => {
  const a = '- 登记资格要求成年。 [证据](#^pa)', b = '- 登记资格另有材料说明。 [证据](#^pb)'
  const c = '- 登记费用须事先缴纳，不能以申请代替缴费。 [证据](#^pc)'
  const raw = source(`${a}\n${b}\n${c}\n\n## 证据原文\n\n- [${first}] 登记资格要求成年。 ^pa\n- [${first}] 登记资格另有材料说明。 ^pb\n- [${second}] 登记费用须事先缴纳，不能以申请代替缴费。 ^pc`)
  const result = excerpts(raw, ['登记资格和登记费用'], 520)
  expect(result.map(item => item.content).join('\n')).toContain('登记费用须事先缴纳，不能以申请代替缴费。')
  expect(result.flatMap(item => item.segments ?? []).every(segment => !segment.truncated)).toBe(true)
})
