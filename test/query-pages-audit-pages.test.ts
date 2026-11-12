import * as fs from 'node:fs/promises'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { expect, it, vi } from 'vitest'
import { sharedFixture, secret } from './query-pages-audit-fixture.js'
import { refreshReadingCopy } from '../src/layered/reading-copy.js'
import { readVersion } from '../src/layered/objects.js'
import { layeredIndex } from '../src/storage/jobs.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
const fixture = sharedFixture()

it('Q01 命中片段和摘录逐字存在于当前版页面，保留空白、换行及 emoji', async () => {
  const f = fixture(), result = await f.query.search('空格 emoji')
  expect(result.results).toHaveLength(6)
  for (const hit of result.results) {
    const raw = f.markdown.get(hit.path)!
    expect(raw).toContain(hit.snippet)
    expect(hit.anchor).toBe('^proof')
    for (const quote of hit.excerpts) {
      expect(raw).toContain(quote.content)
      expect(quote).toMatchObject({ library: f.library.name, path: hit.path, title: hit.title, anchor: expect.any(String) })
      expect(quote.anchor).not.toBe('')
    }
  }
})

it('Q02 阅读副本手改且已登记冲突时，该页不进入检索', async () => {
  const f = fixture(), relative = 'topics/T-0001.md'
  await refreshReadingCopy(f.root, await readVersion(f.root, 'v000001'))
  await f.put('wiki/' + relative, '# 用户手改\n\n这不是已发布内容。')
  const saved = JSON.parse(await fs.readFile(path.join(f.root, 'state/reading-copy.json'), 'utf8'))
  await f.put('state/reading-copy.json', { ...saved, target: 'v000001' })
  await refreshReadingCopy(f.root, await readVersion(f.root, 'v000001'))
  const conflicts = await fs.readdir(path.join(f.root, 'conflicts'))
  expect(conflicts.length).toBeGreaterThan(0)
  try {
    const result = await f.query.search('审查证据')
    expect(result.results.map(hit => hit.path)).not.toContain(relative)
    await layeredIndex(f.root, 'index-save', { removed: [...f.markdown.keys()] })
    expect((await f.query.search('审查证据')).results.map(hit => hit.path)).not.toContain(relative)
    expect((await f.query.read(relative, f.library.name)).status).toBe('updating')
  } finally { await f.put('wiki/' + relative, f.markdown.get(relative)!) }
  expect((await f.query.search('审查证据')).results.map(hit => hit.path)).toContain(relative)
})

it('Q03 索引哈希不符本次跳过并标注，下次查询重新建立完整结果', async () => {
  const f = fixture(), first = await f.query.search('审查证据'), db = new DatabaseSync(f.database)
  try { db.prepare("UPDATE page_index SET data=json_set(data,'$.hash','过期哈希') WHERE path=?").run('topics/T-0002.md') } finally { db.close() }
  const stale = await f.query.search('审查证据')
  expect(stale.results.map(hit => hit.path)).not.toContain('topics/T-0002.md')
  expect(stale.degradations).toEqual(expect.arrayContaining([expect.objectContaining({ stage: 'index', reason: 'stale-index' })]))
  expect((await f.query.search('审查证据')).results).toEqual(first.results)
})

it('Q04 新建 contentless SQLite 的结构、元数据和实际文件均不保存正文', async () => {
  const f = fixture(); await f.query.search('审查证据')
  const db = new DatabaseSync(f.database)
  try {
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='page_search_content'").all()).toEqual([])
    expect(db.prepare('SELECT body FROM page_search').all()).toEqual(Array(6).fill({ body: null }))
    for (const row of db.prepare('SELECT data FROM page_index').all() as { data: string }[]) {
      const data = JSON.parse(row.data)
      for (const field of ['content', 'body', 'summary', 'vector']) expect(data).not.toHaveProperty(field)
      expect(data.hash).toBeTruthy()
    }
  } finally { db.close() }
  for (const suffix of ['', '-wal']) {
    const bytes = await fs.readFile(f.database + suffix).catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error })
    expect(bytes.includes(Buffer.from(secret))).toBe(false)
  }
})

it('Q05 旧正文 FTS 自动迁移后结果一致，数据库字节中也不残留旧正文', async () => {
  const f = fixture(), first = await f.query.search('审查证据'), marker = '旧正文迁移残留独占标记九六二', db = new DatabaseSync(f.database)
  try {
    db.exec("PRAGMA secure_delete=OFF; DROP TABLE page_search; CREATE VIRTUAL TABLE page_search USING fts5(page_id UNINDEXED,path UNINDEXED,title,aliases,identity,body);")
    db.prepare('INSERT INTO page_search(body) VALUES(?)').run((marker + ' ').repeat(3000))
    db.prepare('UPDATE page_index SET data=?').run(JSON.stringify({ content: marker }))
    db.prepare('INSERT INTO jobs VALUES(?,?)').run('kept-job', '{"status":"paused"}')
    db.prepare('INSERT INTO checkpoints VALUES(?,?,?,?)').run('kept-job', 0, 'kept-key', '{"complete":true}')
  } finally { db.close() }
  const result = await f.query.search('审查证据')
  expect(result.results).toEqual(first.results)
  const migrated = new DatabaseSync(f.database)
  try {
    expect(migrated.prepare("SELECT name FROM sqlite_master WHERE name='page_search_content'").all()).toEqual([])
    expect(migrated.prepare('SELECT header FROM jobs WHERE id=?').get('kept-job')).toEqual({ header: '{"status":"paused"}' })
    expect(migrated.prepare('SELECT json FROM checkpoints WHERE job_id=?').get('kept-job')).toEqual({ json: '{"complete":true}' })
    migrated.prepare('INSERT INTO metadata VALUES(?,?)').run('pageIndexCleanup', 'pending')
    await layeredIndex(f.root, 'index-read')
    expect(migrated.prepare("SELECT value FROM metadata WHERE key='pageIndexCleanup'").get()).toBeUndefined()
  } finally { migrated.close() }
  expect((await fs.readFile(f.database)).includes(Buffer.from(marker))).toBe(false)
  const wal = await fs.readFile(f.database + '-wal').catch(error => { if (error.code === 'ENOENT') return Buffer.alloc(0); throw error })
  expect(wal.includes(Buffer.from(marker))).toBe(false)
})
