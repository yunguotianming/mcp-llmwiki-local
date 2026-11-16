import { afterEach, expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { Worker } from 'node:worker_threads'
import path from 'node:path'
import { temporaryWorkspace } from './temp.js'

interface Page { path: string; stamp: string; data: string; title: string; aliases: string; identity: string; body: string }
const page = (name: string, body: string): Page => ({ path: name + '.md', stamp: body, data: JSON.stringify({ title: name }), title: name, aliases: 'nursing role', identity: name, body })
const corpus = [page('alpha', 'nurse clinical identity'), page('beta', 'nurse educator novice'), page('gamma', 'nurse trial research')]
const cleanups: (() => Promise<unknown>)[] = []
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup() })
function client(file: string) {
  const worker = new Worker(new URL('../src/storage/sqlite-worker.ts', import.meta.url), { execArgv: [] })
  cleanups.push(() => worker.terminate())
  let sequence = 0
  return (operation: string, input: Record<string, unknown> = {}) => new Promise<any>((resolve, reject) => {
    const id = ++sequence
    const receive = (message: { id: number; value: unknown; error?: { message: string } }) => {
      if (message.id !== id) return
      worker.off('message', receive)
      if (message.error) reject(new Error(message.error.message)); else resolve(message.value)
    }
    worker.on('message', receive)
    worker.postMessage({ id, operation, file, libraryId: 'statistics-fixture', ...input })
  })
}
async function fixture(pages: Page[] = corpus) {
  const temp = await temporaryWorkspace(); cleanups.push(temp.cleanup)
  const file = path.join(temp.root, 'index.sqlite'), call = client(file)
  await call('initialize'); if (pages.length) await call('index-save', { pages })
  return { file, call, search: () => call('index-search', { query: '"nurse" OR "educator" OR "nursing"' }) }
}
function inspect(file: string) {
  const db = new DatabaseSync(file, { readOnly: true })
  try {
    const decode = (bytes: Uint8Array) => {
      let value = 0; const result: number[] = []
      for (const byte of bytes) { value = value * 128 + (byte & 127); if (!(byte & 128)) { result.push(value); value = 0 } }
      return result
    }
    const averages = decode((db.prepare('SELECT block FROM page_search_data WHERE id=1').get() as { block: Uint8Array }).block)
    const sizes = (db.prepare('SELECT sz FROM page_search_docsize').all() as { sz: Uint8Array }[]).map(row => decode(row.sz))
    const total = sizes.reduce((sum, sizes) => sizes.map((value, index) => value + (sum[index] ?? 0)), [] as number[])
    return { averages, expected: sizes.length ? [sizes.length, ...total] : [], pages: db.prepare('SELECT path,stamp,data FROM page_index ORDER BY path').all(),
      content: db.prepare('SELECT title,aliases,identity,body FROM page_search').all(), revision: db.prepare("SELECT value FROM metadata WHERE key='pageSearchRevision'").get() }
  } finally { db.close() }
}

it('同一批索引重复保存四次，BM25 分数及语料统计保持不变且不存正文', async () => {
  const f = await fixture(), before = await f.search()
  for (let i = 0; i < 4; i++) await f.call('index-save', { pages: corpus })
  expect(await f.search()).toEqual(before)
  const state = inspect(f.file)
  expect(state.averages).toEqual(state.expected)
  expect(state.content.every(row => Object.values(row).every(value => value === null))).toBe(true)
})

it('单页真实更新保留未改页词项及定位，分数等于同语料新建索引', async () => {
  const f = await fixture(), changed = page('alpha', 'nurse educator senior'), fresh = await fixture([changed, ...corpus.slice(1)])
  const before = inspect(f.file).pages
  await f.call('index-save', { pages: [changed] })
  expect(await f.search()).toEqual(await fresh.search())
  expect(await f.call('index-search', { query: '"clinical"' })).toEqual([])
  expect(await f.call('index-search', { query: '"educator novice"' })).toHaveLength(1)
  expect(inspect(f.file).pages.filter(row => row.path !== changed.path)).toEqual(before.filter(row => row.path !== changed.path))
  expect(inspect(f.file).averages).toEqual(inspect(f.file).expected)
})

it('删除页面后真实词项和统计同步移除，剩余分数等于新建索引', async () => {
  const f = await fixture(), fresh = await fixture(corpus.slice(1))
  await f.call('index-save', { removed: [corpus[0]!.path] })
  expect(await f.search()).toEqual(await fresh.search())
  expect(await f.call('index-search', { query: '"clinical"' })).toEqual([])
  expect(inspect(f.file).averages).toEqual(inspect(f.file).expected)
  await f.call('index-save', { removed: corpus.slice(1).map(row => row.path) })
  expect(await f.search()).toEqual([])
  expect(inspect(f.file).averages).toEqual([])
})

it('旧累计统计一次性修复，作业和页面元数据保持，后续读取不再重建', async () => {
  const f = await fixture(), fresh = await fixture()
  await f.call('save', { patches: [{ id: 'job1', header: '{"id":"job1","status":"paused"}', chunks: [], attempts: [], checkpoints: [] }] })
  const db = new DatabaseSync(f.file)
  try {
    db.exec("DELETE FROM metadata WHERE key='pageSearchRevision'")
    const remove = db.prepare('DELETE FROM page_search WHERE rowid=(SELECT rowid FROM page_index WHERE path=?)')
    const insert = db.prepare('INSERT INTO page_search(rowid,title,aliases,identity,body) VALUES((SELECT rowid FROM page_index WHERE path=?),?,?,?,?)')
    for (let i = 0; i < 3; i++) for (const row of corpus) { remove.run(row.path); insert.run(row.path, row.title, row.aliases, row.identity, row.body) }
  } finally { db.close() }
  const old = inspect(f.file); expect(old.averages[0]).toBe(corpus.length * 4)
  expect(await f.search()).toEqual(await fresh.search())
  expect(inspect(f.file).pages).toEqual(old.pages)
  expect(await f.call('read')).toMatchObject([{ id: 'job1', status: 'paused' }])
  expect(inspect(f.file).revision).toEqual({ value: 'live-counts-v1' })
  const fixed = inspect(f.file)
  await f.call('index-read'); await f.search()
  expect(inspect(f.file)).toEqual(fixed)
})

it('四工作线程并发首次保存保持幂等，失败批次回滚词项与页面元数据', async () => {
  const f = await fixture([]), clients = Array.from({ length: 4 }, () => client(f.file))
  const db = new DatabaseSync(f.file)
  try { db.exec("DELETE FROM metadata WHERE key='pageSearchRevision'") } finally { db.close() }
  await Promise.all(clients.map(call => call('index-save', { pages: corpus })))
  expect(inspect(f.file).averages).toEqual(inspect(f.file).expected)
  const before = inspect(f.file), ranking = await f.search()
  await expect(f.call('index-save', { removed: [corpus[0]!.path], pages: [{ ...page('broken', 'educator'), body: undefined }] })).rejects.toThrow()
  expect(inspect(f.file)).toEqual(before)
  expect(await f.search()).toEqual(ranking)
})
