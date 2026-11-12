// 严格运行时用 null 表示可选字段缺省；完整协议明确可空的字段必须保留。
function acceptsNull(schema: any): boolean {
  return schema?.type === 'null' || (Array.isArray(schema?.type) && schema.type.includes('null'))
    || (schema?.anyOf ?? schema?.oneOf ?? []).some(acceptsNull)
}
export function normalizeModelFields(value: unknown, schema?: any, root = schema): any {
  if (schema?.$ref) schema = schema.$ref.slice(2).split('/').reduce((node: any, key: string) => node[key.replaceAll('~1', '/').replaceAll('~0', '~')], root)
  const branches = schema?.anyOf ?? schema?.oneOf
  if (branches) schema = branches.find((node: any) => node.type !== 'null') ?? schema
  if (Array.isArray(value)) return value.map(item => normalizeModelFields(item, schema?.items, root))
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(Object.entries(value).filter(([key, item]) => item !== null || schema?.required?.includes(key)
    || acceptsNull(schema?.properties?.[key]))
    .map(([key, item]) => [key, normalizeModelFields(item, schema?.properties?.[key], root)]))
}

// 只清理输出包装和完整 JSON 之后的多余闭括号；不修补主体、不选择两段 JSON 中的一段。
export function parseModelJson(raw: string, schema?: unknown): any {
  const text = raw.trim().replace(/^```(?:json)?\s*\r?\n/i, '').replace(/\r?\n?```\s*$/, '').trim()
  try { return normalizeModelFields(JSON.parse(text), schema) } catch { /* 完整主体的结束位置由字符串感知扫描确定。 */ }
  const stack: string[] = []
  let quoted = false, escaped = false
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!
    if (quoted) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') quoted = false
      continue
    }
    if (char === '"') quoted = true
    else if (char === '{' || char === '[') stack.push(char)
    else if (char === '}' || char === ']') {
      if (stack.pop() !== (char === '}' ? '{' : '[')) break
      if (!stack.length) {
        if (!/^[\s}\]]*$/.test(text.slice(index + 1))) break
        return normalizeModelFields(JSON.parse(text.slice(0, index + 1)), schema)
      }
    } else if (!stack.length && !/\s/.test(char)) break
  }
  return normalizeModelFields(JSON.parse(text), schema)
}
