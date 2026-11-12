import { expect, it } from 'vitest'
import { DatabaseSync } from 'node:sqlite'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { migrateJobStorage, readGenerateJobs } from '../src/storage/jobs.js'
import { temporaryWorkspace } from './temp.js'

it('初始化身份不符时整批建表回滚，修正身份后可重新初始化', async () => {
  const temp = await temporaryWorkspace(), state = path.join(temp.root, '.llmwiki')
  try {
    await mkdir(state)
    await writeFile(path.join(state, 'library.json'), JSON.stringify({ libraryId: 'expected' }))
    const file = path.join(state, 'wiki.sqlite'), initial = new DatabaseSync(file)
    try {
      initial.exec("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO metadata VALUES('libraryId','other');")
    } finally { initial.close() }
    await expect(migrateJobStorage(temp.root, 'expected')).rejects.toThrow('SQLite 库身份不匹配')
    await expect(readFile(path.join(state, 'storage.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    const failed = new DatabaseSync(file)
    try {
      expect(failed.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()).toEqual([{ name: 'metadata' }])
      expect(failed.prepare("SELECT value FROM metadata WHERE key='libraryId'").get()).toEqual({ value: 'other' })
      failed.exec("UPDATE metadata SET value='expected' WHERE key='libraryId'")
    } finally { failed.close() }
    expect(await migrateJobStorage(temp.root, 'expected')).toMatchObject({ imported: true, jobs: 0 })
    expect(await readGenerateJobs(temp.root)).toEqual([])
  } finally { await temp.cleanup() }
})
