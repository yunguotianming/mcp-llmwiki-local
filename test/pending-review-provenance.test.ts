import { cp } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'vitest'
import { atomicWrite, hash, writeJson } from '../src/layered/files.js'
import { inheritPendingTopicReviews, legacyProvenance, pageReviewBinding, protocolDigest, publicationProvenance, readProvenance, validatePendingTopicReviews, writeProvenance } from '../src/layered/models.js'
import { putPage, writeVersion } from '../src/layered/objects.js'
import { readLayeredDocument, revokeSourcesAtRoot } from '../src/layered/revocations.js'
import { writeVersionCosts } from '../src/layered/costs.js'
import type { PendingBuild, PendingTopicReview } from '../src/layered/schema.js'
import { storageJson } from '../src/layered/vectors.js'
import { legacyFixture, runId } from './b3-fixture.js'

const page = 'topics/T-0001.md'
async function fixture() {
  const f = await legacyFixture(), manifest = f.manifest
  manifest.pages![page] = await putPage(f.root, '# 旧主题\n\n旧正文保留。\n')
  manifest.deps!.pages[page] = { sources: ['S-0001'], points: [], children: [{ page: 'sources/S-0001.md', version: manifest.version! }] }
  await atomicWrite(f.root, 'versions/v000001.json', storageJson({ checksum: hash(storageJson(manifest)), manifest }))
  const checksum = hash(storageJson(manifest)), provenance = await legacyProvenance(f.root, manifest, checksum)
  const review: PendingTopicReview = { status: 'unverified', reason: 'semantic-rejection', version: manifest.version!, pagePath: page,
    objectDigest: manifest.pages![page]!, reviewFingerprint: hash('完整核对输入'), ...await pageReviewBinding(f.root, manifest, page),
    protocol: 'legacy-topic-semantic-v1', runId, stepId: '旧主题组', taskId: 't:' + '1'.repeat(64), attemptIds: [`a:${runId}:1`],
    sentences: [{ id: 'S0', text: '# 旧主题', support: '不支撑', missing: '旧标题范围尚无充分依据。' }] }
  provenance.pendingTopicReviews = { [page]: review }
  await writeProvenance(f.root, provenance)
  await writeVersionCosts(f.root, manifest.version!, checksum, [])
  await writeJson(f.root, '.llmwiki/policy.json', { ...JSON.parse(f.policy), libraryFormat: '0.3.0' })
  return { ...f, checksum, provenance, review }
}

it('真实读视图保留旧正文与待核实状态，来源原文不继承主题状态，复制后保持', async () => {
  const f = await fixture(), result = await readLayeredDocument(f.root, page)
  expect(result).toMatchObject({ status: 'ok', content: '# 旧主题\n\n旧正文保留。\n', pendingReview: f.review })
  expect(await readLayeredDocument(f.root, 'sources/S-0001.md')).not.toHaveProperty('pendingReview')
  const copy = path.join(f.parent, '副本'); await cp(f.root, copy, { recursive: true })
  expect((await readProvenance(copy, 'v000001', f.checksum)).pendingTopicReviews).toEqual({ [page]: f.review })
})

it('待核实记录损坏、来源或子页内容变化不能按路径继续沿用', async () => {
  const f = await fixture(), damaged = structuredClone(f.provenance)
  damaged.pendingTopicReviews![page]!.dependenciesDigest = hash('损坏摘要')
  await expect(writeProvenance(f.root, damaged)).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
  const changed = structuredClone(f.manifest)
  changed.pages!['sources/S-0001.md'] = hash('已改变的子页')
  await expect(validatePendingTopicReviews(f.root, f.provenance, changed)).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
  expect(await inheritPendingTopicReviews(f.root, f.provenance, changed)).toBeUndefined()
  changed.sources[0]!.source_version = hash('原文新版本')
  expect(await inheritPendingTopicReviews(f.root, f.provenance, changed)).toBeUndefined()
})

it('同字节同证据在新版本继承，当前版本号和向量配置不造成假失效', async () => {
  const f = await fixture(), next = structuredClone(f.manifest)
  next.version = 'v000002'; next.deps!.pages[page]!.children![0]!.version = next.version
  next.vector_state = { status: 'disabled' } as typeof next.vector_state
  await writeVersion(f.root, next)
  expect(await inheritPendingTopicReviews(f.root, f.provenance, next)).toEqual({ [page]: { ...f.review, version: next.version } })
})

it('续建发布保留旧页待核实状态，改变正文却无新接受仍拒绝', async () => {
  const f = await fixture(), next = structuredClone(f.manifest)
  next.version = 'v000002'; next.deps!.pages[page]!.children![0]!.version = next.version
  const pending = { base_version: f.manifest.version, manifest: next } as PendingBuild
  const provenance = await publicationProvenance(f.root, pending, hash(storageJson(next)), f.provenance)
  expect(provenance.pendingTopicReviews).toEqual({ [page]: { ...f.review, version: next.version } })
  await writeVersion(f.root, next); await writeProvenance(f.root, provenance)
  expect((await readProvenance(f.root, next.version, hash(storageJson(next)))).pendingTopicReviews).toEqual(provenance.pendingTopicReviews)
  next.pages![page] = await putPage(f.root, '# 新主张\n\n未经核对的新正文。\n')
  await expect(publicationProvenance(f.root, pending, hash(storageJson(next)), f.provenance)).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
})

it('语义通过或无实际拒绝的记录不能被伪装成待核实终态', async () => {
  const f = await fixture()
  f.provenance.pendingTopicReviews![page]!.sentences[0]!.support = '完整支撑'
  await expect(writeProvenance(f.root, f.provenance)).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
  f.review.sentences[0]!.support = '不支撑'; f.review.attemptIds = []
  await expect(writeProvenance(f.root, f.provenance)).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
})

it('撤权先屏蔽历史正文并清除该来源的待核实句子，不影响未撤来源', async () => {
  const f = await fixture()
  await revokeSourcesAtRoot(f.root, ['S-0001'], '离线撤权验证')
  const result = await readLayeredDocument(f.root, page)
  expect(result.status).toBe('updating'); expect(result).not.toHaveProperty('pendingReview')
  expect(result.content).not.toContain('旧正文')
  const current = JSON.parse(await (await import('node:fs/promises')).readFile(path.join(f.root, 'versions/v000001.json'), 'utf8'))
  expect((await readProvenance(f.root, 'v000001', current.checksum)).pendingTopicReviews).toBeUndefined()
  expect(protocolDigest((await readLayeredDocument(f.root, 'sources/S-0002.md')).content)).toBe(protocolDigest('S-0002 的已发布证据。'))
})
