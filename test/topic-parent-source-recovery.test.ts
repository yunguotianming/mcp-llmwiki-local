import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { hash, writeJson } from '../src/layered/files.js'
import { synchronizeTopicSources } from '../src/layered/frontmatter.js'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { readVersion, versionPage } from '../src/layered/objects.js'
import * as publication from '../src/layered/publication.js'
import type { PendingBuild, Point } from '../src/layered/schema.js'
import { synchronizeTopicMetadata } from '../src/layered/topic-metadata.js'
import { topicHeader } from '../src/layered/topics.js'
import { cleanupLayeredFixtures, hydratedState } from './layered-fixture.js'
import { recoveryFixture } from './b1-recovery-fixture.js'
import { built, saveManifest } from './tags-anchors-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => { vi.restoreAllMocks(); return cleanupLayeredFixtures() })

it.each([true, false])('核对元数据仅收缩叶页来源，父页保留子来源：父页=%s', parent => {
  const content = '---\n' + 'sources: [S-0001, S-0002]\ntitle: 主题\naliases: []\n---\n# 主题\n'
    + (parent ? '\n## 子主题导航\n\n- [子主题](T-0001.md)\n' : '')
  const members = [{ evidence: [{ source_id: 'S-0001' }] }] as Point[]
  expect(topicHeader(synchronizeTopicMetadata(content, members)).sources).toEqual(parent ? ['S-0001', 'S-0002'] : ['S-0001'])
  expect(topicHeader(synchronizeTopicMetadata(content, [])).sources).toEqual(parent ? ['S-0001', 'S-0002'] : [])
})

async function acceptedInventory(root: string) {
  const folder = path.join(root, 'work/accepted')
  const entries = (await readdir(folder, { recursive: true, withFileTypes: true })).filter(item => item.isFile())
  return Object.fromEntries(await Promise.all(entries.map(async entry => {
    const file = path.join(entry.parentPath, entry.name)
    return [path.relative(folder, file), hash(await readFile(file))]
  })))
}

it.each(['空来源恢复', '再次中断续跑', '非法来源不冒充兼容'])('已完成父页的来源恢复边界：%s', async mode => {
  const f = await built('topics'), parent = f.manifest.topics!.topics[0]!
  const child = { ...structuredClone(parent), id: parent.id + '-01', path: parent.path.replace(/\.md$/, '/' + parent.id + '-01.md'), parent_id: parent.id }
  parent.direct_point_ids = []; f.manifest.topics!.topics.push(child)
  f.manifest.topic_gaps = [{ topic_id: child.id, point_ids: child.point_ids, message: 'Connection error.' }]
  delete f.manifest.pages![child.path]
  await saveManifest(f.root, f.manifest)
  const recovery = recoveryFixture(f.root, f.options.client)
  const options = { ...f.options, recovery: recovery.bindings, retryTopics: { topicIds: [child.id] }, publish: false, automaticRecovery: true }
  const publish = vi.spyOn(publication, 'publishLibrary').mockRejectedValueOnce(new Error('测试发布中断'))
  await expect(buildLayeredLibrary(options)).rejects.toThrow('测试发布中断')
  publish.mockRestore()
  const pending = await hydratedState<PendingBuild>(f.root, 'work/pending.json'), page = pending.topics!.pages[parent.path]!
  expect(pending.topic_scope!.completed).toContain(parent.id)
  expect(page.dependencies.sources.length).toBeGreaterThan(0)
  const body = page.content.split('\n---\n')[1], review = structuredClone(page.dependencies.review)
  page.content = synchronizeTopicSources(page.content, mode === '非法来源不冒充兼容' ? ['S-9999'] : [])
  await writeJson(f.root, 'work/pending.json', pending)
  const accepted = await acceptedInventory(f.root)
  f.call.mockClear(); f.call.mockImplementation(async () => { throw new Error('离线恢复不得调用模型') })
  {
    if (mode === '再次中断续跑') {
      const interrupted = vi.spyOn(publication, 'publishLibrary').mockRejectedValueOnce(new Error('再次发布中断'))
      await expect(buildLayeredLibrary(options)).rejects.toThrow('再次发布中断')
      interrupted.mockRestore()
    }
    const result = await buildLayeredLibrary(options)
    expect(result.modelCalls).toBe(0)
    await expect(publication.validatePublication(f.root, result.version)).resolves.toBeUndefined()
    const next = await readVersion(f.root, result.version), content = await versionPage(f.root, next, parent.path)
    expect(topicHeader(content).sources).toEqual(next.deps!.pages[parent.path]!.sources)
    expect(content.split('\n---\n')[1]).toBe(mode === '非法来源不冒充兼容'
      ? (await versionPage(f.root, f.manifest, parent.path)).split('\n---\n')[1] : body)
    const after = await hydratedState<PendingBuild>(f.root, 'work/pending.json')
    expect(after.runId).toBe(pending.runId)
    expect(after.base_version).toBe(pending.base_version)
    expect(after.topic_scope).toEqual(pending.topic_scope)
    if (mode === '非法来源不冒充兼容') {
      expect(after.topics!.pages[parent.path]).toBeUndefined()
    } else expect(after.topics!.pages[parent.path]!.dependencies.review).toEqual(review)
  }
  expect(await acceptedInventory(f.root)).toEqual(accepted)
  expect(f.call).not.toHaveBeenCalled()
})
