import { afterEach, expect, it, vi } from 'vitest'
import { stringify } from 'yaml'
import { hash } from '../src/layered/files.js'
import { publicationProvenance, legacyProvenance, validateProvenance } from '../src/layered/models.js'
import { readVersion, versionPage } from '../src/layered/objects.js'
import { publishLibrary, validatePublication } from '../src/layered/publication.js'
import { topicHeader } from '../src/layered/topics.js'
import { storageJson } from '../src/layered/vectors.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'
import { pendingFixture } from './pipeline-audit-fixture.js'
import { identity, prepare } from './b3-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it.each(['缺页继承', '原样复用', '来源不变', '正文改写', '沿用接受'])('父页来源随最终子依赖收敛：%s', async mode => {
  const f = await pendingFixture(), build = f.pending.topics!, children = [...build.state.topics]
  expect(children).toHaveLength(2)
  const parent = { ...structuredClone(children[0]!), id: 'T-0099', path: 'topics/T-0099.md', parent_id: null,
    sources: [...new Set(children.flatMap(child => child.sources))].sort(), point_ids: children.flatMap(child => child.point_ids), direct_point_ids: [] }
  children.forEach(child => { child.parent_id = parent.id })
  build.state.topics.push(parent)
  const header = { ...topicHeader(build.pages[children[0]!.path]!.content), id: parent.id, sources: parent.sources }
  const content = '---\n' + stringify(header).trimEnd() + '\n---\n\n# 父主题\n\n## 子主题导航\n\n'
    + children.map(child => '- [' + child.id + '](' + child.path.slice('topics/'.length) + ')').join('\n') + '\n'
  build.pages[parent.path] = { content, dependencies: { sources: parent.sources, points: [], children: children.map(child => ({ page: child.path, version: '' })) } }
  const baseVersion = await publishLibrary(f.root, f.pending), base = await readVersion(f.root, baseVersion)
  const previous = await legacyProvenance(f.root, base, hash(storageJson(base)))
  if (mode === '沿用接受') {
    const accepted = await prepare(f.root, { identity: identity('父页历史接受', 'topic') })
    build.pages[parent.path]!.dependencies.acceptedRef = await accepted.commit()
    Object.assign(previous.records, accepted.accepted.productions)
    const artifact = Object.values(previous.artifacts).find(item => item.pagePath === parent.path)!
    artifact.status = 'legacy-recorded'; artifact.productionIds = Object.keys(accepted.accepted.productions)
    delete artifact.reason
  }
  f.pending.base_version = baseVersion
  f.pending.topic_scope = { targets: children.map(child => child.id), completed: children.map(child => child.id), review_inputs: {} }
  if (mode !== '来源不变') {
    const page = build.pages[children[1]!.path]!, replacement = build.pages[children[0]!.path]!
    page.content = replacement.content.replaceAll(children[0]!.id, children[1]!.id)
    page.dependencies = structuredClone(replacement.dependencies)
    const accepted = await prepare(f.root, { identity: identity('子页已接受修订', 'topic'), sequence: mode === '沿用接受' ? 2 : 1 })
    page.dependencies.acceptedRef = await accepted.commit()
  }
  if (mode === '缺页继承') delete build.pages[parent.path]
  else build.pages[parent.path]!.content = await versionPage(f.root, base, parent.path)
  if (mode === '正文改写') build.pages[parent.path]!.content += '\n新增未经接受的主张。\n'
  const beforeReview = structuredClone(base.deps!.pages[parent.path]!.review)
  f.call.mockClear(); f.call.mockImplementation(async () => { throw new Error('不得调用模型') })
  const version = await publishLibrary(f.root, f.pending, undefined, false, f.options), next = await readVersion(f.root, version)
  const final = await versionPage(f.root, next, parent.path), before = await versionPage(f.root, base, parent.path)
  expect(topicHeader(final).sources).toEqual(next.deps!.pages[parent.path]!.sources)
  expect(next.deps!.pages[parent.path]!.review).toEqual(beforeReview)
  await expect(validatePublication(f.root, version)).resolves.toBeUndefined()
  const proof = publicationProvenance(f.root, f.pending, hash(storageJson(next)), previous)
  if (mode === '正文改写') await expect(proof).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
  else {
    expect(final.split('\n---\n')[1]).toBe(before.split('\n---\n')[1])
    expect({ ...topicHeader(final), sources: undefined }).toEqual({ ...topicHeader(before), sources: undefined })
    const provenance = await proof
    expect(() => validateProvenance(provenance, version, hash(storageJson(next)))).not.toThrow()
    const oldArtifact = Object.values(previous.artifacts).find(item => item.pagePath === parent.path)!
    const artifact = Object.values(provenance.artifacts).find(item => item.pagePath === parent.path)!
    expect(artifact.status).toBe(oldArtifact.status)
    expect(artifact.productionIds).toEqual(oldArtifact.productionIds)
    expect(artifact.legacyEvidence).toEqual(oldArtifact.legacyEvidence)
    expect(next.pages![parent.path] === base.pages![parent.path]).toBe(mode === '来源不变')
  }
  expect(f.call).not.toHaveBeenCalled()
})
