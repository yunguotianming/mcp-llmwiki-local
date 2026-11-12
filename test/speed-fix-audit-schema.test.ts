import { expect, it } from 'vitest'
import { z } from 'zod'
import { jsonProtocol, schemaExample } from '../src/llm/protocol.js'
import { wireOutput, outputSchema } from '../src/layered/extraction.js'
import { reviewOutput, extractionReviewPrompt, topicReviewPrompt } from '../src/layered/review.js'

it('A22 已带协议提示在Schema演进后必须刷新示例及校验约束', () => {
  const old = z.object({ before: z.string() }), next = z.object({ after: z.string() })
  const prompt = jsonProtocol(jsonProtocol('规则', old.toJSONSchema()), next.toJSONSchema())
  expect(next.safeParse(JSON.parse(prompt.split('合法JSON示例：\n').at(-1)!)).success).toBe(true)
})

it('A23 Schema新增模式约束后自动示例仍须通过同源校验', () => {
  const evolved = wireOutput.extend({ source_id: z.string().regex(/^S-[0-9]{4}$/) })
  expect(evolved.safeParse(schemaExample(evolved.toJSONSchema())).success).toBe(true)
})

it('A24 核对提示中原有JSON示例也须通过枚举校验，不只检查尾部新示例', () => {
  for (const prompt of [extractionReviewPrompt, topicReviewPrompt]) {
    const literal = prompt.slice(prompt.indexOf('{"items"'), prompt.indexOf(']}') + 2)
    expect(reviewOutput.safeParse(JSON.parse(literal)).success).toBe(true)
  }
})

it('同源示例覆盖提取、核对及嵌套正则，显式样例支持复杂约束', () => {
  const pattern = z.object({ code: z.string().regex(/^S-[0-9]{4}$/),
    aliases: z.array(z.string().regex(/^(?:A|B)[a-z]{2}$/)).min(2),
    explicit: z.string().regex(/^(?=.*[A-Z])(?=.*\d).{3}$/).meta({ examples: ['A1x'] }) })
  for (const schema of [wireOutput, outputSchema, reviewOutput, pattern]) {
    const json = schema.toJSONSchema(), example = schemaExample(json)
    expect(schema.safeParse(example).success).toBe(true)
    expect(z.fromJSONSchema(json).safeParse(example).success).toBe(true)
  }
})

it('协议缓存重复注入保持字节，Schema换版只替换一个尾部', () => {
  const before = z.object({ id: z.string() }).toJSONSchema(), after = z.object({ id: z.string().regex(/^S-[0-9]{4}$/) }).toJSONSchema()
  const first = jsonProtocol('规则', before)
  expect(jsonProtocol(first, before)).toBe(first)
  const next = jsonProtocol(first, after)
  expect(next.split('同源输出协议：')).toHaveLength(2)
  expect(z.fromJSONSchema(after).safeParse(JSON.parse(next.split('合法JSON示例：\n').at(-1)!)).success).toBe(true)
  Object.assign(before, after)
  expect(jsonProtocol(first, before)).toBe(next)
})
