import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { ChangeStore, nativePageWriter } from '../src/storage/changes.js'
import { signature } from '../src/storage/files.js'
import { withLibraryLock } from '../src/storage/lock.js'
import { temporaryWorkspace } from './temp.js'
import { cleanupLayeredFixtures, mockFixtureSync } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

async function fixture() {
  const temp = await temporaryWorkspace(), root = path.join(temp.root, 'wiki')
  mockFixtureSync(temp.root)
  await mkdir(path.join(temp.root, '.obsidian')); await mkdir(root)
  await writeFile(path.join(temp.root, '.llm-wiki-databases.json'), JSON.stringify({ version: 1, vaultId: null,
    databases: [{ name: '共管测试库', wikiFolder: 'wiki', dshEnabled: true }] }))
  const library = newLibrary('shared'); library.kind = 'obsidian'; library.mode = 'shared'
  library.wikiPath = root; library.vaultPath = temp.root
  const registry = emptyRegistry(); registry.libraries = [library]
  const libraries = new LibraryStore(() => registry), changes = new ChangeStore(libraries)
  const handshake = async (capabilities = ['conditional-write', 'generation', 'recovery']) => {
    await mkdir(path.join(root, '.llmwiki/coordination'), { recursive: true })
    await writeFile(path.join(root, '.llmwiki/coordination/obsidian.json'), JSON.stringify({ protocolVersion: 1,
      writer: 'obsidian-llm-wiki-local', capabilities }))
  }
  return { ...temp, root, library, libraries, changes, handshake }
}

describe('Obsidian 共管协议', () => {
  it('未升级或能力不完整时保留查询并拒绝写入', async () => {
    const f = await fixture()
    try {
      expect((await f.libraries.policy(f.library.id)).writable).toBe(false)
      await expect(f.libraries.initialize(f.library.id)).rejects.toThrow('Obsidian')
      await expect(readFile(path.join(f.root, '.llmwiki/library.json'))).rejects.toThrow()
      expect(JSON.parse(await readFile(path.join(f.root, '.llmwiki/coordination/request.json'), 'utf8'))).toEqual({ protocolVersion: 1, writer: 'dsh-llmwiki' })
      await f.handshake(['generation'])
      await expect(f.libraries.initialize(f.library.id)).rejects.toThrow('协议')
    } finally { await f.cleanup() }
  })

  it('兼容端已确认后不依赖 Obsidian 进程，更新、撤销均按签名提交', async () => {
    const f = await fixture()
    try {
      await f.handshake(); expect((await f.libraries.initialize(f.library.id)).writable).toBe(true)
      await writeFile(path.join(f.root, 'index.md'), '原有索引')
      const batch = await f.changes.prepare(f.library.id, '共管更新', [
        { path: 'index.md', content: '更新索引', expectedBefore: signature('原有索引') },
        { path: 'concepts/a.md', content: '# 新知识', expectedBefore: null },
      ])
      await f.changes.commit(f.library.id, batch.id, batch.digest)
      expect(await readFile(path.join(f.root, 'index.md'), 'utf8')).toBe('更新索引')
      const revert = await f.changes.prepareRevert(f.library.id, batch.id, batch.digest)
      await f.changes.commit(f.library.id, revert.id, revert.digest)
      expect(await readFile(path.join(f.root, 'index.md'), 'utf8')).toBe('原有索引')
      await expect(readFile(path.join(f.root, 'concepts/a.md'))).rejects.toThrow()
    } finally { await f.cleanup() }
  })

  it('他方持锁或代次变化阻止旧预览，已撤回兼容能力时不再写入', async () => {
    const f = await fixture()
    try {
      await f.handshake(); await f.libraries.initialize(f.library.id)
      const batch = await f.changes.prepare(f.library.id, '待提交', [{ path: 'a.md', content: '# 知识', expectedBefore: null }])
      await withLibraryLock(f.root, 'obsidian', async () => {
        await expect(f.changes.commit(f.library.id, batch.id, batch.digest)).rejects.toThrow('写锁')
      })
      await writeFile(path.join(f.root, '.llmwiki/coordination/generation.json'), JSON.stringify({ value: 1, batchId: 'obsidian-test' }))
      await expect(f.changes.commit(f.library.id, batch.id, batch.digest)).rejects.toThrow('库版本')
      await rm(path.join(f.root, '.llmwiki/coordination/obsidian.json'))
      expect((await f.libraries.policy(f.library.id)).writable).toBe(false)
      await expect(f.changes.prepare(f.library.id, '拒绝', [{ path: 'b.md', content: '# 内容', expectedBefore: null }])).rejects.toThrow('Obsidian')
      await expect(readFile(path.join(f.root, 'a.md'))).rejects.toThrow()
    } finally { await f.cleanup() }
  })

  it('共享清单撤出和身份错配均拒绝写入', async () => {
    const f = await fixture()
    try {
      await f.handshake(); await f.libraries.initialize(f.library.id)
      await writeFile(path.join(f.root, '.llmwiki/library.json'), JSON.stringify({ libraryId: 'another', formatVersion: 1, protocolVersion: 1 }))
      await expect(f.libraries.root(f.library.id, true)).rejects.toThrow('库身份')
      await writeFile(path.join(f.root, '.llmwiki/library.json'), JSON.stringify({ libraryId: f.library.id, formatVersion: 1, protocolVersion: 1 }))
      await writeFile(path.join(f.library.vaultPath, '.llm-wiki-databases.json'), JSON.stringify({ version: 1, databases: [] }))
      await expect(f.libraries.root(f.library.id, true)).rejects.toThrow('共享清单')
    } finally { await f.cleanup() }
  })

  it('提交中从共享清单移除该库后，停止后续页并保留条件恢复', async () => {
    const f = await fixture()
    try {
      await f.handshake(); await f.libraries.initialize(f.library.id)
      const manifestPath = path.join(f.library.vaultPath, '.llm-wiki-databases.json'), manifest = await readFile(manifestPath, 'utf8')
      const batch = await f.changes.prepare(f.library.id, '两页更新', [
        { path: 'a.md', content: '# 第一页', expectedBefore: null },
        { path: 'b.md', content: '# 第二页', expectedBefore: null },
      ])
      const changing = new ChangeStore(f.libraries, { async write(root, page, bytes) {
        await nativePageWriter.write(root, page, bytes)
        if (page.path === 'a.md') await writeFile(manifestPath, JSON.stringify({ version: 1, vaultId: null, databases: [] }))
      } })
      await expect(changing.commit(f.library.id, batch.id, batch.digest)).rejects.toThrow('共享清单')
      expect(await readFile(path.join(f.root, 'a.md'), 'utf8')).toBe('# 第一页')
      await expect(readFile(path.join(f.root, 'b.md'))).rejects.toThrow()
      expect((await f.changes.preview(f.library.id, batch.id)).batch.status).toBe('recovery')
      await writeFile(manifestPath, manifest)
      await f.changes.recover(f.library.id, batch.id, batch.digest)
      await expect(readFile(path.join(f.root, 'a.md'))).rejects.toThrow()
    } finally { await f.cleanup() }
  })

  it('共享清单的 dshEnabled 只控制参与查询，不改变已选共管方式', async () => {
    const f = await fixture()
    try {
      await f.handshake()
      await writeFile(path.join(f.library.vaultPath, '.llm-wiki-databases.json'), JSON.stringify({ version: 1, vaultId: null,
        databases: [{ name: '共管测试库', wikiFolder: 'wiki', dshEnabled: false }] }))
      expect((await f.libraries.initialize(f.library.id)).writable).toBe(true)
    } finally { await f.cleanup() }
  })

  it('另一端半提交时明确指向对应恢复入口，不接管其恢复记录', async () => {
    const f = await fixture()
    try {
      await f.handshake(); await f.libraries.initialize(f.library.id)
      const marker = JSON.stringify({ protocolVersion: 1, writer: 'obsidian-llm-wiki-local', batchId: 'obsidian-test' })
      await writeFile(path.join(f.root, '.llmwiki/coordination/recovery.json'), marker)
      await expect(f.changes.prepare(f.library.id, '拒绝', [{ path: 'a.md', content: '# 内容', expectedBefore: null }])).rejects.toThrow('请回 Obsidian')
      expect(await readFile(path.join(f.root, '.llmwiki/coordination/recovery.json'), 'utf8')).toBe(marker)
      await expect(readFile(path.join(f.root, 'a.md'))).rejects.toThrow()
    } finally { await f.cleanup() }
  })
})
