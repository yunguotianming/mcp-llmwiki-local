import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { ChangeStore, nativePageWriter } from '../src/storage/changes.js'
import { checkWiki, prepareMaintenance } from '../src/wiki/maintenance.js'
import { temporaryWorkspace } from './temp.js'
import { mockFixtureSync } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => vi.restoreAllMocks())
async function fixture() {
  const temp = await temporaryWorkspace(), library = newLibrary('maintenance'); library.wikiPath = temp.root
  mockFixtureSync(temp.root)
  const registry = emptyRegistry(); registry.libraries = [library]
  const store = new LibraryStore(() => registry); await store.initialize(library.id)
  await mkdir(path.join(temp.root, 'concepts'))
  const put = (name: string, raw: string) => writeFile(path.join(temp.root, name), raw)
  return { ...temp, library, store, put, changes: new ChangeStore(store) }
}
describe('程序检查和批次维护', () => {
  it('只读诊断格式、死链、空页、孤立页，排除代码及图片资源，含糊别名不自动修复', async () => {
    const f = await fixture()
    try {
      await f.put('concepts/a.md', '---\ntitle: 方法 A\naliases: [同名]\n---\n正文 [[待补概念]] [无效](missing.md) [文档](https://example.com) ![图](asset.png)\n\n`[[代码链接]]`\n\n```md\n[x](code.md)\n```\n')
      await f.put('concepts/b.md', '---\naliases: [同名]\n---\n# B\n\n[[同名]]\n')
      await f.put('concepts/empty.md', '# 空页\n')
      await f.put('concepts/bad.md', '---\ntitle: [\n---\n正文')
      const report = await checkWiki(f.store, f.library.id)
      expect(report.pageCount).toBe(4)
      expect(report.issues.map(issue => issue.kind)).toEqual(expect.arrayContaining(['format', 'broken-link', 'empty', 'orphan', 'ambiguous-link']))
      expect(report.issues.some(issue => /代码链接|code\.md|asset\.png|example\.com/.test(issue.message))).toBe(false)
      expect(await f.changes.list(f.library.id)).toEqual([])
      const batch = await prepareMaintenance(f.store, f.library.id, report.revision, 'repair')
      expect(batch.pages.map(page => page.path)).toEqual(expect.arrayContaining(['concepts/a.md', 'concepts/待补概念.md', 'concepts/missing.md']))
      await expect(readFile(path.join(f.root, 'concepts/待补概念.md'))).rejects.toThrow()
      await f.changes.commit(f.library.id, batch.id, batch.digest)
      expect(await readFile(path.join(f.root, 'concepts/a.md'), 'utf8')).toContain('# 方法 A\n\n正文')
      expect((await checkWiki(f.store, f.library.id)).issues.filter(issue => issue.kind === 'broken-link')).toEqual([])
      expect(await readFile(path.join(f.root, 'concepts/bad.md'), 'utf8')).toBe('---\ntitle: [\n---\n正文')
    } finally { await f.cleanup() }
  })
  it('预览绑定目录与策略，新增页面或确认前人工修改会使整个批次失效', async () => {
    const f = await fixture()
    try {
      await f.put('concepts/a.md', '# A\n\n正文\n')
      let report = await checkWiki(f.store, f.library.id)
      await f.put('concepts/new.md', '# 新页\n\n正文')
      await expect(prepareMaintenance(f.store, f.library.id, report.revision, 'index')).rejects.toThrow('已变化')
      report = await checkWiki(f.store, f.library.id)
      const batch = await prepareMaintenance(f.store, f.library.id, report.revision, 'index')
      await f.put('concepts/later.md', '# 后增页\n\n正文')
      await expect(f.changes.commit(f.library.id, batch.id, batch.digest)).rejects.toThrow('依据目录已变化')
      await expect(readFile(path.join(f.root, 'index.md'))).rejects.toThrow()
    } finally { await f.cleanup() }
  })
  it('索引保留人工内容并排除无依据占位页，历史可读，半提交可恢复', async () => {
    const f = await fixture()
    try {
      await f.put('concepts/a.md', '# 活动知识\n\n正文')
      await f.put('concepts/stub.md', '---\nllmwikiNoActiveEvidence: true\n---\n# 待补\n\n缺少依据')
      await f.put('index.md', '# 人工导航\n\n保留这一段。\n')
      const report = await checkWiki(f.store, f.library.id), batch = await prepareMaintenance(f.store, f.library.id, report.revision, 'index')
      const interrupted = new ChangeStore(f.store, { async write(root, page, bytes) { await nativePageWriter.write(root, page, bytes); throw new Error('模拟中断') } })
      await expect(interrupted.commit(f.library.id, batch.id, batch.digest)).rejects.toThrow('模拟中断')
      await f.changes.recover(f.library.id, batch.id, batch.digest)
      expect(await readFile(path.join(f.root, 'index.md'), 'utf8')).toBe('# 人工导航\n\n保留这一段。\n')
      const next = await prepareMaintenance(f.store, f.library.id, (await checkWiki(f.store, f.library.id)).revision, 'index')
      await f.changes.commit(f.library.id, next.id, next.digest)
      const content = await readFile(path.join(f.root, 'index.md'), 'utf8')
      expect(content).toContain('保留这一段。'); expect(content).toContain('concepts/a.md'); expect(content).not.toContain('concepts/stub.md')
      const welcome = await prepareMaintenance(f.store, f.library.id, (await checkWiki(f.store, f.library.id)).revision, 'welcome')
      await f.changes.commit(f.library.id, welcome.id, welcome.digest)
      expect(await readFile(path.join(f.root, 'welcome.md'), 'utf8')).toContain('原始资料目录保持只读')
      const index = await prepareMaintenance(f.store, f.library.id, (await checkWiki(f.store, f.library.id)).revision, 'index')
      const preview = await f.changes.preview(f.library.id, index.id)
      expect(preview.pages.find(page => page.path === 'log.md')?.after).toContain(welcome.id)
    } finally { await f.cleanup() }
  })
  it('关闭占位页策略后不补造目标；只读库可以检查且拒绝修复', async () => {
    const f = await fixture()
    try {
      await f.put('concepts/a.md', '# A\n\n[[待补]]\n')
      const policy = await f.store.policy(f.library.id)
      await f.store.savePolicy(f.library.id, { ...policy.policy, createStubsForUnresolvableLinks: false }, policy.revision)
      expect((await checkWiki(f.store, f.library.id)).issues.some(issue => issue.repairable)).toBe(false)
      await expect(prepareMaintenance(f.store, f.library.id, (await checkWiki(f.store, f.library.id)).revision, 'repair')).rejects.toThrow('不能为空')
      f.library.kind = 'obsidian'; f.library.mode = 'readonly'
      expect((await checkWiki(f.store, f.library.id)).pageCount).toBe(1)
      await expect(prepareMaintenance(f.store, f.library.id, (await checkWiki(f.store, f.library.id)).revision, 'repair')).rejects.toThrow('只读')
    } finally { await f.cleanup() }
  })
  it('非法编码链接只报告，空标题回退文件名，索引追加生成区保留原文全部字节', async () => {
    const f = await fixture()
    try {
      await f.put('concepts/a.md', '---\ntitle: " "\n---\n正文 [坏链接](%E0%A4%A.md)\n')
      const original = '# 人工索引\r\n\r\n保留 Markdown 换行。  \r\n'
      await f.put('index.md', original)
      const report = await checkWiki(f.store, f.library.id)
      expect(report.issues.find(issue => issue.kind === 'broken-link')?.repairable).toBe(false)
      const repair = await prepareMaintenance(f.store, f.library.id, report.revision, 'repair')
      expect(repair.pages.map(page => page.path)).toEqual(['concepts/a.md'])
      await f.changes.commit(f.library.id, repair.id, repair.digest)
      expect(await readFile(path.join(f.root, 'concepts/a.md'), 'utf8')).toContain('# a\n\n正文')
      const index = await prepareMaintenance(f.store, f.library.id, (await checkWiki(f.store, f.library.id)).revision, 'index')
      await f.changes.commit(f.library.id, index.id, index.digest)
      expect((await readFile(path.join(f.root, 'index.md'), 'utf8')).startsWith(original)).toBe(true)
    } finally { await f.cleanup() }
  })
})
