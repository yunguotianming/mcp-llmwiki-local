import { afterEach, expect, it, vi } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { buildLayeredLibrary, revokeLayeredSources } from '../src/layered/index.js'
import { layeredCacheDirectory, invalidateLayeredIndex } from '../src/storage/jobs.js'
import { LayeredQuery } from '../src/wiki/layered-query.js'
import { preparePointLabels } from '../src/layered/point-labels.js'
import { cleanupLayeredFixtures, layeredTopicFixture, snapshotManifest } from './layered-fixture.js'
import type { PendingBuild } from '../src/layered/schema.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
const roots: string[] = []
afterEach(async () => { vi.useRealTimers(); for (const root of roots.splice(0)) await invalidateLayeredIndex(root); cleanupLayeredFixtures() })
async function fixture() {
  const f = await layeredTopicFixture(); roots.push(f.root)
  await writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 甲组\n\n甲组独有研究结论。')
  await writeFile(path.join(f.knowledgeRoot, 'b.md'), '# 乙组\n\n乙组公开研究结论。')
  await buildLayeredLibrary(f.options)
  const manifest = await snapshotManifest(f.root)
  return { ...f, manifest, layered: { root: f.root, card: manifest.card! } }
}

it('设备缓存位于库外、没有正文和向量数组；全部删除后三路并发重建结果一致', async () => {
  const f = await fixture(), query = new LayeredQuery(f.options.embeddingClient), directory = layeredCacheDirectory(f.root)
  expect(path.relative(f.root, directory).startsWith('..')).toBe(true)
  const first = await query.search(f.library, f.layered, '研究结论')
  expect((await readdir(directory)).some(file => file.endsWith('.sqlite'))).toBe(true)
  const db = new DatabaseSync(path.join(directory, `${f.manifest.version}-g0.sqlite`))
  try {
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='page_search_content'").all()).toEqual([])
    const rows = db.prepare('SELECT data FROM page_index').all()
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) expect(String(row.data)).not.toMatch(/"(?:content|summary|vector|pointVectors)"\s*:/)
  } finally { db.close() }
  await invalidateLayeredIndex(f.root)
  expect(await readdir(directory)).toEqual([])
  const results = await Promise.all(Array.from({ length: 3 }, () => query.search(f.library, f.layered, '研究结论')))
  for (const result of results) expect(result.value).toEqual(first.value)
})

it('撤权立即物理清理本机旧代次缓存，新代次查询不含撤权来源或补标产物', async () => {
  const f = await fixture(), query = new LayeredQuery(f.options.embeddingClient), directory = layeredCacheDirectory(f.root)
  await query.search(f.library, f.layered, '研究结论')
  await revokeLayeredSources(f.knowledgeRoot, ['S-0001'], '合成撤权')
  expect(await readdir(directory)).toEqual([])
  const result = await query.search(f.library, f.layered, '甲组独有研究结论')
  expect(result.value.some(hit => hit.sources.includes('S-0001'))).toBe(false)
  expect((await readdir(directory)).every(file => file.includes('-g1.sqlite'))).toBe(true)
  const current = await snapshotManifest(f.root)
  expect(Object.keys(current.point_labels ?? {}).some(id => id.startsWith('S-0001:'))).toBe(false)
  expect(current.vector_state!.coverage.embedded.some(id => id.startsWith('S-0001:'))).toBe(false)
})

it('查询失败缓存满60秒后恢复同身份混合检索，期间不重复调用服务', async () => {
  const f = await fixture(), identity = vi.fn(async () => 'offline'), embed = vi.fn(async (input: string[]) => input.map(() => [1, 0]))
  vi.useFakeTimers({ toFake: ['Date'] }); const now = Date.now(); vi.setSystemTime(now)
  const query = new LayeredQuery({ identity, embed })
  expect((await query.search(f.library, f.layered, '甲组')).degradation).toBeDefined()
  identity.mockResolvedValue('fixture-weights-v1'); vi.setSystemTime(now + 59999)
  expect((await query.search(f.library, f.layered, '甲组')).degradation).toBeDefined()
  expect(identity).toHaveBeenCalledTimes(1); expect(embed).not.toHaveBeenCalled()
  vi.setSystemTime(now + 60001)
  const recovered = await query.search(f.library, f.layered, '甲组')
  expect(recovered.degradation).toBeUndefined(); expect(recovered.value.some(hit => hit.retrieval === 'hybrid')).toBe(true)
  expect(identity).toHaveBeenCalledTimes(2); expect(embed).toHaveBeenCalledTimes(1)
})

it('补标连接错误只保留缺口，不修改已完成主题或导致建库暂停', async () => {
  const f = await fixture()
  await buildLayeredLibrary({ ...f.options, publish: false, tagVocabulary: ['词表变化'] })
  const pending = JSON.parse(await readFile(path.join(f.root, 'work/pending.json'), 'utf8')) as PendingBuild
  const topics = structuredClone(pending.topics); delete pending.manifest.point_labels
  f.call.mockRejectedValue(Object.assign(new Error('连接重置'), { code: 'ECONNRESET' }))
  await preparePointLabels(f.root, pending, f.options)
  expect(pending.manifest.point_label_gaps).toHaveLength(2)
  expect(pending.paused).toBeUndefined(); expect(pending.topics).toEqual(topics)
})
