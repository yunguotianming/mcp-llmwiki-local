import { readFile, readdir } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { legacyFixture } from './b3-fixture.js'
import { emptyModels, emptyRegistry, newLibrary } from '../src/domain/config.js'
import { createLocalHost } from '../src/local/host.js'
import { hash, writeJson } from '../src/layered/files.js'
import { readUpgradeStatus, verifyUpgradeBackup } from '../src/layered/upgrade.js'
import { safePath } from '../src/storage/paths.js'
import { callLibraryManagement } from '../src/host/library-management.js'
import { putPage } from '../src/layered/objects.js'
import { storageJson } from '../src/layered/vectors.js'

it.each(['0.2.0', '0.2.1'] as const)('%s 经 local 发现只读不升级，首次补简介备份升级后仍自动选中', async version => {
  const f = await legacyFixture(version, version === '0.2.1'), library = newLibrary('legacy-integrated')
  // 升级夹具的裸正文补上历史页面元数据，形成可直接查询的旧版页面。
  for (const source of f.manifest.sources) f.manifest.pages![`sources/${source.source_id}.md`] = await putPage(f.root,
    `---\npage_type: source\ntitle: 护理资料${source.source_id}\n---\n\n${source.source_id} 的已发布证据。`)
  await writeJson(f.root, 'versions/v000001.json', { checksum: hash(storageJson(f.manifest)), manifest: f.manifest })
  const original = await readFile(await safePath(f.root, 'versions/v000001.json'))
  library.wikiPath = f.root; library.sourceRoots = [f.parent]; library.name = '护理资料'
  library.models = emptyModels(); library.models.unified = { provider: 'compatible:summary', model: 'summary' }
  await writeJson(f.root, '.llmwiki/library.json', { libraryId: library.id, formatVersion: 1, protocolVersion: 1 })
  const request = vi.fn<typeof fetch>(async (_url, init) => {
    const input = JSON.parse(JSON.parse(String(init!.body)).messages.at(-1).content[0].text)
    expect(input.tiers).toEqual(['short', 'long'])
    return Response.json({ choices: [{ message: { content: '{"short":"护理资料","long":"护理研究与临床实践。"}' }, finish_reason: 'stop' }] })
  })
  const host = createLocalHost({ ...emptyRegistry(), activeLibraryId: library.id, libraries: [library], compatibleProviders: {
    'compatible:summary': { baseUrl: 'https://offline.invalid/v1', api: 'openai-completions', model: 'summary' },
  } }, { request })
  try {
    const services = host.operations.libraries!, before = await readdir(f.root, { recursive: true })
    expect((await services.discovery.find('护理')).cards.map(card => card.libraryId)).toEqual([library.id])
    await host.query.read('S-0001', library.name)
    expect(await readUpgradeStatus(f.root)).toBeUndefined(); expect(await readdir(f.root, { recursive: true })).toEqual(before)
    await callLibraryManagement(services, 'summary/refresh', { libraryId: library.id, expectedRegistryRevision: services.management.view().registryRevision })
    const upgrade = (await readUpgradeStatus(f.root))!
    expect(upgrade.status).toBe('complete'); expect((await verifyUpgradeBackup(upgrade.backupPath)).complete).toBe(true)
    expect(await readFile(await safePath(f.root, 'versions/v000001.json'))).toEqual(original)
    expect((await services.discovery.find('临床实践')).cards[0]?.libraryId).toBe(library.id)
    expect((await host.operations.productionStatus(library.id)).format).toBe('0.3.0')
    expect(request).toHaveBeenCalledTimes(1)
  } finally { host.dispose() }
}, 30000)
