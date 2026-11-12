import { mkdir } from 'node:fs/promises'
import { hash, writeJson } from '../src/layered/files.js'
import { pointLabelsPrompt } from '../src/layered/point-labels.js'
import { localReferences } from '../src/layered/references.js'
import type { Extraction, PendingBuild, Point, Processing, SourceEntry, SourceMetadata } from '../src/layered/schema.js'
import { layeredFixture } from './layered-fixture.js'

export interface PointLabelInput {
  label_stage: string
  source_id: string
  vocabulary: { tags: string[]; terms: { name: string; aliases: string[] }[] }
  points: { point_id: string; text: string; section: string }[]
}

export function pointLabelResponse(input: PointLabelInput): string {
  return JSON.stringify({ items: input.points.map(point => ({
    point_id: point.point_id, labels: ['合法主题'], keywords: ['研究结果'],
  })) })
}

export function pointLabelInput(sourceId: string, points: Point[]): PointLabelInput {
  const references = localReferences(points.map(point => point.point_id))
  return { label_stage: 'point-labels', source_id: sourceId, vocabulary: { tags: [], terms: [] },
    points: points.map(point => ({ point_id: references.alias(point.point_id), text: point.text, section: point.section })) }
}

export function pointLabelInputBytes(sourceId: string, points: Point[]): number {
  return Buffer.byteLength(pointLabelsPrompt + JSON.stringify(pointLabelInput(sourceId, points)))
}

// 直接构造已经完成的提取成果，避免补标回归依赖提取、主题生成或现场资料。
export async function pointLabelFixture(count = 4) {
  const fixture = await layeredFixture()
  await mkdir(fixture.root, { recursive: true })
  const sourceId = 'S-0001', sourceHash = hash('补标回归来源')
  const processing: Processing = { tier: 50, prompt_version: 'point-label-regression', prompt_hash: hash('补标回归配置') }
  const metadata: SourceMetadata = { title: '补标回归资料', source_type: 'Markdown 资料', credibility: 'low',
    credibility_reason: '合成测试资料', source_date: '2026-11-10', source_date_basis: '文件时间' }
  const points: Point[] = Array.from({ length: count }, (_, index) => {
    const text = `第 ${index + 1} 项研究方法：随机分组并保留对象与适用条件。`
    return { point_id: `${sourceId}-point-${String(index + 1).padStart(4, '0')}-${'a'.repeat(64)}`,
      text_hash: hash(text), locator: 'L1-L1', source_version: sourceHash, text, section: '主要发现',
      evidence: [{ source_id: sourceId, source_version: sourceHash, locator: 'L1-L1', quote: text }] }
  })
  const segment = { locator: 'L1-L1', text_hash: sourceHash, start: 1, end: 1 }
  const extraction: Extraction = { format_version: 1, source_id: sourceId, source_hash: sourceHash, processing, metadata, calls: [],
    segments: [{ ...segment, resource_hashes: [], processing_fingerprint: hash('补标回归分段'), points, terms: [] }] }
  const source: SourceEntry = { source_id: sourceId, origin_type: 'local', current_path: 'labels.md', previous_paths: [],
    content_hash: sourceHash, source_version: sourceHash, resource_version: [], segments: [segment], metadata,
    files: { source: 'work/point-labels-source.md', assets: [] },
    extract: { path: 'work/point-labels-extraction.json', processing, processing_fingerprint: hash('补标回归提取') },
    revocation_generation: 0, updated_at: '2026-11-10T00:00:00.000Z' }
  const pending: PendingBuild = { format_version: 2, base_version: null, version: null,
    manifest: { format_version: 2, version: null, next_source_number: 2, revocation_generation: 0, sources: [source] },
    card: { name: '补标回归库', domain: '合成资料', origin_type: 'local', source_type: 'Markdown 资料',
      default_credibility: 'unknown', source_count: 1, updated_at: source.updated_at, format_version: 2 },
    added: [], model_calls: 0, started_at: source.updated_at }
  await writeJson(fixture.root, source.extract.path, extraction)
  fixture.call.mockImplementation(async (_task, _system, input) => pointLabelResponse(JSON.parse(input) as PointLabelInput))
  return { ...fixture, points, extraction, source, pending }
}
