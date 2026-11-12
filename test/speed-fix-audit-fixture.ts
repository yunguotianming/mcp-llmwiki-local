import { vi } from 'vitest'
import { hash } from '../src/layered/files.js'
import { extractSource } from '../src/layered/extraction.js'
import type { BuildLayeredOptions, Extraction, Processing } from '../src/layered/schema.js'
import type { LocalSource } from '../src/layered/snapshot.js'

// 纯提取反例只替换持久化边界；真实文件原子性另由存储用例验证。
const memory = vi.hoisted(() => ({ writes: new Map<string, any>() }))
vi.mock('../src/layered/files.js', async original => ({
  ...await original<typeof import('../src/layered/files.js')>(),
  writeJson: async (root: string, relative: string, value: unknown) => { memory.writes.set(root + '/' + relative, structuredClone(value)) },
  appendLog: async () => {},
}))
let sequence = 0
export const envelope = (points: unknown[], terms: unknown[] = []) => ({ tags: ['研究方法', '研究对象', '研究结果'], credibility: 'high', credibility_reason: '合成审查资料', points, terms })
export function makeSource(text: string): LocalSource {
  let offset = 0, line = 1
  const segments = text.split('\n\n').map(body => {
    const start = offset, first = line, length = body.split('\n').length
    offset += body.length + 2; line += length + 1
    return { start, end: start + body.length, locator: `L${first}-L${first + length - 1}`, text_hash: hash(body) }
  })
  return { path: '合成资料.md', text, bytes: Buffer.from(text), contentHash: hash(text), segments,
    metadata: { title: '合成资料', source_type: '论文', credibility: 'high', credibility_reason: '合成审查资料', source_date: '2026-11-09', source_date_basis: '原文日期' } }
}
export function partsOf(source: LocalSource) {
  return source.segments.map((segment, paragraph_id) => ({ ...segment, paragraph_id, text: source.text.slice(segment.start, segment.end) }))
}
export function point(part: ReturnType<typeof partsOf>[number], text = part.text) {
  return { paragraph_id: part.paragraph_id, text, section: '主要发现', evidence: [{ paragraph_id: part.paragraph_id, locator: part.locator, quote: part.text }] }
}
export function auditFixture(text: string) {
  const source = makeSource(text), parts = partsOf(source), root = '审查内存根-' + ++sequence
  const call = vi.fn<BuildLayeredOptions['client']['call']>(async () => JSON.stringify(envelope(parts.filter(p => !p.text.startsWith('#')).map(p => point(p)))))
  const options: BuildLayeredOptions = { knowledgeRoot: '只读合成资料', topics: { sourceChapterMinPoints: 0, sourcePackRatio: 0 },
    client: { concurrency: () => 30, info: async () => ({ provider: 'mock', id: 'audit', name: 'audit', context: { contextWindow: 131072 } }), call } }
  const processing: Processing = { tier: 50, granularity: 'custom', prompt_version: 'speed-fix-audit', model: 'mock/audit' }
  return { source, parts, root, call, options, processing,
    run: (previous?: Extraction, plan?: ReturnType<typeof partsOf>[], limit = 64000) => extractSource(root, 'S-audit', source, processing, options, limit, previous, [], undefined, plan),
    progress: () => [...memory.writes].filter(([key]) => key.startsWith(root + '/') && key.endsWith('-progress.json')).at(-1)?.[1] as Extraction }
}
