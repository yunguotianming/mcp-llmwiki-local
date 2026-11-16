import { readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { resultFingerprint } from '../src/layered/extraction.js'
import { hash } from '../src/layered/files.js'
import { storageJson } from '../src/layered/vectors.js'
import { cleanupLayeredFixtures, mockSupportReview, snapshotManifest } from './layered-fixture.js'
import { sourceRecoveryExtraction, sourceRecoveryFixture } from './source-recovery-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('review-only只核对未完成点，已接受点保持，旧摘要与范围外主题/向量不顺带重跑', async () => {
  const f = await sourceRecoveryFixture(), before = await sourceRecoveryExtraction(f.root, f.manifest, 'S-0001')
  const point = before.segments.flatMap(segment => segment.points)[0]!
  const accepted = structuredClone(before.segments.flatMap(segment => segment.points)[1]!)
  point.verification = { status: 'unverified', missing: '核对未完成：测试中断', fingerprint: point.verification!.fingerprint }
  before.correction_batches = { ...before.correction_batches, semantic: 0 }
  const entry = f.manifest.sources[0]!
  entry.extract.processing_fingerprint = resultFingerprint(before)
  await writeFile(path.join(f.root, entry.extract.path), JSON.stringify(before, null, 2) + '\n')
  await writeFile(path.join(f.root, 'versions', f.manifest.version! + '.json'), JSON.stringify({ checksum: hash(storageJson(f.manifest)), manifest: f.manifest }, null, 2) + '\n')
  const requests: any[] = [], vectorBytes = await readFile(path.join(f.root, 'state/embeddings.json'))
  f.call.mockImplementation(async (...args) => {
    const request = JSON.parse(args[2]); requests.push(request)
    return mockSupportReview(request) ?? f.originalCall(...args)
  })
  await buildLayeredLibrary({ ...f.options, retrySources: { sourceIds: ['S-0001'], kinds: ['review'] } })
  const next = await snapshotManifest(f.root), after = await sourceRecoveryExtraction(f.root, next, 'S-0001')
  expect(requests.some(request => request.review_stage === 'extraction')).toBe(true)
  expect(requests.every(request => request.review_stage || request.topic_id === f.manifest.topics!.topics[0]!.id)).toBe(true)
  expect(after.segments.flatMap(segment => segment.points)[0]!.verification?.status).toBe('verified')
  expect(after.segments.flatMap(segment => segment.points)[1]).toEqual(accepted)
  expect(requests.filter(request => request.review_stage === 'extraction').flatMap(request => request.points.map((item: any) => item.text))).toEqual([point.text])
  expect(Object.values(after.group_cache!).filter(group => group.missing_summary)).toHaveLength(1)
  expect(next.sources[1]).toEqual(f.manifest.sources[1])
  expect(next.pages!['topics/T-0002.md']).toBe(f.manifest.pages!['topics/T-0002.md'])
  expect(await readFile(path.join(f.root, 'state/embeddings.json'))).toEqual(vectorBytes)
  expect(f.embed).not.toHaveBeenCalled()
})

it('范围外来源修改在模型派发和发布前拒绝', async () => {
  const f = await sourceRecoveryFixture(), before = await readFile(path.join(f.root, 'state/current.json'))
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '乙组范围外内容发生变化。')
  await expect(buildLayeredLibrary({ ...f.options, retrySources: f.retrySources })).rejects.toThrow('新增、修改、删除或改名')
  expect(f.call).not.toHaveBeenCalled()
  expect(await readFile(path.join(f.root, 'state/current.json'))).toEqual(before)
})

it('范围外来源删除不能被定向补缺顺带撤权', async () => {
  const f = await sourceRecoveryFixture(), before = await readFile(path.join(f.root, 'state/revocations.json'))
  await unlink(path.join(f.knowledgeRoot, 'b.md'))
  await expect(buildLayeredLibrary({ ...f.options, retrySources: f.retrySources })).rejects.toThrow('新增、修改、删除或改名')
  expect(f.call).not.toHaveBeenCalled()
  expect(await readFile(path.join(f.root, 'state/revocations.json'))).toEqual(before)
})

it('未发布来源编号在创建pending和模型派发前拒绝', async () => {
  const f = await sourceRecoveryFixture()
  await expect(buildLayeredLibrary({ ...f.options, retrySources: { sourceIds: ['S-9999'], kinds: ['summary'] } })).rejects.toThrow('未发布')
  expect(f.call).not.toHaveBeenCalled()
  await expect(readFile(path.join(f.root, 'work/pending.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('定向补缺与强制重提互斥，零模型派发', async () => {
  const f = await sourceRecoveryFixture()
  await expect(buildLayeredLibrary({ ...f.options, retrySources: f.retrySources, reextract: ['S-0001'] })).rejects.toThrow('不能与')
  expect(f.call).not.toHaveBeenCalled()
})
