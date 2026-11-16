import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it, vi } from 'vitest'
import { discoveryFixture } from './b6b-fixture.js'
import { temporary } from './b3-fixture.js'
import { createLibraryDiscovery, searchDiscovered } from '../src/wiki/library-reader.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { registerLibrarySkill } from '../src/host/library-management.js'

it.each([10, 50, 200])('%i 库：短目录有界、未置顶旧库可发现、分页完整与卡片按需读取', async size => {
  const f = discoveryFixture(size), l0 = await f.discovery.l0()
  expect(l0.libraries).toHaveLength(3); expect(l0.remainingCount).toBe(size - 3)
  expect(JSON.stringify(l0)).not.toContain('C:/')
  const registered = vi.fn(() => () => {}); await registerLibrarySkill({ register: registered }, f.discovery)
  expect(registered.mock.calls[0]![0].description).toContain(JSON.stringify(l0))
  expect(registered.mock.calls[0]![0].content).not.toContain('护理研究和临床实践')
  const selection = await f.discovery.find('静脉输液护理')
  expect(selection.cards.map(card => card.libraryId)).toEqual(['library-' + (size - 1)])
  expect(selection.cards[0]).toMatchObject({ long: '护理研究和临床实践', summaryStatus: 'missing', matchedFields: ['long', 'topTopics'] })
  const ids: string[] = []; let cursor: string | undefined
  do { const page = await f.discovery.list({ cursor, limit: 7 }); ids.push(...page.libraries.map(item => item.libraryId)); cursor = page.nextCursor ?? undefined } while (cursor)
  expect(ids).toHaveLength(size); expect(new Set(ids).size).toBe(size)
  const resource = await f.discovery.resource(selection.cards[0]!.cardUri)
  expect(JSON.parse(resource.contents[0]!.text).libraryId).toBe('library-' + (size - 1))
  console.info(JSON.stringify({ libraries: size, l0Bytes: Buffer.byteLength(JSON.stringify(l0)), estimatedTokens: Math.ceil(Buffer.byteLength(JSON.stringify(l0)) / 2), method: 'UTF-8 字节数/2，保守估算' }))
})

it('游标绑定修订与筛选，权限、撤权、离线、无匹配和响应限额均可见', async () => {
  const f = discoveryFixture(200), first = await f.discovery.list({ limit: 2 })
  await expect(f.discovery.list({ cursor: first.nextCursor!, groupId: null })).rejects.toMatchObject({ code: 'CURSOR_EXPIRED' })
  f.hidden.add('library-0')
  await expect(f.discovery.show('library-0')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  await expect(f.discovery.list({ cursor: first.nextCursor! })).rejects.toMatchObject({ code: 'CURSOR_EXPIRED' })
  f.offline.add('library-1')
  expect((await f.discovery.list()).libraries.find(item => item.libraryId === 'library-1')?.availability).toBe('unavailable')
  expect((await f.discovery.find('完全未知xyz')).status).toBe('no-match')
  expect((await f.discovery.find('完全未知xyz')).skipped).toContainEqual({ libraryId: 'library-1', reason: 'ENOENT' })
  f.metadata.get('library-199')!.generation = 1
  expect((await f.discovery.resource('llmwiki://libraries/library-199/card')).contents[0]!.text).not.toContain('护理研究')
  expect((await f.discovery.find('护理')).skipped).toContainEqual({ libraryId: 'library-199', reason: 'SUMMARY_REVIEW_REQUIRED' })
  f.mutate(registry => { for (const library of registry.libraries) library.name = '护理'.repeat(10000) })
  const result = await f.discovery.find('护理', 5)
  expect(Buffer.byteLength(JSON.stringify(result))).toBeLessThanOrEqual(32768); expect(result.truncated).toBe(true)
  await expect(f.discovery.find(' ')).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' })
})

it('固定检索语料自动选库与显式库一致，L3 不读取未选库或无匹配库', async () => {
  const f = await temporary(), library = { ...newLibrary('care'), name: '护理', wikiPath: f.root, sourceRoots: [f.parent],
    description: '静脉输液护理及跌倒预防', queryUnderstanding: { enabled: false } }
  await mkdir(path.join(f.root, 'concepts'))
  await writeFile(path.join(f.root, 'concepts', '护理.md'), '# 护理\n静脉输液护理需要观察局部皮肤，跌倒预防需要评估环境。', 'utf8')
  const registry = { ...emptyRegistry(), activeLibraryId: 'other', libraries: [library, { ...newLibrary('other'), name: '天文学', wikiPath: path.join(f.parent, 'other'), sourceRoots: [path.join(f.parent, 'sources')] }] }
  await mkdir(registry.libraries[1]!.wikiPath)
  const store = new LibraryStore(() => registry), discovery = createLibraryDiscovery(store)
  let consistent = 0
  for (const question of ['静脉输液护理', '跌倒预防']) {
    const automatic = await searchDiscovered(store, discovery, question), explicit = await searchDiscovered(store, discovery, question, '护理')
    expect(automatic.groups).toEqual(explicit.groups); expect(automatic.searchedLibraries).toEqual(['护理']); consistent++
    expect((await searchDiscovered(store, discovery, question, library.id)).groups).toEqual(explicit.groups)
  }
  const empty = await searchDiscovered(store, discovery, '星云xyz')
  expect(empty.searchedLibraries).toEqual([]); expect(empty.groups).toEqual([])
  console.info(JSON.stringify({ questions: 2, consistent, consistencyRate: consistent / 2, factualQuality: '待真实运行' }))
})
