import { expect, it } from 'vitest'
import { discoveryFixture } from './b6b-fixture.js'
import { callLibraryTool, LibraryWorkspace, listLibraryResources } from '../src/host/library-management.js'
import { runLibrariesCli } from '../src/host/library-cli.js'
import { registryRevision } from '../src/wiki/library-discovery.js'

const cli = async (f: ReturnType<typeof discoveryFixture>, command: string[], request: unknown) => {
  const output: string[] = [], errors: string[] = []
  const exit = await runLibrariesCli(['libraries', ...command, '--json', '-'], f.services, {
    stdin: async () => JSON.stringify(request), stdout: text => output.push(text), stderr: text => errors.push(text),
  })
  return { exit, output: output.length ? JSON.parse(output.join('')) : undefined, error: errors.length ? JSON.parse(errors.join('')).error : undefined }
}
it('CLI 登记、MCP 编辑与移除共用修订，手改逐字锁定且移除不删库', async () => {
  const f = discoveryFixture(), originalPath = f.store.snapshot().libraries[0]!.wikiPath
  const registered = await cli(f, ['register'], { registration: { id: 'added', name: '新登记', wikiPath: 'C:/现有库', sourceRoots: ['C:/资料'] }, expectedRegistryRevision: f.management.view().registryRevision })
  expect(registered.exit).toBe(0)
  const text = ' 手改\n  长简介。 '
  const updated = await callLibraryTool(f.services, 'wiki_update_library', { libraryId: 'added', patch: { pinned: true, order: 0, summary: { long: { text } } }, expectedRegistryRevision: registered.output.registryRevision }) as any
  expect(updated.registration.summary.long).toMatchObject({ text, origin: 'manual', locked: true })
  const repeated = await callLibraryTool(f.services, 'wiki_update_library', { libraryId: 'added', patch: { pinned: true, order: 0, summary: { long: { text } } }, expectedRegistryRevision: registered.output.registryRevision }) as any
  expect(repeated.registryRevision).toBe(updated.registryRevision)
  const removed = await cli(f, ['unregister'], { libraryId: 'added', expectedRegistryRevision: updated.registryRevision })
  expect(removed).toMatchObject({ exit: 0, output: { removed: true } })
  expect(f.store.snapshot().libraries[0]!.wikiPath).toBe(originalPath)
  expect(f.store.snapshot().libraries.some(item => item.id === 'added')).toBe(false)
})

it('工作区批量分组、排序、置顶保存，与 CLI 和 resource 读取一致', async () => {
  const f = discoveryFixture(), workspace = new LibraryWorkspace(f.services)
  workspace.load(); workspace.draft!.groups = [{ id: 'nursing', name: '护理组', order: 0 }]
  Object.assign(workspace.draft!.libraries[9]!, { groupId: 'nursing', pinned: true, order: 0 })
  await workspace.save()
  const listed = await cli(f, ['list'], { groupId: 'nursing' })
  expect(listed.output.libraries.map((item: any) => item.libraryId)).toEqual(['library-9'])
  const resources = await listLibraryResources(f.services)
  expect(resources.resources[0]!.uri).toBe('llmwiki://libraries/library-9/card')
  const groups = await cli(f, ['groups', 'list'], {})
  expect(groups.output.groups[0].name).toBe('护理组')
  const deleted = await cli(f, ['groups', 'save'], { groups: [], expectedRegistryRevision: groups.output.registryRevision })
  expect(deleted.exit).toBe(0); expect(f.store.registration('library-9').groupId).toBeNull()
})

it('并发冲突保留工作区与 CLI 草稿，路径身份、忙碌和越权补丁拒绝', async () => {
  const f = discoveryFixture(), workspace = new LibraryWorkspace(f.services), first = workspace.load()
  workspace.draft!.libraries[0]!.order = 99
  await f.management.update('library-1', { pinned: false }, first.registryRevision)
  await expect(workspace.save()).rejects.toMatchObject({ code: 'REGISTRY_CONFLICT', draft: { libraries: expect.arrayContaining([expect.objectContaining({ id: 'library-0', order: 99 })]) } })
  expect(workspace.draft!.libraries[0]!.order).toBe(99); expect(workspace.revision).toBe(first.registryRevision)
  const conflict = await cli(f, ['update'], { libraryId: 'library-0', patch: { order: 99 }, expectedRegistryRevision: first.registryRevision })
  expect(conflict).toMatchObject({ exit: 3, error: { code: 'REGISTRY_CONFLICT', draft: { order: 99 } } })
  await expect(f.management.update('library-0', { id: 'stolen' }, f.management.view().registryRevision)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
  await expect(f.management.register({ ...f.store.registration('library-0'), wikiPath: 'C:/其他位置' }, f.management.view().registryRevision)).rejects.toMatchObject({ code: 'LIBRARY_ID_CONFLICT' })
})

it('旧登记不自动置顶，简介解锁只作用显式档位，CLI 参数错误退出 2', async () => {
  const f = discoveryFixture(); f.mutate(registry => { for (const library of registry.libraries) delete library.pinned })
  expect((await f.discovery.l0()).libraries).toEqual([])
  const before = f.store.snapshot()
  await f.management.update('library-9', { summary: { short: { text: '护理' }, long: { text: '护理长简介' } } }, registryRevision(before))
  const unlocked = await cli(f, ['summary', 'unlock'], { libraryId: 'library-9', tier: 'short', expectedRegistryRevision: f.management.view().registryRevision })
  expect(unlocked.exit).toBe(0)
  expect(f.store.registration('library-9').summary).toMatchObject({ short: { locked: false, sourceVersion: null }, long: { locked: true, text: '护理长简介' } })
  expect((await cli(f, ['find'], { question: '' })).exit).toBe(2)
})

it('同一修订并发写入只接受一个不同目标，第二份草稿保持', async () => {
  const f = discoveryFixture(), revision = f.management.view().registryRevision
  const result = await Promise.allSettled([f.management.update('library-0', { order: 10 }, revision), f.management.update('library-1', { order: 11 }, revision)])
  expect(result[0].status).toBe('fulfilled'); expect(result[1]).toMatchObject({ status: 'rejected', reason: { code: 'REGISTRY_CONFLICT', draft: { order: 11 } } })
  expect(f.store.registration('library-1').order).toBe(1)
})
