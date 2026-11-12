import { expect, it, vi } from 'vitest'
import { sharedFixture } from './query-pages-audit-fixture.js'
import { browsePages } from '../src/wiki/browse.js'
import type { LayeredReadView } from '../src/layered/revocations.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
const fixture = sharedFixture()

it('Q11 索引、主题、来源、章节、术语逐页遍历无重复无遗漏', async () => {
  const f = fixture()
  const collect = async (ref: string, depth = 1) => {
    const paths: string[] = []; let cursor: string | undefined
    for (let count = 0; count < 12; count++) {
      const result = await f.query.browse(f.library.name, ref, { limit: 1, depth, cursor })
      paths.push(...result.children.map(child => child.path))
      if (!result.next_cursor) return paths
      expect(result.children.length).toBeGreaterThan(0); cursor = result.next_cursor
    }
    throw new Error('游标未终止')
  }
  expect(await collect('root')).toEqual(['topics/T-0001.md', 'topics/T-0002.md'])
  expect(await collect('T-0001', 2)).toEqual(['sources/S-0001.md', 'terms/TM-0001.md', 'topics/T-0001/T-0001-01.md'])
  expect(await collect('S-0001')).toEqual(['sources/S-0001.md#^chapter-1', 'sources/S-0001.md#^chapter-3'])
  expect(await collect('sources/S-0001.md#^chapter-1')).toEqual(['sources/S-0001.md#^chapter-2'])
  expect(await collect('TM-0001')).toEqual([])
})

it('Q12 非法 ref 及 depth/limit 越界值必须拒绝', async () => {
  const f = fixture()
  for (const ref of ['../state/current.json', 'sources/S-9999.md', 'file:///secret']) await expect(f.query.browse(f.library.name, ref)).rejects.toThrow()
  for (const options of [{ depth: 0 }, { depth: 3 }, { depth: NaN }, { limit: 0 }, { limit: 51 }, { limit: 1.5 }, { limit: Infinity }])
    await expect(browsePages({} as LayeredReadView, f.library.name, 'root', options)).rejects.toThrow('浏览 depth')
})

it('Q13 游标不能跨节点或深度使用，非数字与超范围偏移拒绝', async () => {
  const f = fixture(), first = await f.query.browse(f.library.name, 'root', { limit: 1 }), cursor = first.next_cursor!
  expect(cursor).toBeTruthy()
  await expect(f.query.browse(f.library.name, 'T-0001', { cursor })).rejects.toThrow('游标')
  await expect(f.query.browse(f.library.name, 'root', { cursor, depth: 2 })).rejects.toThrow('游标')
  const prefix = cursor.slice(0, cursor.lastIndexOf(':') + 1)
  for (const offset of ['-1', '999', 'NaN', '1.5']) await expect(f.query.browse(f.library.name, 'root', { cursor: prefix + offset })).rejects.toThrow('游标')
})

it('Q14 长主题路径触发响应预算时游标仍必须前进或显式拒绝', async () => {
  // 只隔离页面读取，保留真实 browse 图构造、排序、序列化预算及游标逻辑。
  const relative = 'topics/' + Array.from({ length: 110 }, (_, i) => `T-0001-${String(i).padStart(2, '0')}`).join('/') + '.md'
  const view = { version: 'v000001', generation: 0, deps: { pages: { [relative]: { sources: [], points: [] } } },
    manifest: { sources: [], card: { name: '库', domain: '' } }, resolve: (ref: string) => ref,
    document: async () => ({ status: 'ok', content: '---\npage_type: topic\ntitle: 长路径\n---\n# 长路径' }),
  } as unknown as LayeredReadView
  const first = await browsePages(view, '库', 'root', { limit: 1 })
  expect(first.next_cursor).toBeTruthy()
  const second = await browsePages(view, '库', 'root', { limit: 1, cursor: first.next_cursor! })
  expect(second.next_cursor, '空页重复同一游标会使调用方永远无法取得该子页').not.toBe(first.next_cursor)
  expect(first.children.map(node => node.path)).toEqual([relative])
  expect(second.children).toEqual([])
  expect(second.next_cursor).toBeNull()
})

it('Q15 根的 depth=2 与分层逐节点遍历得到同一集合，关联页去重', async () => {
  const f = fixture(), result = await f.query.browse(f.library.name, 'root', { depth: 2, limit: 50 })
  const paths = result.children.map(node => node.path); let cursor = result.next_cursor
  while (cursor) {
    const next = await f.query.browse(f.library.name, 'root', { depth: 2, limit: 50, cursor })
    expect(next.children.length).toBeGreaterThan(0); paths.push(...next.children.map(node => node.path)); cursor = next.next_cursor
  }
  expect(new Set(paths).size).toBe(paths.length)
  expect(paths.sort()).toEqual([...f.markdown.keys()].sort())
})
