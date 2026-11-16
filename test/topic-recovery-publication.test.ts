import { afterEach, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import { hash } from '../src/layered/files.js'
import { publicationProvenance, legacyProvenance, validateProvenance } from '../src/layered/models.js'
import { putPage, readVersion, versionPage } from '../src/layered/objects.js'
import { publishLibrary } from '../src/layered/publication.js'
import { topicHeader } from '../src/layered/topics.js'
import { hydrateVectors, storageJson } from '../src/layered/vectors.js'
import type { PendingBuild } from '../src/layered/schema.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'
import { built, saveManifest } from './tags-anchors-audit-fixture.js'
import { identity, prepare } from './b3-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

async function recovery() {
  const f = await built(true)
  // 模拟既有全局术语规范化后的标签；局部提取词典无法重新推导这个值。
  f.entry.tags = ['认知行为疗法']
  f.entry.tag_status = { count: 1, minimum: 3, personal_information_removed: 0, message: '标签不足' }
  for (const page of Object.keys(f.manifest.pages!).filter(page => page.startsWith('topics/') || page.startsWith('sources/'))) {
    const content = await versionPage(f.root, f.manifest, page), header = topicHeader(content)
    header.tags = ['认知行为疗法']
    f.manifest.pages![page] = await putPage(f.root, content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, `---\n${stringify(header).trimEnd()}\n---\n`))
  }
  await saveManifest(f.root, f.manifest)
  const state = structuredClone(f.manifest.topics!), dependencies = await hydrateVectors(f.root, structuredClone(f.manifest.deps!), true)
  const pages = Object.fromEntries(await Promise.all(state.topics.map(async topic => [topic.path,
    { content: await versionPage(f.root, f.manifest, topic.path), dependencies: structuredClone(dependencies.pages[topic.path]!) }] as const)))
  const pending: PendingBuild = { format_version: f.manifest.format_version, base_version: f.manifest.version, version: null,
    manifest: structuredClone(f.manifest), card: structuredClone(f.manifest.card!), added: [], model_calls: 0, started_at: new Date().toISOString(),
    topic_scope: { targets: [state.topics[0]!.id], completed: [state.topics[0]!.id], review_inputs: {} },
    topics: { fingerprint: hash('定向发布夹具'), state, pages, rewritten: [], model_calls: 0, aliases: structuredClone(f.manifest.aliases!) } }
  f.call.mockClear()
  return { ...f, pending }
}

it('主题恢复跳过术语仍保留旧标签、整页对象、术语分节依赖与导航', async () => {
  const f = await recovery()
  // 原失败发布曾把待办标签改成局部别名；应从已发布基线恢复。
  f.pending.manifest.sources[0]!.tags = ['CBT']
  const version = await publishLibrary(f.root, f.pending, undefined, false, f.options), next = await readVersion(f.root, version)
  const index = await versionPage(f.root, next, 'index.md')
  expect(next.sources[0]!.tags).toEqual(f.entry.tags)
  expect(next.sources[0]!.tag_status).toEqual(f.entry.tag_status)
  for (const [page, digest] of Object.entries(f.manifest.pages!).filter(([page]) => page !== 'index.md')) {
    expect(next.pages![page]).toBe(digest)
    expect(await versionPage(f.root, next, page)).toBe(await versionPage(f.root, f.manifest, page))
    if (page.startsWith('topics/') || page.startsWith('terms/index-')) expect(index).toContain(`](${page})`)
  }
  for (const [page, dependency] of Object.entries(f.manifest.deps!.pages).filter(([page]) => page.startsWith('terms/'))) {
    expect(next.deps!.pages[page]).toEqual({ ...dependency, ...(dependency.children ? { children: dependency.children.map(child => ({ ...child, version })) } : {}) })
  }
  expect(f.call).not.toHaveBeenCalled()
})

it('目标叶页和目标祖先的真实更新均保留，既有主题标签沿用基线', async () => {
  const f = await recovery(), target = f.pending.topics!.state.topics[0]!, parent = { ...structuredClone(target), id: 'T-0099', path: 'topics/T-0099.md' }
  target.parent_id = parent.id
  f.pending.topics!.state.topics.push(parent)
  const old = f.pending.topics!.pages[target.path]!
  const parentContent = old.content.replace(target.id, parent.id).replace('## 来源导航', '## 子主题导航')
    + `\n- [${target.id}](${target.path.slice('topics/'.length)})\n`
  f.manifest.pages![parent.path] = await putPage(f.root, parentContent)
  f.manifest.deps!.pages[parent.path] = { sources: [...target.sources], points: [], children: [{ page: target.path, version: f.manifest.version! }] }
  await saveManifest(f.root, f.manifest)
  f.pending.topics!.pages[parent.path] = { content: (await versionPage(f.root, f.manifest, parent.path)) + '\n<!-- 必要父页更新 -->\n', dependencies: structuredClone(f.manifest.deps!.pages[parent.path]!) }
  old.content += '\n<!-- 目标叶页更新 -->\n'
  const version = await publishLibrary(f.root, f.pending, undefined, false, f.options), next = await readVersion(f.root, version)
  for (const topic of [target, parent]) {
    expect(next.pages![topic.path]).not.toBe(f.manifest.pages![topic.path])
    expect(topicHeader(await versionPage(f.root, next, topic.path)).tags).toEqual(['认知行为疗法'])
  }
  expect(await versionPage(f.root, next, parent.path)).toContain('必要父页更新')
  expect(next.deps!.pages[parent.path]!.children).toEqual([{ page: target.path, version }])
  expect(f.call).not.toHaveBeenCalled()
})

it('原样页面继承对象时保留本轮新接受依赖并闭合生产链', async () => {
  const f = await recovery(), target = f.pending.topics!.state.topics[0]!
  const accepted = await prepare(f.root, { identity: identity('主题新接受', 'topic') }), ref = await accepted.commit()
  f.pending.topics!.pages[target.path]!.dependencies.acceptedRef = ref
  const previous = await legacyProvenance(f.root, f.manifest, hash(storageJson(f.manifest)))
  const version = await publishLibrary(f.root, f.pending, undefined, false, f.options)
  expect(f.pending.manifest.pages![target.path]).toBe(f.manifest.pages![target.path])
  expect(f.pending.manifest.deps!.pages[target.path]!.acceptedRef).toEqual(ref)
  const checksum = hash(storageJson(f.pending.manifest)), provenance = await publicationProvenance(f.root, f.pending, checksum, previous)
  expect(() => validateProvenance(provenance, version, checksum)).not.toThrow()
  const artifact = Object.values(provenance.artifacts).find(artifact => artifact.pagePath === target.path)!
  expect(artifact.status).toBe('recorded')
  expect(artifact.productionIds.some(id => provenance.records[id]?.taskId === ref.taskId)).toBe(true)
  expect(f.call).not.toHaveBeenCalled()
})

it('主题整页真实改变却无新接受仍拒绝发布生产链', async () => {
  const f = await recovery(), target = f.pending.topics!.state.topics[0]!
  const previous = await legacyProvenance(f.root, f.manifest, hash(storageJson(f.manifest)))
  delete f.pending.topics!.pages[target.path]!.dependencies.acceptedRef
  if (f.pending.topics!.pages[target.path]!.dependencies.review) delete f.pending.topics!.pages[target.path]!.dependencies.review!.acceptedRef
  f.pending.topics!.pages[target.path]!.content += '\n<!-- 未接受的新正文 -->\n'
  await publishLibrary(f.root, f.pending, undefined, false, f.options)
  await expect(publicationProvenance(f.root, f.pending, hash(storageJson(f.pending.manifest)), previous)).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
  expect(f.call).not.toHaveBeenCalled()
})

it('定向恢复保留未重新产出的祖先旧页时同步保留其实体与导航', async () => {
  const f = await recovery(), child = f.pending.topics!.state.topics[0]!
  const parent = { ...structuredClone(child), id: 'T-0099', path: 'topics/T-0099.md', parent_id: null }
  child.parent_id = parent.id
  f.manifest.topics!.topics[0]!.parent_id = parent.id
  f.manifest.topics!.topics.push(structuredClone(parent))
  const content = f.pending.topics!.pages[child.path]!.content.replace(child.id, parent.id).replace('## 来源导航', '## 子主题导航')
    + `\n- [${child.id}](${child.path.slice('topics/'.length)})\n`
  f.manifest.pages![parent.path] = await putPage(f.root, content)
  f.manifest.deps!.pages[parent.path] = { sources: [...parent.sources], points: [], children: [{ page: child.path, version: f.manifest.version! }] }
  await saveManifest(f.root, f.manifest)
  f.pending.topics!.gaps = [{ topic_id: parent.id, point_ids: parent.point_ids, message: '父页本轮未完成，保留旧成果' }]
  const version = await publishLibrary(f.root, f.pending, undefined, false, f.options), next = await readVersion(f.root, version)
  expect(next.pages![parent.path]).toBe(f.manifest.pages![parent.path])
  expect(next.topics!.topics.find(topic => topic.id === parent.id)).toEqual(parent)
  expect(next.topics!.topics.find(topic => topic.id === parent.id)?.point_ids).toEqual(parent.point_ids)
  expect(next.topics!.topics.find(topic => topic.id === parent.id)?.sources).toEqual(parent.sources)
  expect(await versionPage(f.root, next, 'index.md')).toContain(`](${parent.path})`)
  expect(next.deps!.pages[parent.path]!.children).toEqual([{ page: child.path, version }])
  expect(f.pending.topics!.gaps).toEqual([{ topic_id: parent.id, point_ids: parent.point_ids, message: '父页本轮未完成，保留旧成果' }])
  const previousProof = await legacyProvenance(f.root, f.manifest, hash(storageJson(f.manifest)))
  const proof = await publicationProvenance(f.root, f.pending, hash(storageJson(next)), previousProof)
  const oldArtifact = Object.values(previousProof.artifacts).find(artifact => artifact.pagePath === parent.path)!
  const inheritedArtifact = Object.values(proof.artifacts).find(artifact => artifact.pagePath === parent.path)!
  expect(oldArtifact.legacyEvidence?.length).toBeGreaterThan(0)
  expect(inheritedArtifact.status).toBe(oldArtifact.status)
  expect(inheritedArtifact.productionIds).toEqual(oldArtifact.productionIds)
  expect(inheritedArtifact.legacyEvidence).toEqual(oldArtifact.legacyEvidence)
  const repeated = await publishLibrary(f.root, f.pending, undefined, false, f.options), repeatedManifest = await readVersion(f.root, repeated)
  expect(repeatedManifest.topics!.topics.filter(topic => topic.id === parent.id)).toHaveLength(1)
  expect(f.call).not.toHaveBeenCalled()
})
