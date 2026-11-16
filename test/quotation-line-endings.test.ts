import { expect, it } from 'vitest'
import { matchQuotation } from '../src/layered/quotation.js'
import { topicEvidenceContext } from '../src/layered/topic-metadata.js'

it('CRLF 原文中从粗体内部开始的 LF 引文保留孤立结尾标记和原偏移', () => {
  const quote = '第一部分：写研究小背景。**\n记住，千万别写大空话！[P1] (a+b)?'
  const original = '前言🙂\r\n**' + quote.replaceAll('\n', '\r\n') + '\r\n后文'
  const start = original.indexOf('第一部分'), end = original.indexOf('\r\n后文')
  expect(matchQuotation(original, quote)).toEqual({ start, end, quote: original.slice(start, end) })
})

it('LF 原文接受 CRLF 引文并返回原始 LF 片段', () => {
  const original = '前言\n**剂量为5 mg。**\n面积为3 m²。\n后文'
  const quote = '剂量为5 mg。**\r\n面积为3 m²。'
  const start = original.indexOf('剂量'), end = original.indexOf('\n后文')
  expect(matchQuotation(original, quote)).toEqual({ start, end, quote: original.slice(start, end) })
})

it('换行兼容不接受实质相差一字的旧引文', () => {
  expect(matchQuotation('**效果不增加。**\r\n维持原剂量。', '效果有增加。**\n维持原剂量。')).toBeUndefined()
})

it('主题证据不能借换行兼容跨出原定位范围', () => {
  const text = '前言\r\n**研究背景。**\r\n问题有现实价值。\r\n后文'
  const version = 'sha256:' + 'a'.repeat(64)
  const source = { title: '来源', source_version: version, text, segments: [{ locator: 'L2-L3', start: text.indexOf('**'), end: text.indexOf('\r\n后文'), text_hash: version }] }
  expect(() => topicEvidenceContext({ source_id: 'S-0001', source_version: version, locator: 'L2-L2', quote: '研究背景。**\n问题有现实价值。' }, source)).toThrow('主题成员引文不逐字匹配其来源定位。')
})

it('主题证据在原定位内匹配换行后仍返回完整所属原段', () => {
  const text = '前言\r\n**研究背景。**\r\n问题有现实价值。\r\n后文'
  const version = 'sha256:' + 'a'.repeat(64), start = text.indexOf('**'), end = text.indexOf('\r\n后文')
  const source = { title: '来源', source_version: version, text, segments: [{ locator: 'L2-L3', start, end, text_hash: version }] }
  expect(topicEvidenceContext({ source_id: 'S-0001', source_version: version, locator: 'L2-L3', quote: '研究背景。**\n问题有现实价值。' }, source)).toBe(text.slice(start, end))
})
