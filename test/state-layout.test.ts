import { mkdir, readFile, readdir, rename, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { it, expect } from 'vitest'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { safePath, migrateDefaultStateLayout, withStateLayout } from '../src/storage/paths.js'
import { ChangeStore } from '../src/storage/changes.js'
import { temporaryWorkspace } from './temp.js'

it('默认成果根只用 state 保存状态，旧逻辑路径与新物理目录一致', async () => {
  const temp = await temporaryWorkspace()
  try {
    const library = newLibrary('layout'); library.wikiPath = path.join(temp.root, '.llmwiki')
    const registry = emptyRegistry(); registry.libraries = [library]
    const store = new LibraryStore(() => registry), policy = await store.initialize(library.id)
    expect(policy.initialized).toBe(true)
    expect(await readdir(library.wikiPath)).toEqual(['state'])
    expect(await safePath(library.wikiPath, '.llmwiki/policy.json')).toBe(path.join(library.wikiPath, 'state/policy.json'))
    const changes = new ChangeStore(store), batch = await changes.prepare(library.id, '布局验证', [{ path: 'concepts/a.md', content: '# 测试', expectedBefore: null }])
    await changes.commit(library.id, batch.id, batch.digest)
    expect(await readFile(path.join(library.wikiPath, 'concepts/a.md'), 'utf8')).toBe('# 测试')
    expect(await readdir(library.wikiPath)).not.toContain('.llmwiki')
    await expect(changes.prepare(library.id, '禁止状态页', [{ path: 'state/a.md', content: '# 不允许', expectedBefore: null }])).rejects.toThrow('状态区')
  } finally { await temp.cleanup() }
})

it('旧库迁移后身份策略与未提交批次仍可读取提交', async () => {
  const temp = await temporaryWorkspace()
  try {
    const library = newLibrary('migrated'); library.wikiPath = path.join(temp.root, '.llmwiki')
    await mkdir(path.join(library.wikiPath, '.llmwiki'), { recursive: true })
    const registry = emptyRegistry(); registry.libraries = [library]
    const store = new LibraryStore(() => registry), first = await store.initialize(library.id)
    const changes = new ChangeStore(store), batch = await changes.prepare(library.id, '旧布局预览', [{ path: 'concepts/old.md', content: '# 迁移前批次', expectedBefore: null }])
    expect(await migrateDefaultStateLayout(library.wikiPath)).toBe(true)
    expect(await migrateDefaultStateLayout(library.wikiPath)).toBe(false)
    expect((await store.policy(library.id)).revision).toBe(first.revision)
    await changes.commit(library.id, batch.id, batch.digest)
    expect(await readFile(path.join(library.wikiPath, 'concepts/old.md'), 'utf8')).toBe('# 迁移前批次')
    expect((await changes.list(library.id))[0]?.status).toBe('committed')
  } finally { await temp.cleanup() }
})

it('双状态目录拒绝读写，避免静默分叉', async () => {
  const temp = await temporaryWorkspace()
  try {
    await mkdir(path.join(temp.root, 'state')); await mkdir(path.join(temp.root, '.llmwiki'))
    await writeFile(path.join(temp.root, 'state/layout.json'), JSON.stringify({ version: 1, directory: 'state' }))
    await expect(safePath(temp.root, '.llmwiki/policy.json')).rejects.toThrow('两套状态目录')
  } finally { await temp.cleanup() }
})

it('操作内复用布局仍拒绝目标链接越界，下次操作重新识别布局', async () => {
  const temp = await temporaryWorkspace(), root = path.join(temp.root, 'library'), outside = path.join(temp.root, 'outside')
  try {
    await mkdir(path.join(root, 'objects'), { recursive: true }); await mkdir(outside)
    await withStateLayout(root, async () => {
      expect(await safePath(root, 'objects/a')).toBe(path.join(root, 'objects/a'))
      await rename(path.join(root, 'objects'), path.join(root, 'original-objects'))
      await symlink(outside, path.join(root, 'objects'), 'junction')
      await expect(safePath(root, 'objects/a')).rejects.toThrow('路径越出了当前数据库')
    })
    await mkdir(path.join(root, 'data'))
    await writeFile(path.join(root, 'data/layout.json'), JSON.stringify({ version: 2, directory: 'data' }))
    await withStateLayout(root, async () => {
      expect(await safePath(root, 'work/a')).toBe(path.join(root, 'data/work/a'))
    })
  } finally { await temp.cleanup() }
})
