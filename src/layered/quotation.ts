// 比较时消除排版差异；偏移始终指向原文，页面保留原始字词与排版。
function comparable(text: string) {
  let value = '', offsets: { start: number; end: number }[] = []
  let offset = 0
  const characters = /\p{M}/u.test(text) ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)].map(item => item.segment) : text
  for (const character of characters) {
    // 只对全半角和空白使用兼容归一化，保护上下标及单位符号，避免 ²→2、₃→3、㎎→mg。
    const normalized = character.replace(/[\uFF00-\uFFEF\s]+/gu, value => value.normalize('NFKC')).normalize('NFC')
    value += normalized
    for (let index = 0; index < normalized.length; index++) offsets.push({ start: offset, end: offset + character.length })
    offset += character.length
  }
  const replace = (pattern: RegExp, replacement: (match: RegExpExecArray) => { text: string; indices?: number[] }) => {
    let next = '', positions: typeof offsets = [], previous = 0
    for (const match of value.matchAll(pattern)) {
      const start = match.index!, result = replacement(match)
      next += value.slice(previous, start) + result.text
      for (let index = previous; index < start; index++) positions.push(offsets[index]!)
      for (let index = 0; index < result.text.length; index++) positions.push(result.indices
        ? offsets[start + result.indices[index]!]! : { start: offsets[start]!.start, end: offsets[start + match[0].length - 1]!.end })
      previous = start + match[0].length
    }
    next += value.slice(previous); for (let index = previous; index < offsets.length; index++) positions.push(offsets[index]!)
    value = next; offsets = positions
  }
  replace(/([A-Za-z])[-\u00ad][ \t]*\r?\n[ \t]*(?=[a-z])/g, match => ({ text: match[1]!, indices: [0] }))
  replace(/(?<![\w*])([*]{1,3}|_{1,3})(?=\S)([^\n]*?\S)\1(?!\w)/g, match => ({ text: match[2]!, indices: Array.from({ length: match[2]!.length }, (_, index) => match[1]!.length + index) }))
  replace(/[“”„「」『』]/g, () => ({ text: '"' }))
  replace(/[‘’‚]/g, () => ({ text: "'" }))
  replace(/[‐‑‒–—―]/g, () => ({ text: '-' }))
  replace(/\s+/g, () => ({ text: ' ' }))
  return { value, offsets }
}

export function normalizeQuotation(text: string): string { return comparable(text).value.trim() }

export function matchQuotation(text: string, quote: string): { start: number; end: number; quote: string } | undefined {
  const exact = quote.trim() ? text.indexOf(quote) : -1
  if (exact >= 0) return { start: exact, end: exact + quote.length, quote }
  if (quote.trim() && quote.includes('\n')) {
    // 先仅兼容 CRLF/LF，避免粗体内部截取的引文被后续成对标记归一化误判。
    const pattern = quote.split(/\r?\n/).map(line => line.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\r?\\n')
    const match = new RegExp(pattern).exec(text)
    if (match) return { start: match.index, end: match.index + match[0].length, quote: match[0] }
  }
  const needle = normalizeQuotation(quote)
  if (!needle) return undefined
  const normalized = comparable(text), index = normalized.value.indexOf(needle)
  if (index < 0) return undefined
  const start = normalized.offsets[index]!.start, end = normalized.offsets[index + needle.length - 1]!.end
  return { start, end, quote: text.slice(start, end) }
}
