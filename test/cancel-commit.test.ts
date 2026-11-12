import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { ChangeStore, nativePageWriter } from '../src/storage/changes.js'
import { withLibraryLock } from '../src/storage/lock.js'
import { temporaryWorkspace } from './temp.js'
import { cleanupLayeredFixtures, mockFixtureSync } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

const hook=vi.hoisted(()=>({afterState:undefined as ((relative:string)=>void)|undefined}))
vi.mock('../src/storage/files.js',async original=>{
  const files=await original<typeof import('../src/storage/files.js')>()
  return {...files,async writeState(root:string,relative:string,value:unknown){await files.writeState(root,relative,value);hook.afterState?.(relative)}}
})
afterEach(()=>{hook.afterState=undefined;cleanupLayeredFixtures()})
async function fixture(){
  const temp=await temporaryWorkspace(),library=newLibrary('cancellation');library.wikiPath=temp.root
  mockFixtureSync(temp.root)
  const registry=emptyRegistry();registry.libraries=[library]
  const store=new LibraryStore(()=>registry),changes=new ChangeStore(store);await store.initialize(library.id)
  const batch=await changes.prepare(library.id,'取消提交夹具',[{path:'one.md',content:'第一个页面',expectedBefore:null},{path:'two.md',content:'第二个页面',expectedBefore:null}])
  return {...temp,library,store,changes,batch,abort:new AbortController()}
}
it('恢复标记落盘后、尚未进入任何页面写入时取消，保留待确认批次且释放恢复阻断',async()=>{
  const f=await fixture(),write=vi.fn(nativePageWriter.write)
  try{
    hook.afterState=relative=>{if(relative==='.llmwiki/coordination/recovery.json')f.abort.abort(new Error('用户取消'))}
    const changes=new ChangeStore(f.store,{write})
    await expect(changes.commit(f.library.id,f.batch.id,f.batch.digest,f.abort.signal)).rejects.toThrow('用户取消')
    expect(write).not.toHaveBeenCalled()
    expect((await changes.preview(f.library.id,f.batch.id)).batch.status).toBe('preview')
    await expect(readFile(path.join(f.root,'.llmwiki/coordination/recovery.json'))).rejects.toThrow()
    await expect(withLibraryLock(f.root,'next',async()=>true)).resolves.toBe(true)
    hook.afterState=undefined
    expect((await changes.commit(f.library.id,f.batch.id,f.batch.digest)).status).toBe('committed')
  }finally{await f.cleanup()}
})
it('已写入一个页面后取消，保留逐页结果并阻断普通写入，恢复删除新建页',async()=>{
  const f=await fixture()
  try{
    const changes=new ChangeStore(f.store,{async write(root,page,bytes){await nativePageWriter.write(root,page,bytes);f.abort.abort(new Error('用户取消'))}})
    await expect(changes.commit(f.library.id,f.batch.id,f.batch.digest,f.abort.signal)).rejects.toThrow('用户取消')
    expect((await changes.preview(f.library.id,f.batch.id)).batch).toMatchObject({status:'recovery',written:['one.md']})
    await expect(withLibraryLock(f.root,'next',async()=>true)).rejects.toThrow('未完成提交')
    await f.changes.recover(f.library.id,f.batch.id,f.batch.digest)
    await expect(readFile(path.join(f.root,'one.md'))).rejects.toThrow()
  }finally{await f.cleanup()}
})
it('写入器已改文件但未返回结果时取消，即使 written 为空也保留恢复保护',async()=>{
  const f=await fixture()
  try{
    const changes=new ChangeStore(f.store,{async write(root,page,bytes){await nativePageWriter.write(root,page,bytes);f.abort.abort(new Error('写入期间取消'));f.abort.signal.throwIfAborted()}})
    await expect(changes.commit(f.library.id,f.batch.id,f.batch.digest,f.abort.signal)).rejects.toThrow('写入期间取消')
    expect((await changes.preview(f.library.id,f.batch.id)).batch).toMatchObject({status:'recovery',written:[]})
    await expect(withLibraryLock(f.root,'next',async()=>true)).rejects.toThrow('未完成提交')
    await f.changes.recover(f.library.id,f.batch.id,f.batch.digest)
    await expect(readFile(path.join(f.root,'one.md'))).rejects.toThrow()
  }finally{await f.cleanup()}
})
