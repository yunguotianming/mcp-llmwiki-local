import * as filesystem from 'node:fs/promises'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import type { Extraction } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, snapshotManifest } from './layered-fixture.js'
import { sourceRecoveryExtraction, sourceRecoveryFixture } from './source-recovery-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

async function legacyCheckpoint(f: Awaited<ReturnType<typeof sourceRecoveryFixture>>, extraction: Extraction) {
  const file = path.join(f.root, f.manifest.sources[0]!.extract.path.replace('objects/snapshots/', 'work/extractions/').replace(/\.json$/, '-progress.json'))
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, JSON.stringify(extraction, null, 2) + '\n')
  return file
}

it('来源补摘要忽略普通历史提取半成品，保留旧点和遗留文件', async () => {
  const f = await sourceRecoveryFixture(), before = await sourceRecoveryExtraction(f.root, f.manifest, 'S-0001')
  const stale = structuredClone(before)
  stale.in_progress = true; delete stale.summary_pending
  Object.values(stale.group_cache!).forEach(group => { group.missing_summary = false })
  stale.gaps = []
  const file = await legacyCheckpoint(f, stale), bytes = await readFile(file)
  await buildLayeredLibrary({ ...f.options, retrySources: f.retrySources })
  const after = await sourceRecoveryExtraction(f.root, await snapshotManifest(f.root), 'S-0001')
  expect(after.segments).toEqual(before.segments)
  expect(after.chunk_plan).toEqual(before.chunk_plan)
  expect(f.calls.map(call => call.source_id)).toEqual(['S-0001'])
  expect(await readFile(file)).toEqual(bytes)
})

it('当前来源范围在真实摘要检查点后暂停可零重调续做，发布后的旧范围残留也不重调', async () => {
  const f = await sourceRecoveryFixture(), before = await sourceRecoveryExtraction(f.root, f.manifest, 'S-0001')
  const rename = filesystem.rename
  let checkpointPath = '', checkpointBytes: Buffer | undefined
  const pause = vi.spyOn(filesystem, 'rename').mockImplementation(async (from, to) => {
    if (String(to).includes('-source-recovery-') && String(to).endsWith('-progress.json')) {
      checkpointPath = String(to); checkpointBytes = await readFile(from)
      await rename(from, to)
      throw Object.assign(new Error('摘要检查点后暂停'), { budgetPause: true })
    }
    await rename(from, to)
  })
  await expect(buildLayeredLibrary({ ...f.options, retrySources: f.retrySources })).rejects.toThrow('摘要检查点后暂停')
  pause.mockRestore()
  expect(JSON.parse(checkpointBytes!.toString('utf8'))).toMatchObject({ in_progress: true, summary_pending: expect.any(Array) })
  expect(f.calls).toHaveLength(1)
  await buildLayeredLibrary(f.options)
  const after = await sourceRecoveryExtraction(f.root, await snapshotManifest(f.root), 'S-0001')
  expect(after.segments).toEqual(before.segments)
  expect(f.calls).toHaveLength(1)
  // 模拟已发布前的检查点遗留，新的相同范围请求必须以新基线隔离它。
  await writeFile(checkpointPath, checkpointBytes!)
  expect(await buildLayeredLibrary({ ...f.options, retrySources: f.retrySources })).toMatchObject({ unchanged: true, modelCalls: 0 })
  expect(f.calls).toHaveLength(1)
})
