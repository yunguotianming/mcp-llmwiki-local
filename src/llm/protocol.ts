import { z } from 'zod'
import { normalizeModelFields } from './json.js'

// 说明缺失与实质内容无效分开处理，禁止用占位事实填补依据。
export const nullableExplanation = z.preprocess(value => typeof value === 'string' ? value.trim() || null : value, z.string().min(1).nullable())
export const explanationRule = '无依据时填 null，不要编造。'
type JsonSchema = Record<string, any>
const schemaCache = new WeakMap<object, unknown>()
const runtimeSchemaCache = new WeakMap<object, JsonSchema>()
const runtimeSourceVersions = new WeakMap<object, string>()
const runtimeOrigins = new WeakMap<JsonSchema, JsonSchema>()
const runtimeValidators = new WeakMap<JsonSchema, (value: unknown) => boolean>()
const runtimeSchemaNames = new Map<JsonSchema, Set<string>>()
let nextSchemaId = 1

// Codex/OpenAI 严格结构化输出只接受固定对象键、必填字段和基础类型。
// 内部 Zod Schema 仍保留完整约束；运行时版本只负责协议兼容，业务校验继续由 Zod 完成。
const runtimeKeywords = new Set(['type', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'anyOf', '$ref', '$defs'])
function hasNull(schema: JsonSchema): boolean {
  return schema.type === 'null' || (Array.isArray(schema.anyOf) && schema.anyOf.some((item: JsonSchema) => hasNull(item)))
    || (Array.isArray(schema.oneOf) && schema.oneOf.some((item: JsonSchema) => hasNull(item)))
}
function nullable(schema: JsonSchema): JsonSchema {
  return hasNull(schema) ? schema : { anyOf: [schema, { type: 'null' }] }
}
function strictNode(value: unknown, root: JsonSchema): JsonSchema {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value as JsonSchema
  const node = value as JsonSchema
  if (node.$ref) return { $ref: node.$ref }
  if (Array.isArray(node.anyOf) || Array.isArray(node.oneOf)) {
    return { anyOf: (node.anyOf ?? node.oneOf).map((item: unknown) => strictNode(item, root)) }
  }
  if (node.type === 'object' || node.properties) {
    const properties = Object.fromEntries(Object.entries(node.properties ?? {}).map(([key, child]) => {
      const transformed = strictNode(child, root)
      return [key, node.required?.includes(key) ? transformed : nullable(transformed)]
    }))
    return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }
  }
  if (node.type === 'array' || node.items) return { type: 'array', items: strictNode(node.items ?? {}, root) }
  const result: JsonSchema = {}
  for (const key of runtimeKeywords) if (node[key] !== undefined && key !== 'properties' && key !== 'required' && key !== 'additionalProperties' && key !== 'items') result[key] = node[key]
  if (node.const !== undefined) result.enum = [node.const]
  return result
}

export function strictSchema(schema: unknown): JsonSchema {
  if (!schema || typeof schema !== 'object') throw new Error('结构化输出 Schema 必须是对象。')
  if (runtimeOrigins.has(schema as JsonSchema)) return schema as JsonSchema
  const source = schema as JsonSchema
  const version = JSON.stringify(source)
  const cached = runtimeSchemaCache.get(schema as object)
  if (cached && runtimeSourceVersions.get(schema as object) === version) return cached
  if (cached) runtimeSchemaNames.delete(cached)
  const result = strictNode(source, source)
  if (source.$defs) result.$defs = Object.fromEntries(Object.entries(source.$defs).map(([key, value]) => [key, strictNode(value, source)]))
  runtimeSchemaCache.set(schema as object, result); runtimeSourceVersions.set(schema as object, version); runtimeOrigins.set(result, source)
  runtimeSchemaNames.set(result, new Set(['schema-' + nextSchemaId++]))
  if (typeof (schema as { safeParse?: unknown }).safeParse === 'function') {
    runtimeValidators.set(result, value => (schema as { safeParse(value: unknown): { success: boolean } }).safeParse(value).success)
  }
  return result
}

export function registerStructuredSchema(name: string, schema: unknown): JsonSchema {
  const runtime = strictSchema(schema)
  runtimeSchemaNames.get(runtime)!.add(name)
  return runtime
}
export function runtimeSchemaRegistry(): readonly { id: string; names: string[]; schema: JsonSchema; internalSchema: JsonSchema; validate?: (value: unknown) => boolean }[] {
  return [...runtimeSchemaNames].map(([schema, names]) => ({ id: [...names][0]!, names: [...names].filter(name => !/^schema-\d+$/.test(name)), schema, internalSchema: runtimeOrigins.get(schema)!,
    ...(runtimeValidators.has(schema) ? { validate: value => runtimeValidators.get(schema)!(normalizeModelFields(value, runtimeOrigins.get(schema))) } : {}) }))
}

// 同一校验器的 Schema 只生成一次，章节和来源并发时共用只读协议。
export function schemaJSON(schema: { toJSONSchema(): unknown; safeParse?: (value: unknown) => { success: boolean } }, name?: string): unknown {
  let result = schemaCache.get(schema)
  if (!result) { result = schema.toJSONSchema(); schemaCache.set(schema, result)
    if (schema.safeParse) runtimeValidators.set(strictSchema(result), value => schema.safeParse!(value).success) }
  if (name) registerStructuredSchema(name, result)
  return result
}
const marker = '\n\n同源输出协议：\n'
const protocolCache = new WeakMap<object, { version: string; tail: string }>()

// 常用正则按语法生成样例；复杂断言须在 Schema.examples 显式给出，不能静默输出非法占位符。
function patternExample(pattern: string): string {
  let index = 0
  const expression = (): string => {
    const branches: string[] = ['']
    while (index < pattern.length && pattern[index] !== ')') {
      const char = pattern[index++]!
      if (char === '|') { branches.push(''); continue }
      if (char === '^' || char === '$') continue
      let value = char
      if (char === '(') {
        if (pattern.slice(index, index + 2) === '?:') index += 2
        else if (pattern[index] === '?') throw new Error('含正则断言的字段需要显式 examples：' + pattern)
        value = expression(); index++
      } else if (char === '[') {
        const start = index - 1
        while (index < pattern.length && pattern[index] !== ']') { if (pattern[index] === '\\') index++; index++ }
        const group = pattern.slice(start, ++index), matcher = new RegExp('^' + group + '$', 'u')
        value = ['0', 'a', 'A', 'x', '中', ' ', ...group.slice(1, -1)].find(candidate => matcher.test(candidate)) ?? ''
      } else if (char === '\\') {
        const escaped = pattern[index++]!
        value = ({ d: '0', D: 'a', w: 'a', W: '-', s: ' ', S: 'x', n: '\n', t: '\t', r: '\r' } as Record<string, string>)[escaped] ?? escaped
      } else if (char === '.') value = 'x'
      const quantifier = /^(?:\{(\d+)(?:,\d*)?\}|[?*+])/.exec(pattern.slice(index))
      if (quantifier) {
        index += quantifier[0].length
        value = value.repeat(quantifier[1] === undefined ? quantifier[0] === '+' ? 1 : 0 : Number(quantifier[1]))
        if (pattern[index] === '?') index++
      }
      branches[branches.length - 1] += value
    }
    return branches[0]!
  }
  return expression()
}

// 示例遍历同一份 Schema；包含可选字段，避免模型把未展示字段误认为不存在。
function completeExample(schema: JsonSchema, preferred: unknown, root: JsonSchema): unknown {
  if (schema.type === 'object') {
    const source = preferred && typeof preferred === 'object' && !Array.isArray(preferred) ? preferred as Record<string, unknown> : {}
    return Object.fromEntries(Object.entries(schema.properties ?? {}).map(([key, child]) => [key,
      Object.hasOwn(source, key) ? completeExample(child as JsonSchema, source[key], root) : nullableBranch(child as JsonSchema) ? null : schemaExample(child, root)]))
  }
  if (schema.type === 'array' && Array.isArray(preferred)) return preferred.map(item => completeExample(schema.items, item, root))
  const choices = schema.anyOf ?? schema.oneOf
  if (choices) {
    const nonNull = choices.find((item: JsonSchema) => item.type !== 'null')
    return nonNull ? completeExample(nonNull, preferred, root) : null
  }
  if (schema.type === 'array') return schemaExample(schema, root)
  if (schema.type === 'object') return schemaExample(schema, root)
  return preferred === undefined ? schemaExample(schema, root) : preferred
}
function nullableBranch(schema: JsonSchema): boolean { return hasNull(schema) }
export function schemaExample(schema: unknown, root = schema): unknown {
  const node = schema as JsonSchema
  const origin = runtimeOrigins.get(node)
  if (origin) {
    const preferred = schemaExample(origin, origin)
    return completeExample(node, preferred, node)
  }
  if (node.examples?.length) return node.examples[0]
  if (node.const !== undefined) return node.const
  if (node.enum) return node.enum[0]
  if (node.$ref) {
    const target = node.$ref.slice(2).split('/').reduce((value: any, key: string) => value[key.replaceAll('~1', '/').replaceAll('~0', '~')], root)
    return schemaExample(target, root)
  }
  const choices = node.anyOf ?? node.oneOf
  if (choices) return schemaExample(choices.find((item: JsonSchema) => item.type !== 'null') ?? choices[0], root)
  if (node.type === 'object') return Object.fromEntries(Object.entries(node.properties ?? {}).map(([key, value]) => [key, schemaExample(value, root)]))
  if (node.type === 'array') return Array.from({ length: Math.min(node.maxItems ?? Infinity, Math.max(1, node.minItems ?? 0)) }, () => schemaExample(node.items, root))
  if (node.type === 'integer' || node.type === 'number') return Math.max(0, node.minimum ?? 0, node.exclusiveMinimum === undefined ? 0 : node.exclusiveMinimum + 1)
  if (node.type === 'boolean') return false
  if (node.type === 'null') return null
  let value = 'x'.repeat(Math.max(1, node.minLength ?? 1)).slice(0, node.maxLength ?? Infinity)
  if (node.pattern && !new RegExp(node.pattern).test(value)) value = patternExample(node.pattern)
  if (value.length < (node.minLength ?? 0)) value = value.padEnd(node.minLength, 'x')
  if (value.length > (node.maxLength ?? Infinity) || node.pattern && !new RegExp(node.pattern).test(value)) throw new Error('无法生成合法示例，请为字段提供 examples：' + node.pattern)
  return value
}

export function jsonProtocol(prompt: string, schema: unknown): string {
  // 提示词保留原约束；严格版仅用于支持结构化输出的运行时。
  schema = runtimeOrigins.get(schema as JsonSchema) ?? schema
  const version = JSON.stringify(schema), cached = protocolCache.get(schema as object)
  let tail = cached?.version === version ? cached.tail : undefined
  if (tail === undefined) {
    tail = marker + 'Schema(s字符串,s+非空字符串,i安全整数,?可选字段,!禁多余字段,[最少..最多]长度约束):\n'
      + schemaText(schema) + '\n合法JSON示例：\n' + JSON.stringify(schemaExample(schema))
    protocolCache.set(schema as object, { version, tail })
  }
  // 版本包含完整 Schema 和显式示例；同一内容只构建一次，允许原对象就地更新。
  const offset = prompt.indexOf(marker)
  if (offset >= 0 && prompt.startsWith(tail, offset)) return prompt
  return (offset < 0 ? prompt : prompt.slice(0, offset)) + tail
}

// 递归打印全部结构及校验约束，省去 JSON Schema 重复的 properties/type/items 键。
// 支持结构化输出的运行时使用严格版机器 Schema；提示词保留原 Schema 的全部约束。
export function schemaText(schema: unknown, root = schema): string {
  const node = schema as JsonSchema
  if (node.$ref) return schemaText(node.$ref.slice(2).split('/').reduce((value: any, key: string) => value[key.replaceAll('~1', '/').replaceAll('~0', '~')], root), root)
  if (node.const !== undefined) return JSON.stringify(node.const)
  if (node.enum) return node.enum.map((item: unknown) => JSON.stringify(item)).join('|')
  if (node.anyOf || node.oneOf) return '(' + (node.anyOf ?? node.oneOf).map((item: unknown) => schemaText(item, root)).join('|') + ')'
  const range = (min: number | undefined, max: number | undefined) => min === undefined && max === undefined ? '' : '[' + (min ?? 0) + '..' + (max ?? '∞') + ']'
  if (node.type === 'object') return '{' + Object.entries(node.properties ?? {}).map(([key, value]) => key + (node.required?.includes(key) ? '' : '?') + ':' + schemaText(value, root)).join(',') + '}' + (node.additionalProperties === false ? '!' : '')
  if (node.type === 'array') return '[' + schemaText(node.items, root) + ']' + range(node.minItems, node.maxItems)
  if (node.type === 'string') return 's' + (node.minLength === 1 && node.maxLength === undefined ? '+' : range(node.minLength, node.maxLength)) + (node.pattern ? '/' + node.pattern + '/' : '') + (node.format ? '(' + node.format + ')' : '')
  return (node.type === 'integer' ? 'i' : String(node.type)) + range(node.minimum, node.type === 'integer' && node.maximum === Number.MAX_SAFE_INTEGER ? undefined : node.maximum) + (node.exclusiveMinimum !== undefined ? '>' + node.exclusiveMinimum : '') + (node.exclusiveMaximum !== undefined ? '<' + node.exclusiveMaximum : '')
}
