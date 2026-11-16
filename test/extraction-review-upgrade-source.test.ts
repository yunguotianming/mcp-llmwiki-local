import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { hash, writeJson } from '../src/layered/files.js'
import { storageJson } from '../src/layered/vectors.js'
import { upgradeReviewRunner } from '../src/layered/upgrade.js'
import type { ExecutionHooks } from '../src/layered/schema.js'
import { recoveryFixture } from './b1-recovery-fixture.js'
import { cleanupLayeredFixtures, layeredFixture } from './layered-fixture.js'
import { reviewFixture } from './quality-fix2-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

async function fixture(kind: string) {
  const storage = await layeredFixture(), f = reviewFixture(), siyuan = kind !== '本地'
  const sourceId = siyuan ? '20261115000000-abcdefg' : 'S-0001'
  const sourceVersion = siyuan ? '20261115000000~' + f.source.contentHash : f.source.contentHash
  const p = f.extraction.segments[0]!.points[0]!
  f.extraction.source_id = p.evidence[0]!.source_id = sourceId
  p.source_version = p.evidence[0]!.source_version = sourceVersion
  if (siyuan) {
    f.source.segments[0]!.locator = f.extraction.segments[0]!.locator = 'block:' + sourceId
    p.locator = p.evidence[0]!.locator = 'block:' + sourceId
  }
  const sourceFile = 'objects/upgrade-original.md', inputFile = 'objects/upgrade-input.md', extractionFile = 'objects/upgrade-extraction.json'
  const raw = kind === '思源投影' ? '# 原始 Kramdown\n{{{数据库块}}}\n' : f.source.text
  await mkdir(path.join(storage.root, 'objects'), { recursive: true })
  await writeFile(path.join(storage.root, sourceFile), raw)
  await writeFile(path.join(storage.root, inputFile), f.source.text)
  await writeJson(storage.root, extractionFile, f.extraction)
  const source = { source_id: sourceId, origin_type: siyuan ? 'siyuan' : 'local', current_path: '原文', previous_paths: [], content_hash: f.source.contentHash,
    source_version: sourceVersion, resource_version: [], segments: f.source.segments, metadata: f.source.metadata, files: { source: sourceFile, assets: [] },
    extract: { path: extractionFile, processing: f.extraction.processing, processing_fingerprint: '固定提取身份' },
    ...(siyuan ? { siyuan: { input: inputFile, objects: [{ path: inputFile, hash: hash(f.source.text) }] } } : {}) }
  const manifest = { format_version: 2, version: 'v000001', sources: [source] }
  await writeJson(storage.root, 'versions/v000001.json', { manifest, checksum: hash(storageJson(manifest)) })
  const recovery = recoveryFixture(storage.root, f.options.client)
  const runner = upgradeReviewRunner(() => recovery.bindings, f.options)
  const step = { id: '提取核对补齐', kind: 'review' as const, stage: 'extractionReview' as const, unitIds: [extractionFile], inputDigest: hash(f.source.text), estimatedInputTokens: 100, maxOutputTokens: 20 }
  const context = { root: storage.root, runId: '固定升级轮次', hooks: {} as ExecutionHooks, replayOnly: false }
  return { ...f, ...storage, source, sourceVersion, sourceId, sourceFile, inputFile, extractionFile, runner, step, context, reviewCall: f.call }
}

it.each(['本地', '思源版本', '思源投影'])('升级核对使用%s的真实来源身份版本与提取正文，原字节保留且续做零调用', async kind => {
  const f = await fixture(kind)
  const before = await readFile(path.join(f.root, f.extractionFile)), original = await readFile(path.join(f.root, f.sourceFile))
  const ref = await f.runner(f.step, f.context)
  expect(f.reviewCall).toHaveBeenCalledTimes(1)
  const input = JSON.parse(f.reviewCall.mock.calls[0]![2])
  expect(Object.values(input.contexts)).toMatchObject([{ source_id: f.sourceId, source_version: f.sourceVersion }])
  expect(Object.values(input.contexts).some((value: any) => value.text.includes('结果提高。'))).toBe(true)
  f.reviewCall.mockClear()
  expect(await f.runner(f.step, f.context)).toEqual(ref)
  expect(f.reviewCall).not.toHaveBeenCalled()
  expect(await readFile(path.join(f.root, f.extractionFile))).toEqual(before)
  expect(await readFile(path.join(f.root, f.sourceFile))).toEqual(original)
})

it.each(['摘要错误', '缺少对象身份', '文件丢失'])('思源提取投影%s时拒绝补核，不调用模型', async kind => {
  const f = await fixture('思源投影')
  if (kind === '摘要错误') await writeFile(path.join(f.root, f.inputFile), '替换投影')
  else if (kind === '文件丢失') await unlink(path.join(f.root, f.inputFile))
  else {
    f.source.siyuan!.objects = []
    const manifest = { format_version: 2, version: 'v000001', sources: [f.source] }
    await writeJson(f.root, 'versions/v000001.json', { manifest, checksum: hash(storageJson(manifest)) })
  }
  if (kind === '文件丢失') await expect(f.runner(f.step, f.context)).rejects.toMatchObject({ code: 'ENOENT' })
  else await expect(f.runner(f.step, f.context)).rejects.toThrow('升级核对来源投影缺失或摘要不符')
  expect(f.reviewCall).not.toHaveBeenCalled()
})

it('本地来源快照被篡改时在模型调用前拒绝补核', async () => {
  const f = await fixture('本地')
  const original = await readFile(path.join(f.root, f.sourceFile), 'utf8')
  await writeFile(path.join(f.root, f.sourceFile), original.replace('前一', '被篡改的适用条件'))
  await expect(f.runner(f.step, f.context)).rejects.toThrow('升级核对来源快照摘要不符')
  expect(f.reviewCall).not.toHaveBeenCalled()
})
