import { afterEach, expect, it, vi } from 'vitest'
import type { PendingTopicReview } from '../src/layered/schema.js'
import { fixture } from './query-pages-audit-fixture.js'
import { pendingTopicReview } from './answer-evidence-fixture.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'
import { readVersion, writeVersion } from '../src/layered/objects.js'

const state = vi.hoisted(() => ({ pending: undefined as PendingTopicReview | undefined }))
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
vi.mock('../src/layered/revocations.js', async original => {
  const actual = await original<typeof import('../src/layered/revocations.js')>()
  return { ...actual, withLayeredRead: (root: string, action: any, options: any) => actual.withLayeredRead(root, view => action({ ...view,
    pendingReview: (page: string) => state.pending?.version === view.version && state.pending.pagePath === page ? state.pending : undefined }), options) }
})
afterEach(() => { state.pending = undefined; cleanupLayeredFixtures() })

it('搜索索引缓存命中仍动态取得当前版本同页状态，正文与排名不变', async () => {
  const f = await fixture()
  try {
    const before = await f.query.search('审查证据', f.library.id), target = 'topics/T-0001.md'
    state.pending = pendingTopicReview(target)
    const after = await f.query.search('审查证据', f.library.id)
    expect(after.results.map(item => item.path)).toEqual(before.results.map(item => item.path))
    expect(after.results.find(item => item.path === target)).toMatchObject({ pendingReview: state.pending })
    expect(after.results.filter(item => item.path !== target).every(item => !('pendingReview' in item))).toBe(true)
    state.pending = undefined
    expect((await f.query.search('审查证据', f.library.id)).results.every(item => !('pendingReview' in item))).toBe(true)
  } finally { f.cleanup() }
})

it('分页读取保留旧正文并附选中页状态，来源页没有默认状态', async () => {
  const f = await fixture()
  try {
    const target = 'topics/T-0001.md', before = await f.query.read(target, f.library.id)
    state.pending = pendingTopicReview(target)
    const page = await f.query.read(target, f.library.id, 50, undefined, { version: 'v000001' })
    expect(page).toMatchObject({ pendingReview: state.pending, content: before.content.slice(0, 50), truncated: true })
    expect(await f.query.read('sources/S-0001.md', f.library.id)).not.toHaveProperty('pendingReview')
    const previous = await readVersion(f.root, 'v000001')
    await writeVersion(f.root, { ...previous, version: 'v000002' })
    await f.put('state/current.json', { version: 'v000002', revocation_generation: 0, history: ['v000001'] })
    expect(await f.query.read(target, f.library.id)).not.toHaveProperty('pendingReview')
    expect(await f.query.read(target, f.library.id, 200, undefined, { version: 'v000001' }))
      .toMatchObject({ version: 'v000001', currentVersion: 'v000002', pendingReview: state.pending })
  } finally { f.cleanup() }
})
