import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { createLocalHost } from '../src/local/host.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'
import { sourceRecoveryFixture } from './source-recovery-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('直接建库的来源选择器与旧库备份互斥', async () => {
  const f = await sourceRecoveryFixture()
  await expect(buildLayeredLibrary({ ...f.options, retrySources: f.retrySources, legacyLibraryAction: 'backup' })).rejects.toThrow('旧库备份')
  expect(f.call).not.toHaveBeenCalled()
})

it('省略选择器续做时仍拒绝旧库备份', async () => {
  const f = await sourceRecoveryFixture()
  f.call.mockRejectedValue(Object.assign(new Error('测试预算暂停'), { budgetPause: true }))
  await expect(buildLayeredLibrary({ ...f.options, retrySources: f.retrySources })).rejects.toThrow('测试预算暂停')
  f.call.mockClear()
  await expect(buildLayeredLibrary({ ...f.options, legacyLibraryAction: 'backup' })).rejects.toThrow('旧库备份')
  expect(f.call).not.toHaveBeenCalled()
})

it('宿主拒绝null选择器，不把非法范围降为普通全库生成', async () => {
  const host = createLocalHost(emptyRegistry()), registration = vi.spyOn(host.store, 'registration')
  try {
    await expect(host.operations.generate('unused', 'generate', new AbortController().signal, undefined, false, undefined, undefined, undefined, null as never)).rejects.toThrow('非空')
    expect(registration).not.toHaveBeenCalled()
  } finally { host.dispose() }
})

it.each(['重建', '旧库备份'] as const)('宿主承接持久来源范围时在写入和全局摘要钩子前拒绝%s', async mode => {
  const f = await sourceRecoveryFixture(), registry = emptyRegistry(), library = newLibrary('source-recovery')
  library.wikiPath = f.root; library.sourceRoots = [f.knowledgeRoot]
  registry.libraries = [library]
  await writeFile(path.join(f.root, 'work/pending.json'), JSON.stringify({ source_scope: { request: f.retrySources } }))
  const host = createLocalHost(registry), root = vi.spyOn(host.store, 'root'), summaries = vi.spyOn(host.operations.libraries!.summaries, 'retryPending')
  try {
    await expect(host.operations.generate(library.id, 'generate', new AbortController().signal, undefined, mode === '重建', mode === '旧库备份' ? 'backup' : undefined)).rejects.toThrow('来源补缺不能与')
    expect(root).not.toHaveBeenCalled()
    expect(summaries).not.toHaveBeenCalled()
    expect(f.call).not.toHaveBeenCalled()
  } finally { host.dispose() }
})
