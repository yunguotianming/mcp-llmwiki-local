import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { vi } from 'vitest'
import { layeredFixture } from './layered-fixture.js'
import { readLocalSource } from '../src/layered/snapshot.js'
import { extractSource } from '../src/layered/extraction.js'
import { hash } from '../src/layered/files.js'
import type { BuildLayeredOptions, Extraction, Point, Processing } from '../src/layered/schema.js'

export const processing: Processing = { tier: 50, granularity: 'standard', model: 'mock/extractor', prompt_version: 'audit' }
export function output(input: any) {
  if (input.label_stage) return { items: input.points.map((point: any) => ({ point_id: point.point_id, labels: ['研究方法'], keywords: ['研究对象'] })) }
  if (input.review_stage === 'extraction' || input.review_stage === 'topic') return { items: (input.points ?? input.sentences).map((p: any) => ({ id: p.id, support: '完整支撑', missing: '' })) }
  if (input.new_tags) return { groups: [] }
  if (input.summary_id) return { point_ids: input.children.flatMap((c: any) => c.points.map((p: any) => p.point_id)).slice(0, input.point_limit) }
  return { tags: ['审查'], credibility: 'low', credibility_reason: '模拟资料', terms: [], points: input.paragraphs.filter((p: any) => !/^#/.test(p.text)).slice(0, input.point_limit).map((p: any) => ({ paragraph_id: p.paragraph_id, text: p.text, section: '主要发现', evidence: [{ locator: p.locator, quote: p.text }] })) }
}
export async function extractionFixture(text: string, settings: any = {}, tier = 50) {
  const f = await layeredFixture()
  const file = path.join(f.knowledgeRoot, 'a.md')
  await writeFile(file, text)
  const source = await readLocalSource(file, '资料')
  f.options.topics = settings; f.options.tier = tier
  f.call.mockImplementation(async (_task, _system, input) => JSON.stringify(output(JSON.parse(input))))
  const run = (previous?: Extraction, limit = 100000) => extractSource(f.root, 'S-0001', source, { ...processing, tier }, f.options, limit, previous)
  return { ...f, source, run }
}
export function point(text = '结果提高。', section: Point['section'] = '主要发现', id = 'P1'): Point {
  return { point_id: id, text, section, text_hash: hash(text), locator: 'L4-L4', source_version: 'v1', evidence: [{ source_id: 'S-0001', source_version: 'v1', locator: 'L4-L4', quote: '结果提高。' }] }
}
export function reviewFixture(points = [point()]) {
  const text = '远处甲\n前二\n前一\n结果提高。\n后一\n后二\n远处乙'
  const segment = { locator: 'L1-L7', start: 0, end: text.length, text_hash: hash(text) }
  const metadata = { title: '测试', source_type: '资料', credibility: 'low' as const, credibility_reason: '测试', source_date: '2026-11-09', source_date_basis: '原文日期' as const }
  const source = { path: 'a.md', bytes: Buffer.from(text), text, contentHash: hash(text), metadata, segments: [segment] }
  const extraction: Extraction = { format_version: 1, source_id: 'S-0001', source_hash: source.contentHash, processing, metadata, calls: [], segments: [{ ...segment, resource_hashes: [], processing_fingerprint: '', points, terms: [] }] }
  const call = vi.fn(async (_task: any, _system: string, input: string) => JSON.stringify(output(JSON.parse(input))))
  const options: BuildLayeredOptions = { knowledgeRoot: '', tier: 50, client: { call: call as any, info: vi.fn(async () => ({ provider: 'mock', id: 'extractor', name: '核对模型', context: { contextWindow: 131072 } })) as any }, topics: {} }
  return { source, extraction, options, call }
}
