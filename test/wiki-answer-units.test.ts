import { expect, it, vi } from 'vitest'
import { parseWikiAnswer } from '../src/wiki/chat.js'
import { validatedModelOutput } from '../src/llm/client.js'

const unit = (text: string, citationIds = [1], block = 'paragraph') => ({ block, text, citationIds })
const parse = (units: unknown[], gap?: boolean) => parseWikiAnswer(JSON.stringify({ units, ...(gap === undefined ? {} : { gap }) }), 8)

it('事实标题、段落和各列表项分别绑定真实编号，连续列表保留布局且不重编号', () => {
  const result = parse([unit('试点条件', [8, 7, 8], 'heading'), unit('试点招募十人。', [7]),
    unit('参与者来自同一机构。', [7], 'listItem'), unit('访谈采用七步编码。', [3], 'listItem')])
  expect(result).toEqual({ answer: '## 试点条件 [8][7]\n\n试点招募十人。 [7]\n\n- 参与者来自同一机构。 [7]\n- 访谈采用七步编码。 [3]', citations: [8, 7, 3] })
  expect(parse(Array.from({ length: 81 }, () => unit('有据事实。'))).answer.match(/\[1\]/g)).toHaveLength(81)
})

it('严格协议拒绝缺引、越界、自带编号、自由范围通道和旧JSON', () => {
  for (const value of [unit('事实。', []), unit('事实。', [0]), unit('事实。', [9]), unit('事实。', [1.5]),
    unit('事实。[1]'), unit('事实。[7,8]'), unit('事实。［７］'), unit('事实。\\[1\\]'), unit('范围说明', [1], 'scope'),
    { ...unit('事实。'), scope: '自行补充' }]) expect(() => parse([value])).toThrow()
  expect(() => parseWikiAnswer('{"answer":"旧正文[1]","citations":[1]}', 8)).toThrow()
  expect(() => parseWikiAnswer('{"units":[],"gap":"自行补充"}', 8)).toThrow()
  expect(() => parseWikiAnswer('{"units":[],"scope":"自行补充"}', 8)).toThrow()
})

it('句界识别引号内多句并拒绝换行和列表前缀，保留缩写、小数与行内Markdown', () => {
  for (const text of ['甲。乙。', '“甲。乙。”', '`甲。乙。`', '**甲。乙。**', '作者询问“What is care?”并记录3.5分。', '甲。\n乙。', '\n甲。',
    '## 标题', '- 列表', '+ 列表', '> 引文', '1. 列表', '1.2) 列表', '1、列表', '1）列表', '（1）列表', '一、列表']) {
    expect(() => parse([unit(text)])).toThrow()
  }
  for (const text of ['**事实。**', '*事实。*', '`事实。`', 'Dr. Smith et al. report 3.5 cases.',
    '研究由 Smith et al. 提出。', '[事实](https://example.com/a.b)。']) {
    expect(parse([unit(text)]).answer).toBe(text + ' [1]')
  }
})

it('空单元固定拒答，布尔缺口只追加固定句且保留全部有据单元', () => {
  expect(parse([])).toEqual({ answer: '本次提供的证据不足，无法可靠回答这个问题。', citations: [] })
  expect(parse([], true)).toEqual(parse([]))
  expect(parse([unit('第一事实。'), unit('第二事实。')], true)).toEqual({
    answer: '第一事实。 [1]\n\n第二事实。 [1]\n\n其余问题本次提供的证据不足，无法确认。', citations: [1],
  })
  expect(parse([unit('第一事实。')], false)).toEqual(parse([unit('第一事实。')]))
})

it('旧格式只触发一次校验反馈，可纠正为新单元协议，再失败则有界报错', async () => {
  const old = '{"answer":"旧事实[1]","citations":[1]}', valid = JSON.stringify({ units: [unit('有据事实。')] })
  const call = vi.fn().mockResolvedValueOnce(old).mockResolvedValueOnce(valid)
  expect((await validatedModelOutput(call, output => parseWikiAnswer(output, 8))).value).toEqual({ answer: '有据事实。 [1]', citations: [1] })
  expect(call).toHaveBeenCalledTimes(2)
  expect(call.mock.calls[1]?.[0]).toMatchObject({ output: old, error: expect.any(String) })
  const invalid = vi.fn().mockResolvedValue(old)
  await expect(validatedModelOutput(invalid, output => parseWikiAnswer(output, 8))).rejects.toMatchObject({ name: 'ModelOutputValidationError' })
  expect(invalid).toHaveBeenCalledTimes(2)
})
