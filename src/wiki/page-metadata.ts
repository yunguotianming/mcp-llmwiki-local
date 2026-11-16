import { parse } from 'yaml'

export class PageMetadataError extends Error {
  constructor(relative: string, options?: ErrorOptions) {
    super('页面元数据格式无效，请修复后读取：' + relative, options)
  }
}

/** 只分类页头格式错误；正文、快照及读取权限由原有读视图校验。 */
export function pageMetadata(raw: string, relative: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(raw)
  if (!match && /^---(?:\r?\n|$)/.test(raw)) throw new PageMetadataError(relative)
  let header: Record<string, unknown> = {}
  if (match) {
    try {
      const value: unknown = parse(match[1]!)
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('页头必须为属性对象。')
      header = value as Record<string, unknown>
    } catch (cause) { throw new PageMetadataError(relative, { cause }) }
  }
  return { header, content: match ? raw.slice(match[0].length) : raw }
}
