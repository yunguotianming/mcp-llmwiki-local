import { afterEach, expect, it, vi } from 'vitest'
import { readFile } from 'node:fs/promises'
import { prepareTopics } from '../src/layered/topics.js'
import { publishLibrary, readExtraction, readCurrent, readManifest } from '../src/layered/publication.js'
import { restoreLegacyTopicMembers } from '../src/layered/topic-recovery.js'
import { hash, immutableWrite } from '../src/layered/files.js'
import { safePath } from '../src/storage/paths.js'
import { pendingFixture } from './pipeline-audit-fixture.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('旧缺口的历史成员同时恢复来源锚点，生成后能发布且旧提取字节不变', async () => {
  const f = await pendingFixture(), topic = f.pending.topics!.state.topics[0]!
  await publishLibrary(f.root, f.pending)
  const committed = await readManifest(f.root, await readCurrent(f.root))
  f.pending.base_version = committed.version; f.pending.version = null
  const source = f.pending.manifest.sources.find(source => source.source_id === topic.sources[0])!
  const oldPath = source.extract.path, oldBytes = await readFile(await safePath(f.root, oldPath))
  const previous = await readExtraction(f.root, oldPath), current = structuredClone(previous)
  const segment = current.segments.find(segment => segment.points.length)!, point = segment.points.shift()!
  expect(point.verification?.status).toBe('verified')
  delete current.acceptedRef; delete current.reextractGeneration; delete source.acceptedRef
  const bytes = Buffer.from(JSON.stringify(current, null, 2) + '\n')
  source.extract.path = oldPath.replace(/\.json$/, '-' + hash(bytes).slice(7) + '.json')
  await immutableWrite(f.root, source.extract.path, bytes)
  const reducedPath = source.extract.path
  delete f.pending.topics!.pages[topic.path]
  f.pending.topics!.gaps = [{ topic_id: topic.id, point_ids: [...topic.point_ids], message: 'Connection error.' }]
  f.pending.manifest.topic_gaps = f.pending.topics!.gaps
  await prepareTopics(f.root, f.pending, committed, f.options, undefined)
  expect(source.extract.path).not.toBe(reducedPath)
  expect((await readExtraction(f.root, source.extract.path)).segments.flatMap(segment => segment.points).map(point => point.point_id)).toContain(point.point_id)
  await publishLibrary(f.root, f.pending)
  expect(await readFile(await safePath(f.root, oldPath))).toEqual(oldBytes)
  expect(f.pending.topics!.pages[topic.path]?.dependencies.points.map(point => point.point_id)).toContain(point.point_id)
})

it.each(['配额', '显式重提', '来源变化'])('历史成员恢复不绕过%s边界', async boundary => {
  const f = await pendingFixture(), source = f.pending.manifest.sources[0]!
  const previous = await readExtraction(f.root, source.extract.path), current = structuredClone(previous)
  const point = current.segments.find(segment => segment.points.length)!.points.shift()!
  delete current.acceptedRef; delete current.reextractGeneration
  if (boundary === '配额') current.point_limit = current.segments.flatMap(segment => segment.points).length
  if (boundary === '显式重提') current.reextractGeneration = 1
  if (boundary === '来源变化') current.source_hash = '不同版本'
  expect(restoreLegacyTopicMembers(current, previous, new Set([point.point_id]), source.source_version)).toBe(current)
})
