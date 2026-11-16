import { readFile, unlink } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { newLibrary } from '../src/domain/config.js'
import { hash, writeJson } from '../src/layered/files.js'
import { legacyProvenance, writeProvenance } from '../src/layered/models.js'
import { putPage, readCurrent, readVersion, writeVersion } from '../src/layered/objects.js'
import { publishLibrary } from '../src/layered/publication.js'
import * as retention from '../src/layered/retention.js'
import { writeVersionCosts } from '../src/layered/costs.js'
import { storageJson } from '../src/layered/vectors.js'
import type { PendingBuild } from '../src/layered/schema.js'
import { ChangeStore } from '../src/storage/changes.js'
import type { LibraryStore } from '../src/storage/libraries.js'
import { safePath } from '../src/storage/paths.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'
import { built } from './tags-anchors-audit-fixture.js'
import { derivationFixture } from './summary-derivation-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
const collectGarbage = retention.collectGarbage
afterEach(cleanupLayeredFixtures)

it('v4已激活而GC中断后，原批次续提交保全缺附属的v3且清完原收尾', async () => {
  const f = await built(), checksum = hash(storageJson(f.manifest))
  await writeProvenance(f.root, await legacyProvenance(f.root, f.manifest, checksum))
  await writeVersionCosts(f.root, f.manifest.version!, checksum, [])
  await writeJson(f.root, '.llmwiki/policy.json', { libraryFormat: '0.3.0' })
  const orphan = structuredClone(f.manifest); orphan.version = 'v000003'
  const pageId = await putPage(f.root, '# 失败发布中已封存的页面')
  orphan.pages!['index.md'] = pageId
  await writeVersion(f.root, orphan)
  const orphanBytes = await readFile(await safePath(f.root, 'versions/v000003.json'))
  const pending: PendingBuild = { format_version: 2, base_version: f.manifest.version, version: null, manifest: structuredClone(f.manifest),
    card: f.manifest.card!, added: [], model_calls: 0, started_at: new Date().toISOString(), runId: '11111111-1111-4111-8111-111111111111' }
  const version = await publishLibrary(f.root, pending, undefined, false, f.options)
  expect(version).toBe('v000004')
  const library = { ...newLibrary('测试库'), wikiPath: f.root, sourceRoots: [f.knowledgeRoot] }
  const store = { root: async () => f.root, registration: () => library, policy: async () => ({ revision: '固定策略' }) } as unknown as LibraryStore
  const changes = new ChangeStore(store), batch = await changes.prepareLayered(library.id, version, JSON.stringify(library), '固定策略')
  const gc = vi.spyOn(retention, 'collectGarbage').mockRejectedValueOnce(new Error('测试激活后的GC中断'))
  await expect(changes.commit(library.id, batch.id, batch.digest)).rejects.toThrow('测试激活后的GC中断')
  expect((await readCurrent(f.root))?.version).toBe(version)
  await expect(readFile(await safePath(f.root, 'work/pending.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(await safePath(f.root, 'state/gc-pending.json'))).resolves.toBeDefined()
  gc.mockImplementation(root => collectGarbage(root, retention.readerLeaseMs))
  f.call.mockClear()
  expect((await changes.commit(library.id, batch.id, batch.digest)).status).toBe('committed')
  expect((await readVersion(f.root, version)).sources).toEqual(pending.manifest.sources)
  expect(await readFile(await safePath(f.root, 'versions/v000003.json'))).toEqual(orphanBytes)
  await expect(readFile(await safePath(f.root, `objects/pages/${pageId.slice(7)}.md`))).resolves.toBeDefined()
  for (const file of ['state/gc-pending.json', 'work/preview.json']) await expect(readFile(await safePath(f.root, file))).rejects.toMatchObject({ code: 'ENOENT' })
  expect((await changes.commit(library.id, batch.id, batch.digest)).id).toBe(batch.id)
  expect(f.call).not.toHaveBeenCalled()
})

it.each(['current', 'history', 'reader', 'work'] as const)('%s强引用缺少附属文件时GC仍拒绝，不能借宽限残留规则放行', async kind => {
  const f = await derivationFixture(), orphan = structuredClone(f.manifest)
  orphan.version = 'v000003'; await writeVersion(f.root, orphan)
  if (kind === 'current') await writeJson(f.root, 'state/current.json', { version: orphan.version, revocation_generation: 0, history: [f.manifest.version] })
  if (kind === 'history') await writeJson(f.root, 'state/current.json', { version: f.manifest.version, revocation_generation: 0, history: [orphan.version] })
  if (kind === 'reader') await writeJson(f.root, 'state/readers/active.json', { pid: process.pid, device: '测试设备', version: orphan.version, expires_at: Date.now() + retention.readerLeaseMs })
  if (kind === 'work') await writeJson(f.root, 'work/preview.json', { version: orphan.version })
  await expect(collectGarbage(f.root, retention.readerLeaseMs)).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
  await expect(readFile(await safePath(f.root, 'versions/v000003.json'))).resolves.toBeDefined()
})

it('仅宽限保留的版本已有附属文件损坏时仍拒绝，不能当缺失残留跳过', async () => {
  const f = await derivationFixture(), orphan = structuredClone(f.manifest)
  orphan.version = 'v000003'; await writeVersion(f.root, orphan)
  await writeJson(f.root, 'versions/v000003.provenance.json', { damaged: true })
  await expect(collectGarbage(f.root, retention.readerLeaseMs)).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
  await unlink(await safePath(f.root, 'versions/v000003.provenance.json'))
  await expect(collectGarbage(f.root, retention.readerLeaseMs)).resolves.toBeUndefined()
})
