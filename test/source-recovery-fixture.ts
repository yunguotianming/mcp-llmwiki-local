import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { hash } from '../src/layered/files.js'
import { storageJson } from '../src/layered/vectors.js'
import { resultFingerprint } from '../src/layered/extraction.js'
import type { Extraction, SnapshotManifest } from '../src/layered/schema.js'
import { layeredIncrementalFixture, snapshotManifest } from './layered-fixture.js'
export async function sourceRecoveryFixture(empty = false) {
  const f = await layeredIncrementalFixture()
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组保留已接受的研究结论。\n\n甲组待补核对的研究结论。')
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '乙组保留范围外的研究结论。')
  await buildLayeredLibrary(f.options)
  const manifest = await snapshotManifest(f.root)
  for (const entry of manifest.sources) {
    const extraction: Extraction = JSON.parse(await readFile(path.join(f.root, entry.extract.path), 'utf8'))
    const [key, group] = Object.entries(extraction.group_cache!)[0]!
    group.missing_summary = true
    if (empty && entry.source_id === 'S-0001') {
      const raw = JSON.parse(group.raw)
      for (const point of raw.points) point.text = '没有被接受的旧候选'
      group.raw = JSON.stringify(raw)
    }
    extraction.gaps!.push({ kind: 'summary', segment_hashes: group.parts.map(part => part.text_hash), item: null,
      reasons: [{ rule: 'summary-support', expected: '有效摘要', actual: '测试缺口' }] })
    entry.extract.path = entry.extract.path.replace(/\.json$/, '-summary-gap.json')
    entry.extract.processing_fingerprint = resultFingerprint(extraction)
    await writeFile(path.join(f.root, entry.extract.path), JSON.stringify(extraction, null, 2) + '\n')
    expect(key).toBeTruthy()
  }
  const topic = manifest.topics!.topics[0]!
  manifest.topic_gaps = [{ topic_id: topic.id, point_ids: topic.point_ids, message: '删除未支撑句：范围外旧审计通知。' }]
  await writeFile(path.join(f.root, 'versions', manifest.version! + '.json'), JSON.stringify({ checksum: hash(storageJson(manifest)), manifest }, null, 2) + '\n')
  const originalCall = f.call.getMockImplementation()!
  const calls: any[] = []
  f.call.mockClear(); f.embed.mockClear()
  f.call.mockImplementation(async (_task, _system, input) => {
    const request = JSON.parse(input); calls.push(request)
    if (!request.summary_id) throw new Error('定向补缺不得派发其他单元')
    return JSON.stringify({ point_ids: request.children.flatMap((child: any) => child.points.map((point: any) => point.point_id)).slice(0, request.point_limit) })
  })
  const retrySources = { sourceIds: ['S-0001'], kinds: ['summary'] as ('summary' | 'review')[] }
  return { ...f, calls, manifest, retrySources, originalCall }
}

export async function sourceRecoveryExtraction(root: string, manifest: SnapshotManifest, id: string) {
  return JSON.parse(await readFile(path.join(root, manifest.sources.find(source => source.source_id === id)!.extract.path), 'utf8')) as Extraction
}
