import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { resultFingerprint } from '../src/layered/extraction.js'
import { hash } from '../src/layered/files.js'
import { storageJson } from '../src/layered/vectors.js'
import { recoveryFixture } from './b1-recovery-fixture.js'
import { cleanupLayeredFixtures, mockSupportReview, snapshotManifest } from './layered-fixture.js'
import { sourceRecoveryExtraction, sourceRecoveryFixture } from './source-recovery-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

// 护士库 review-09 现场：一个已有语义判定的要点因输入超出上下文预算未能核对，旧版本把“核对未完成”写成无接受来源的新成果。
async function pendingReviewFixture(missing = '引文未覆盖主张中的限定条件。') {
  const f = await sourceRecoveryFixture(), before = await sourceRecoveryExtraction(f.root, f.manifest, 'S-0001')
  const point = before.segments.flatMap(segment => segment.points)[0]!
  point.verification = { status: 'unverified', missing, fingerprint: point.verification!.fingerprint }
  before.correction_batches = { ...before.correction_batches, semantic: 0 }
  const entry = f.manifest.sources[0]!
  entry.extract.processing_fingerprint = resultFingerprint(before)
  await writeFile(path.join(f.root, entry.extract.path), JSON.stringify(before, null, 2) + '\n')
  await writeFile(path.join(f.root, 'versions', f.manifest.version! + '.json'), JSON.stringify({ checksum: hash(storageJson(f.manifest)), manifest: f.manifest }, null, 2) + '\n')
  return { ...f, before, entry, point, recovery: recoveryFixture(f.root, f.options.client) }
}

it('只核对补缺的核对未被接受时保留上一版提取与原判定并登记延后，不以生产记录错误中止', async () => {
  const f = await pendingReviewFixture()
  const requests: any[] = []
  f.call.mockImplementation(async (...args) => {
    const request = JSON.parse(args[2]); requests.push(request)
    if (request.review_stage === 'extraction' || request.review_stage === 'extraction-correction') throw new Error('核对或纠正输入超出上下文预算。')
    return mockSupportReview(request) ?? f.originalCall(...args)
  })
  const result = await buildLayeredLibrary({ ...f.options, recovery: f.recovery.bindings, retrySources: { sourceIds: ['S-0001'], kinds: ['review'] } })
  expect(requests.some(request => request.review_stage === 'extraction' || request.review_stage === 'extraction-correction')).toBe(true)
  expect(result).toMatchObject({ unchanged: true, modelCalls: 0 })
  const next = await snapshotManifest(f.root), source = next.sources.find(item => item.source_id === 'S-0001')!
  expect(source.extract.path).toBe(f.entry.extract.path)
  const kept = await sourceRecoveryExtraction(f.root, next, 'S-0001')
  expect(kept.segments.flatMap(segment => segment.points)[0]!.verification).toEqual(f.point.verification)
  await expect(readFile(path.join(f.root, 'work/pending.json'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('续跑时恢复旧版本留下的无接受来源补缺成果，按当前预算重新核对后发布', async () => {
  const f = await pendingReviewFixture('核对未完成：测试中断')
  // 第二个来源同样带未完成核对的要点；其核对在首个来源完成后暂停，留下可续跑的 pending。
  const second = await sourceRecoveryExtraction(f.root, f.manifest, 'S-0002'), secondPoint = second.segments.flatMap(segment => segment.points)[0]!
  secondPoint.verification = { status: 'unverified', missing: '核对未完成：测试中断', fingerprint: secondPoint.verification!.fingerprint }
  second.correction_batches = { ...second.correction_batches, semantic: 0 }
  const secondEntry = f.manifest.sources[1]!
  secondEntry.extract.processing_fingerprint = resultFingerprint(second)
  await writeFile(path.join(f.root, secondEntry.extract.path), JSON.stringify(second, null, 2) + '\n')
  await writeFile(path.join(f.root, 'versions', f.manifest.version! + '.json'), JSON.stringify({ checksum: hash(storageJson(f.manifest)), manifest: f.manifest }, null, 2) + '\n')
  let pause = true
  f.call.mockImplementation(async (...args) => {
    const request = JSON.parse(args[2])
    if (pause && request.source_id === 'S-0002' && request.review_stage) throw Object.assign(new Error('暂停'), { budgetPause: true })
    return mockSupportReview(request) ?? f.originalCall(...args)
  })
  const options = { ...f.options, recovery: f.recovery.bindings, retrySources: { sourceIds: ['S-0001', 'S-0002'], kinds: ['review' as const] } }
  await expect(buildLayeredLibrary(options)).rejects.toMatchObject({ budgetPause: true })
  const pendingFile = path.join(f.root, 'work/pending.json'), pending = JSON.parse(await readFile(pendingFile, 'utf8'))
  expect(pending.source_scope.completed).toContain('S-0001')
  const stale = pending.manifest.sources.find((item: any) => item.source_id === 'S-0001')
  expect(stale.extract.path).not.toBe(f.entry.extract.path)
  delete stale.acceptedRef
  await writeFile(pendingFile, JSON.stringify(pending, null, 2) + '\n')
  pause = false; f.call.mockClear()
  await buildLayeredLibrary(options)
  // 本例首轮核对已被接受，修复条目后重放原接受结果、零新增调用；未被接受的现场则按当前预算重新核对。
  const reviewed = f.call.mock.calls.map(call => JSON.parse(call[2])).filter(request => request.review_stage && request.source_id === 'S-0001')
  expect(reviewed).toEqual([])
  const next = await snapshotManifest(f.root), source = next.sources.find(item => item.source_id === 'S-0001')!
  expect(source.acceptedRef).toBeDefined()
  expect((await sourceRecoveryExtraction(f.root, next, 'S-0001')).segments.flatMap(segment => segment.points)[0]!.verification?.status).toBe('verified')
})
