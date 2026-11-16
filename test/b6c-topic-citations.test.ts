import { expect, it } from 'vitest'
import { topicSentences } from '../src/layered/topic-review.js'
import { topicClaimText } from '../src/layered/topic-metadata.js'

it.each(['【P1】【P2】【P3】【P4】', 'P4、P5', 'P4；P5；P6；P8；P11；P12', '【T-0578-02-02】'])('现场后缀%s附着前句，清理后保留真实链接', suffix => {
  const link = '[S-0001](../sources/S-0001.md#^p1)', text = '- 已核实的事实。' + suffix + ' ' + link
  expect(topicSentences(text).map(sentence => sentence.text)).toEqual([text])
  expect(topicClaimText(text)).toBe('- 已核实的事实。 ' + link)
})

it('有实际语义的编号释义和数值不按引用后缀删除', () => {
  const text = 'P4 表示第四轮研究。研究（P4 组）纳入 5 人。'
  expect(topicClaimText(text)).toBe(text)
  expect(topicSentences(text)).toHaveLength(2)
})
