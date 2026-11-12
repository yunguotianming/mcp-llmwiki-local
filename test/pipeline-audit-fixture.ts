import { mockSupportReview } from './layered-fixture.js'
import { readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { prepareTopics } from '../src/layered/topics.js'
import type { Extraction, PendingBuild, SnapshotManifest } from '../src/layered/schema.js'
import { hydratedState, layeredTopicFixture, shareLayeredFixture } from './layered-fixture.js'
import type { FixtureSnapshot } from './layered-fixture.js'

let template: FixtureSnapshot | undefined

export async function pendingFixture() {
  const f = await layeredTopicFixture(template), original = f.call.getMockImplementation()!
  if (template) {
    const pending = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
    f.options.vectorIdentity = pending.manifest.vector_state?.identity
    const committed: SnapshotManifest = { format_version: pending.manifest.format_version, version: null, next_source_number: 1, revocation_generation: 0, sources: [] }
    return { ...f, pending, committed, original }
  }
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 甲资料\n\n甲组证据。')
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '# 乙资料\n\n乙组证据。')
  f.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
    if (JSON.parse(args[2]).topic_id) throw Object.assign(new Error('审查主动暂停'), { name: 'AbortError' })
    return original(...args)
  })
  await expect(buildLayeredLibrary(f.options)).rejects.toThrow('审查主动暂停')
  f.call.mockImplementation(original)
  const pending = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
  f.options.vectorIdentity = pending.manifest.vector_state?.identity
  const committed: SnapshotManifest = { format_version: pending.manifest.format_version, version: null, next_source_number: 1, revocation_generation: 0, sources: [] }
  await prepareTopics(f.root, pending, committed, f.options, undefined)
  // 模板只提供待测页面状态；后续用例会注入不同模型行为，不能继承模板模型的任务回执。
  const receipts = path.join(f.root, 'cache/tasks')
  for (const file of await readdir(receipts)) await unlink(path.join(receipts, file))
  // 只复用不可变文件字节，每项用例仍在独立新目录里修改自己的状态。
  template = await shareLayeredFixture(f)
  f.topicRequests.splice(0)
  return { ...f, pending, committed, original }
}

export async function changeExtraction(f: Awaited<ReturnType<typeof pendingFixture>>, change: (value: Extraction) => void) {
  const entry = f.pending.manifest.sources[0]!
  const value: Extraction = JSON.parse(await readFile(path.join(f.root, entry.extract.path), 'utf8'))
  change(value)
  // 独立成果路径模拟真实重试发布，避免读缓存掩盖变化。
  entry.extract.path = entry.extract.path.replace('.json', '-pipeline-audit.json')
  await writeFile(path.join(f.root, entry.extract.path), JSON.stringify(value))
  return value
}
