import { beforeAll, describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { jsonProtocol, schemaJSON, schemaExample, runtimeSchemaRegistry, strictSchema } from '../src/llm/protocol.js'
import { z } from 'zod'
import { parseModelJson } from '../src/llm/json.js'
import { outputSchema } from '../src/layered/extraction.js'
import '../src/layered/review.js'
import '../src/layered/topics.js'
import '../src/layered/topic-review.js'
import '../src/layered/terms.js'
import '../src/layered/tag-merges.js'
import '../src/wiki/query-understanding.js'

const allowed = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'anyOf', '$ref', '$defs'])
// 自动发现协议模块，新增文件或漏登记名称都不能被固定 import 清单隐藏。
beforeAll(async () => {
  const root = fileURLToPath(new URL('../src/', import.meta.url))
  for (const file of readdirSync(root, { recursive: true }).filter(file => file.endsWith('.ts'))) {
    const absolute = path.join(root, file)
    if (/\b(?:schemaJSON|registerStructuredSchema)\s*\(/.test(readFileSync(absolute, 'utf8'))) await import(absolute)
  }
})
function check(node: any, path = '$', root = node): void {
  expect(node && typeof node === 'object' && !Array.isArray(node)).toBe(true)
  for (const key of Object.keys(node)) expect(allowed.has(key)).toBe(true)
  if (node.$ref) return
  if (node.$defs) for (const [name, child] of Object.entries(node.$defs)) check(child, `${path}.$defs.${name}`, root)
  for (const key of ['anyOf'] as const) if (node[key]) for (const [index, child] of node[key].entries()) check(child, `${path}.${key}[${index}]`, root)
  if (node.type === 'object') {
    expect(node.additionalProperties).toBe(false)
    expect(node.required).toEqual(Object.keys(node.properties ?? {}))
    for (const [key, child] of Object.entries(node.properties ?? {})) check(child, `${path}.${key}`, root)
  }
  if (node.type === 'array') check(node.items, `${path}.items`, root)
}

describe('运行时严格结构化输出 Schema', () => {
  it('完整提示词保留长度、正则和显式示例，严格转换不修改原 Schema', () => {
    const validator = z.object({ code: z.string().min(3).max(8).regex(/^A\d+x$/).meta({ examples: ['A12x'] }) })
    const source = schemaJSON(validator, 'constraints_fixture'), before = JSON.stringify(source)
    const strict = strictSchema(source), prompt = jsonProtocol('规则', strict)
    expect(prompt).toContain('code:s[3..8]/^A\\d+x$/')
    expect(prompt).toContain('"A12x"')
    expect(JSON.stringify(strict)).not.toMatch(/minLength|maxLength|pattern|examples/)
    expect(JSON.stringify(source)).toBe(before)
    expect(validator.safeParse(JSON.parse(prompt.split('合法JSON示例：\n').at(-1)!)).success).toBe(true)
  })
  it('遍历所有已登记运行时 Schema，逐层满足严格模式并能校验示例', () => {
    const schemas = runtimeSchemaRegistry()
    expect(schemas.length).toBeGreaterThanOrEqual(12)
    for (const item of schemas) {
      expect(item.names.length).toBeGreaterThan(0)
      check(item.schema)
      expect(item.validate?.(schemaExample(item.schema))).toBe(true)
    }
  })

  it('严格版 null 可按缺省字段进入内部校验，主张与证据规则仍由原 Schema 负责', () => {
    const value = parseModelJson(JSON.stringify({ tags: ['方法', '对象', '结果'], credibility: 'low', credibility_reason: '测试', points: [{ paragraph_id: 0, text: '主张', section: '主要发现', evidence: [{ paragraph_id: null, locator: 'L1-L1', quote: '原文。' }] }], terms: [{ referent: null, paragraph_id: 0, name: '术语', category: '概念', aliases: [], locator: 'L1-L1', note: '原义' }] }))
    expect(outputSchema.parse(value).terms[0]!.referent).toBeUndefined()
    expect(outputSchema.parse(value).points[0]!.evidence[0]).not.toHaveProperty('paragraph_id')
    const wrapped = parseModelJson(JSON.stringify(value).replace('"locator":"L1-L1"', '"paragraph_id":null,"locator":"L1-L1"') + '}')
    expect(outputSchema.parse(wrapped).points[0]!.evidence[0]).not.toHaveProperty('paragraph_id')
  })
})
