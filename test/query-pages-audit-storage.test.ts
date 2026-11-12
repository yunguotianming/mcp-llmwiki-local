import * as fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { sharedFixture, secret } from './query-pages-audit-fixture.js'
import { revokeSourcesAtRoot } from '../src/layered/revocations.js'
import { layeredCacheDirectory, layeredIndex } from '../src/storage/jobs.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
const fixture = sharedFixture()

it('Q06 删除 cache 后三路并发冷查询重建无半表，结果与删除前一致', async () => {
  const f = fixture(), before = await f.query.search('审查证据'), cache = path.resolve(layeredCacheDirectory(f.root))
  expect(cache).toBe(path.dirname(f.database)); expect(path.basename(path.dirname(cache))).toBe('query-cache')
  await fs.rm(cache, { recursive: true })
  const concurrent = await Promise.all(Array.from({ length: 3 }, () => f.query.search('审查证据')))
  for (const result of concurrent) expect(result.results).toEqual(before.results)
  const db = new DatabaseSync(f.database)
  try {
    expect(db.prepare('SELECT count(*) AS n FROM page_index').get()).toEqual({ n: 6 })
    expect(db.prepare('SELECT count(*) AS n FROM page_search').get()).toEqual({ n: 6 })
    expect(db.prepare('PRAGMA integrity_check').get()).toEqual({ integrity_check: 'ok' })
  } finally { db.close() }
})

it('Q07 一个分层库的清单损坏时，其他库仍有分组结果和失败标注', async () => {
  const f = fixture(); await f.addLegacy('healthy')
  const file = path.join(f.root, 'state/current.json'), saved = await fs.readFile(file, 'utf8')
  await f.put('state/current.json', '{无效 JSON')
  try {
    const result = await f.query.search('审查证据')
    expect(result.groups.find(group => group.libraryId === 'healthy')?.results.length).toBeGreaterThan(0)
    expect(JSON.stringify([result.degradations, result.skippedLibraries])).toContain(f.library.name)
  } finally { await f.put('state/current.json', saved) }
  const bad = await f.addLegacy('bad-manifest'); bad.vaultPath = bad.wikiPath
  await fs.mkdir(path.join(bad.wikiPath, '.obsidian'))
  await fs.writeFile(path.join(bad.wikiPath, '.llm-wiki-databases.json'), '{损坏', 'utf8')
  const result = await f.query.search('审查证据')
  expect(result.groups.map(group => group.libraryId)).toContain('healthy')
  expect(result.degradations).toContainEqual(expect.objectContaining({ library: bad.name, stage: 'library', reason: 'invalid-data' }))
})

it('Q08 一个库不可读时其他库照常返回并标注，故障不能终止整次查询', async () => {
  const f = fixture(), other = await f.addLegacy('unreadable'), read = fs.readFile
  const spy = vi.spyOn(fs, 'readFile').mockImplementation((async (file, ...args) => {
    if (String(file).startsWith(other.wikiPath + path.sep)) throw Object.assign(new Error('拒绝访问夹具'), { code: 'EACCES' })
    return read(file, ...args as [never])
  }) as typeof fs.readFile)
  try {
    const result = await f.query.search('审查证据')
    expect(result.groups.find(group => group.libraryId === f.library.id)?.results).toHaveLength(6)
    expect(JSON.stringify([result.degradations, result.skippedLibraries])).toContain(other.name)
  } finally { spy.mockRestore() }
  const controller = new AbortController()
  const cancel = vi.spyOn(fs, 'readFile').mockImplementation((async (file, ...args) => {
    if (String(file).startsWith(other.wikiPath + path.sep)) controller.abort(new Error('主动取消'))
    return read(file, ...args as [never])
  }) as typeof fs.readFile)
  try { await expect(f.query.search('审查证据', undefined, undefined, 8, controller.signal)).rejects.toThrow('主动取消') }
  finally { cancel.mockRestore() }
})

it('Q09 撤权发生在跨库查询中途时不泄露；FTS、元数据、摘录、浏览、改写输入均过滤', async () => {
  const f = fixture(), other = await f.addLegacy('healthy'), read = fs.readFile
  await f.query.search('审查证据'); f.library.queryUnderstanding = { enabled: true }
  let revoked = false
  // 第一库命中已生成，第二库读取正文时撤权，迫使跨库一致性复核重新读取。
  const spy = vi.spyOn(fs, 'readFile').mockImplementation((async (file, ...args) => {
    if (!revoked && String(file) === path.join(other.wikiPath, 'concepts/a.md')) {
      revoked = true; await revokeSourcesAtRoot(f.root, ['S-0001'], '审查撤权')
    }
    return read(file, ...args as [never])
  }) as typeof fs.readFile)
  let result: Awaited<ReturnType<typeof f.query.search>>
  try { result = await f.query.search('何处有可用证据') } finally { spy.mockRestore() }
  expect(revoked).toBe(true); expect(f.runtime.stream).toHaveBeenCalledTimes(1)
  expect(result.groups).toHaveLength(2)
  expect(JSON.stringify(result)).not.toContain(secret)
  expect(JSON.stringify(result.groups)).not.toContain('S-0001')
  expect(JSON.stringify(f.runtime.stream.mock.calls)).not.toContain(secret)
  expect(JSON.stringify(f.runtime.stream.mock.calls)).not.toContain('S-0001')
  expect(JSON.stringify(await f.query.browse(f.library.name, 'root', { depth: 2 }))).not.toContain('S-0001')
  await expect(f.query.browse(f.library.name, 'S-0001')).rejects.toThrow('不可读')
  const db = new DatabaseSync(f.database.replace('-g0.sqlite', '-g1.sqlite'))
  try {
    expect(JSON.stringify(db.prepare('SELECT path,data FROM page_index').all())).not.toContain('S-0001')
    expect(db.prepare('SELECT count(*) AS n FROM page_search').get()).toEqual({ n: 2 })
  } finally { db.close() }
  expect(await layeredIndex(f.root, 'index-search', { query: '"紫色"' })).toEqual([])
})

it('Q10 Ollama 不可用与理解失败同时发生时独立标注，原话仍检索到公开页面', async () => {
  const f = fixture(); f.library.queryUnderstanding = { enabled: true }
  f.embed.mockRejectedValue(new Error('ECONNREFUSED'))
  f.runtime.stream.mockImplementation(async function* () { throw new Error('模型服务故障') })
  const result = await f.query.search('审查证据')
  expect(result.results.length).toBeGreaterThan(0)
  expect(result.degradations).toEqual(expect.arrayContaining([
    expect.objectContaining({ stage: 'understanding', reason: 'model-failed' }),
    expect.objectContaining({ stage: 'embedding', retrieval: 'fts' }),
  ]))
  expect(result.results.every(hit => !('retrieval' in hit) || hit.retrieval === 'fts')).toBe(true)
})
