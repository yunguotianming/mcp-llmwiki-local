import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { pathToFileURL } from 'node:url'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { ChangeStore, nativePageWriter } from '../src/storage/changes.js'
import { signature } from '../src/storage/files.js'
import { withLibraryLock, releaseExitedLock, inspectLock } from '../src/storage/lock.js'
import { temporaryWorkspace } from './temp.js'
import { cleanupLayeredFixtures, mockFixtureSync } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

async function fixture() {
  const temp = await temporaryWorkspace(), library = newLibrary('changes')
  mockFixtureSync(temp.root)
  library.wikiPath = temp.root
  const registry = emptyRegistry(); registry.libraries = [library]
  const libraries = new LibraryStore(() => registry); await libraries.initialize(library.id)
  return { ...temp, library, libraries, changes: new ChangeStore(libraries) }
}
const proposal = (file: string, content: string, before: string | null = null) => ({path:file, content, expectedBefore:before === null ? null : signature(before)})
describe('签名批次与条件恢复', () => {
  it('已提交批次通过逆向预览撤销，包含首次创建的知识状态，确认前保留现状',async()=>{
    const f=await fixture()
    try{
      const original=await f.changes.prepare(f.library.id,'首次生成',[proposal('one.md','新内容'),{path:'.llmwiki/knowledge/catalog.json',area:'state',content:'{"version":1,"pages":[]}',expectedBefore:null}])
      await f.changes.commit(f.library.id,original.id,original.digest)
      const inverse=await f.changes.prepareRevert(f.library.id,original.id,original.digest)
      expect(await readFile(path.join(f.root,'one.md'),'utf8')).toBe('新内容')
      expect((await f.changes.preview(f.library.id,inverse.id)).pages.every(page=>page.after===null)).toBe(true)
      await f.changes.commit(f.library.id,inverse.id,inverse.digest)
      await expect(readFile(path.join(f.root,'one.md'))).rejects.toThrow()
      await expect(readFile(path.join(f.root,'.llmwiki/knowledge/catalog.json'))).rejects.toThrow()
    }finally{await f.cleanup()}
  })
  it('后续人工修改阻止撤销；取消预览不改文件且不可再提交',async()=>{
    const f=await fixture()
    try{
      const first=await f.changes.prepare(f.library.id,'生成',[proposal('one.md','新内容')]);await f.changes.commit(f.library.id,first.id,first.digest)
      await writeFile(path.join(f.root,'one.md'),'人工编辑')
      await expect(f.changes.prepareRevert(f.library.id,first.id,first.digest)).rejects.toThrow('后续修改')
      const pending=await f.changes.prepare(f.library.id,'待取消',[proposal('two.md','不会写入')])
      expect((await f.changes.cancel(f.library.id,pending.id,pending.digest)).status).toBe('cancelled')
      await expect(f.changes.commit(f.library.id,pending.id,pending.digest)).rejects.toThrow('当前不能提交')
      await expect(readFile(path.join(f.root,'two.md'))).rejects.toThrow()
    }finally{await f.cleanup()}
  })
  it('提交逐字节使用预览版本，重复提交幂等', async () => {
    const f = await fixture()
    try {
      const content = '---\ntitle: 测试\n---\n# 测试\n\n[[概念]]\n'
      const batch = await f.changes.prepare(f.library.id, '生成', [proposal('entities/a.md', content)])
      expect((await f.changes.preview(f.library.id, batch.id)).pages[0]?.after).toBe(content)
      await expect(f.changes.commit(f.library.id, batch.id, 'wrong')).rejects.toThrow('不匹配')
      expect((await f.changes.commit(f.library.id, batch.id, batch.digest)).status).toBe('committed')
      expect(await readFile(path.join(f.root, 'entities/a.md'), 'utf8')).toBe(content)
      expect((await f.changes.commit(f.library.id, batch.id, batch.digest)).status).toBe('committed')
    } finally { await f.cleanup() }
  })
  it('分析期间变更或预览后新增目标出现时整批拒绝', async () => {
    const f = await fixture()
    try {
      await writeFile(path.join(f.root, 'index.md'), '人工内容')
      await expect(f.changes.prepare(f.library.id, '生成', [proposal('index.md', '新内容', '旧内容')])).rejects.toThrow('分析期间')
      const batch = await f.changes.prepare(f.library.id, '生成', [proposal('index.md', '新内容', '人工内容'), proposal('new.md', '新增')])
      await writeFile(path.join(f.root, 'new.md'), '其他进程创建')
      await expect(f.changes.commit(f.library.id, batch.id, batch.digest)).rejects.toThrow('整个批次失效')
      expect(await readFile(path.join(f.root, 'index.md'), 'utf8')).toBe('人工内容')
    } finally { await f.cleanup() }
  })
  it('模型完成后策略变化使确认失效', async () => {
    const f = await fixture()
    try {
      const batch = await f.changes.prepare(f.library.id, '生成', [proposal('index.md', '新内容')])
      const policy = await f.libraries.policy(f.library.id)
      await f.libraries.savePolicy(f.library.id, {...policy.policy,wikiLanguage:'zh'},policy.revision)
      await expect(f.changes.commit(f.library.id, batch.id, batch.digest)).rejects.toThrow('配置或库版本')
    } finally { await f.cleanup() }
  })
  it('半提交阻断后续写入，按真实签名回滚而非只信日志', async () => {
    const f = await fixture()
    try {
      await writeFile(path.join(f.root, 'one.md'), '原内容')
      const batch = await f.changes.prepare(f.library.id, '生成', [proposal('one.md', '更新', '原内容'), proposal('two.md', '新增')])
      const failing = new ChangeStore(f.libraries, {async write(root, page, bytes) {
        await nativePageWriter.write(root,page,bytes)
        if (page.path === 'two.md') throw new Error('模拟写后崩溃')
      }})
      await expect(failing.commit(f.library.id,batch.id,batch.digest)).rejects.toThrow('模拟写后崩溃')
      await expect(withLibraryLock(f.root,'normal',async () => {})).rejects.toThrow('未完成提交')
      expect((await f.changes.recover(f.library.id,batch.id,batch.digest)).status).toBe('rolled-back')
      expect(await readFile(path.join(f.root,'one.md'),'utf8')).toBe('原内容')
      await expect(readFile(path.join(f.root,'two.md'))).rejects.toThrow()
      await expect(withLibraryLock(f.root,'normal',async () => 'ok')).resolves.toBe('ok')
    } finally { await f.cleanup() }
  })
  it('恢复发现人工改动时保留整批现场', async () => {
    const f = await fixture()
    try {
      const batch = await f.changes.prepare(f.library.id,'生成',[proposal('one.md','生成内容'),proposal('two.md','新增')])
      const failing = new ChangeStore(f.libraries,{async write(root,page,bytes) { if(page.path === 'two.md') throw new Error('中断'); await nativePageWriter.write(root,page,bytes) }})
      await expect(failing.commit(f.library.id,batch.id,batch.digest)).rejects.toThrow('中断')
      await writeFile(path.join(f.root,'one.md'),'人工编辑')
      await expect(f.changes.recover(f.library.id,batch.id,batch.digest)).rejects.toThrow('外部修改')
      expect(await readFile(path.join(f.root,'one.md'),'utf8')).toBe('人工编辑')
    } finally { await f.cleanup() }
  })
  it('活进程的锁不能按超时或用户点击强制释放', async () => {
    const f = await fixture()
    try { await withLibraryLock(f.root,'live',async () => {
      const lock = await inspectLock(f.root)
      await expect(releaseExitedLock(f.root,lock!.ownerToken)).rejects.toThrow('仍然存在')
    }) } finally { await f.cleanup() }
  })
  it('两个独立进程使用相同路径互斥，遗留锁需确认身份后释放', async () => {
    const f = await fixture()
    const module = pathToFileURL(path.resolve('dist/storage/lock.js')).href
    const start = (mode: string) => spawn(process.execPath,['--input-type=module','-e',`
      import {withLibraryLock} from ${JSON.stringify(module)};
      try { await withLibraryLock(process.argv[1],process.argv[2],async()=>{
        process.send('locked'); if(process.argv[2]==='hold') await new Promise(r=>process.once('message',r));
      }); process.exit(0) } catch(e) { process.send(String(e.message)); process.exit(2) }
    `, f.root, mode],{stdio:['ignore','pipe','pipe','ipc']})
    const owner = start('hold')
    try {
      expect((await once(owner,'message'))[0]).toBe('locked')
      const contender = start('contender'), result = once(contender,'exit')
      expect((await once(contender,'message'))[0]).toContain('写锁'); expect((await result)[0]).toBe(2)
      const exited = once(owner,'exit'); owner.kill(); await exited
      const lock = await inspectLock(f.root); expect(lock).not.toBeNull()
      await releaseExitedLock(f.root,lock!.ownerToken)
      await expect(withLibraryLock(f.root,'next',async () => 'ok')).resolves.toBe('ok')
    } finally { if (owner.exitCode === null) owner.kill(); await f.cleanup() }
  })
})
