import { parentPort } from 'node:worker_threads'
import { DatabaseSync } from 'node:sqlite'

// SQLite 在工作线程内执行；每次请求结束关闭句柄，避免 Windows 文件占用影响迁移和退出。
interface Row { ordinal: number; key: string; json: string }
interface Patch { id: string; header: string; chunks: Row[]; attempts: Row[]; checkpoints: Row[] }
interface IndexPage { path: string; stamp: string; data: string; title: string; aliases: string; identity: string; body: string }
interface Request { id: number; file: string; operation: 'initialize' | 'read' | 'summary' | 'save' | 'verify' | 'index-read' | 'index-save' | 'index-search'; libraryId?: string; patches?: Patch[]; pages?: IndexPage[]; removed?: string[]; query?: string }
const searchRevision = 'live-counts-v1', searchColumns = ['title', 'aliases', 'identity', 'body'] as const
function refreshSearch(db: DatabaseSync, pages: IndexPage[] = [], removed: string[] = []) {
  const replacements = new Map(pages.map(page => [page.path, page])), removals = new Set(removed)
  const rows = db.prepare('SELECT rowid,path FROM page_index').all() as { rowid: number; path: string }[]
  const retained = new Map(rows.filter(row => !replacements.has(row.path) && !removals.has(row.path))
    .map(row => [row.rowid, { path: row.path, title: [] as string[], aliases: [] as string[], identity: [] as string[], body: [] as string[] }]))
  // contentless 删除不会扣减 BM25 的累计统计；仅在内存恢复尚存词项，再整体刷新派生表。
  if (retained.size) {
    db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS temp.page_search_terms USING fts5vocab(main,page_search,instance)')
    for (const token of db.prepare('SELECT term,doc,col FROM temp.page_search_terms ORDER BY doc,col,offset').iterate() as Iterable<{ term: string; doc: number; col: typeof searchColumns[number] }>) {
      retained.get(token.doc)?.[token.col].push(token.term)
    }
  }
  const tokens = [...retained.values()].map(row => ({ path: row.path, ...Object.fromEntries(searchColumns.map(column => [column, row[column].join(' ')])) }))
  const remove = db.prepare('DELETE FROM page_index WHERE path=?')
  const insert = db.prepare('INSERT INTO page_index(path,stamp,data) VALUES(?,?,?) ON CONFLICT(path) DO UPDATE SET stamp=excluded.stamp,data=excluded.data')
  for (const relative of removals) remove.run(relative)
  for (const page of replacements.values()) insert.run(page.path, page.stamp, page.data)
  db.exec("INSERT INTO page_search(page_search) VALUES('delete-all')")
  const insertFts = db.prepare('INSERT INTO page_search(rowid,title,aliases,identity,body) VALUES((SELECT rowid FROM page_index WHERE path=?),?,?,?,?)')
  for (const page of [...tokens, ...replacements.values()]) insertFts.run(page.path, ...searchColumns.map(column => (page as Record<string, string>)[column]!))
}
parentPort!.on('message', (request: Request) => {
  let db: DatabaseSync | undefined
  try {
    const writing = request.operation === 'initialize' || request.operation === 'save' || request.operation.startsWith('index-')
    db = new DatabaseSync(request.file, { readOnly: !writing })
    db.exec('PRAGMA busy_timeout=3000; PRAGMA foreign_keys=ON; PRAGMA temp_store=MEMORY;')
    if (request.operation === 'initialize') {
      // 建表与身份登记一次提交，避免每张表各自触发 FULL 同步；中断时整批回滚。
      db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,header TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS chunks(job_id TEXT NOT NULL REFERENCES jobs(id),ordinal INTEGER NOT NULL,logical_key TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(job_id,ordinal),UNIQUE(job_id,logical_key));
        CREATE TABLE IF NOT EXISTS attempts(job_id TEXT NOT NULL REFERENCES jobs(id),ordinal INTEGER NOT NULL,logical_key TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(job_id,ordinal));
        CREATE TABLE IF NOT EXISTS checkpoints(job_id TEXT NOT NULL REFERENCES jobs(id),ordinal INTEGER NOT NULL,logical_key TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(job_id,ordinal),UNIQUE(job_id,logical_key));
        CREATE INDEX IF NOT EXISTS checkpoints_key ON checkpoints(logical_key);
        CREATE TABLE IF NOT EXISTS page_index(path TEXT PRIMARY KEY,stamp TEXT NOT NULL,data TEXT NOT NULL);
        CREATE VIRTUAL TABLE IF NOT EXISTS page_search USING fts5(title,aliases,identity,body,content='',contentless_delete=1,tokenize='unicode61');`)
      const owner = db.prepare("SELECT value FROM metadata WHERE key='libraryId'").get() as { value: string } | undefined
      if (owner && owner.value !== request.libraryId) throw new Error('SQLite 库身份不匹配。')
      db.prepare('INSERT OR IGNORE INTO metadata VALUES(?,?)').run('libraryId', request.libraryId!)
      db.prepare('INSERT OR IGNORE INTO metadata VALUES(?,?)').run('schemaVersion', '1')
      db.exec('COMMIT')
    }
    const metadata = new Map((db.prepare('SELECT key,value FROM metadata').all() as { key: string; value: string }[]).map(item => [item.key, item.value]))
    if (metadata.get('schemaVersion') !== '1' || request.libraryId && metadata.get('libraryId') !== request.libraryId) throw new Error('SQLite 版本或库身份不匹配。')
    if (request.operation === 'initialize' || request.operation.startsWith('index-')) {
      const schema = db.prepare("SELECT sql FROM sqlite_master WHERE name='page_search'").get() as { sql: string } | undefined
      if (!schema?.sql.includes('contentless_delete=1')) {
        // 只重建派生检索表，旧库的作业状态保持原样。
        db.exec(`PRAGMA secure_delete=ON; BEGIN IMMEDIATE; DROP TABLE IF EXISTS page_search; DELETE FROM page_index;
          CREATE VIRTUAL TABLE page_search USING fts5(title,aliases,identity,body,content='',contentless_delete=1,tokenize='unicode61');
          INSERT OR REPLACE INTO metadata VALUES('pageIndexCleanup','pending'); COMMIT;`)
      }
      if (db.prepare("SELECT 1 FROM metadata WHERE key='pageIndexCleanup'").get()) {
        // VACUUM 清理历史释放页；清空 WAL 后才算完成，崩溃重开仍会继续清理。
        db.exec('VACUUM;')
        const checkpoint = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get() as { busy: number }
        if (checkpoint.busy) throw new Error('旧正文索引清理等待其他读取结束，请重试。')
        db.exec("DELETE FROM metadata WHERE key='pageIndexCleanup';")
      }
      if (metadata.get('pageSearchRevision') !== searchRevision) {
        db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE;')
        try {
          // 锁内重查，避免多个进程重复修复同一缓存；作业及页面元数据保持不变。
          const revision = db.prepare("SELECT value FROM metadata WHERE key='pageSearchRevision'").get() as { value: string } | undefined
          if (revision?.value !== searchRevision) {
            refreshSearch(db)
            db.prepare('INSERT OR REPLACE INTO metadata VALUES(?,?)').run('pageSearchRevision', searchRevision)
          }
          db.exec('COMMIT')
        } catch (error) { db.exec('ROLLBACK'); throw error }
      }
    }
    let value: unknown = null
    if (request.operation === 'index-read') {
      value = db.prepare('SELECT path,stamp,data FROM page_index').all()
    } else if (request.operation === 'index-search') {
      value = request.query ? db.prepare('SELECT p.path,-bm25(page_search,7,5,3,1) AS score FROM page_search JOIN page_index p ON p.rowid=page_search.rowid WHERE page_search MATCH ? ORDER BY score DESC,p.path LIMIT 200').all(request.query) : []
    } else if (request.operation === 'index-save') {
      db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE;')
      try {
        const current = new Map((db.prepare('SELECT path,stamp,data FROM page_index').all() as Pick<IndexPage, 'path' | 'stamp' | 'data'>[]).map(page => [page.path, page]))
        if (request.removed?.some(relative => current.has(relative)) || request.pages?.some(page => current.get(page.path)?.stamp !== page.stamp || current.get(page.path)?.data !== page.data)) {
          refreshSearch(db, request.pages, request.removed)
        }
        db.exec('COMMIT')
      } catch (error) { db.exec('ROLLBACK'); throw error }
    } else if (request.operation === 'save') {
      db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE;')
      try {
        const job = db.prepare('INSERT INTO jobs(id,header) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET header=excluded.header')
        const statements = new Map(['chunks', 'attempts', 'checkpoints'].map(table => [table, db!.prepare(`INSERT INTO ${table}(job_id,ordinal,logical_key,json) VALUES(?,?,?,?) ON CONFLICT(job_id,ordinal) DO UPDATE SET logical_key=excluded.logical_key,json=excluded.json`)]))
        let bytes = 0, rows = 0
        for (const patch of request.patches ?? []) {
          job.run(patch.id, patch.header); bytes += Buffer.byteLength(patch.header); rows++
          for (const table of ['chunks', 'attempts', 'checkpoints'] as const) for (const row of patch[table]) {
            statements.get(table)!.run(patch.id, row.ordinal, row.key, row.json)
            bytes += Buffer.byteLength(row.json); rows++
          }
        }
        db.exec('COMMIT'); value = { bytes, rows }
      } catch (error) { db.exec('ROLLBACK'); throw error }
    } else if (request.operation === 'summary') {
      db.exec('BEGIN;')
      value=(db.prepare('SELECT id,header FROM jobs').all() as {id:string;header:string}[]).map(row=>{
        const chunks=db!.prepare("SELECT json_extract(json,'$.status') AS status,json_extract(json,'$.error') AS error FROM chunks WHERE job_id=? ORDER BY ordinal").all(row.id)
        const attempt=db!.prepare('SELECT json FROM attempts WHERE job_id=? ORDER BY ordinal DESC LIMIT 1').get(row.id) as {json:string}|undefined
        return {...JSON.parse(row.header),chunks,attempts:attempt?[JSON.parse(attempt.json)]:[]}
      })
      db.exec('COMMIT')
    } else if (request.operation === 'read') {
      db.exec('BEGIN;')
      value = (db.prepare('SELECT id,header FROM jobs').all() as { id: string; header: string }[]).map(row => {
        const parts = (table: string) => (db!.prepare(`SELECT json FROM ${table} WHERE job_id=? ORDER BY ordinal`).all(row.id) as { json: string }[]).map(part => JSON.parse(part.json))
        return { ...JSON.parse(row.header), chunks: parts('chunks'), attempts: parts('attempts'), synthesis: parts('checkpoints') }
      })
      db.exec('COMMIT')
    } else if (request.operation === 'verify') {
      value = { integrity: db.prepare('PRAGMA integrity_check').get(), foreignKeys: db.prepare('PRAGMA foreign_key_check').all(), metadata: db.prepare('SELECT * FROM metadata').all() }
    }
    db.close(); db = undefined
    parentPort!.postMessage({ id: request.id, value })
  } catch (error) {
    try { db?.close() } catch { /* 原始错误由调用方报告。 */ }
    parentPort!.postMessage({ id: request.id, error:{message:error instanceof Error?error.message:String(error),
      code:error instanceof Error&&'code'in error?String(error.code):'ERR_SQLITE_WORKER',operation:request.operation,file:request.file} })
  }
})
