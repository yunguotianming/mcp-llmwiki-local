import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import type { SourceRecord } from '../src/ingest/scanner.js'
import type { KnowledgeCatalog, KnowledgePage } from '../src/wiki/documents.js'
import { blockSignature, renderKnowledge } from '../src/wiki/documents.js'
import { listArchive, prepareArchiveCleanup, prepareSourceState } from '../src/wiki/sources.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { ChangeStore, nativePageWriter } from '../src/storage/changes.js'
import { signature, writeState } from '../src/storage/files.js'
import { temporaryWorkspace } from './temp.js'
import { mockFixtureSync } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => vi.restoreAllMocks())

async function fixture(withKnowledge=true) {
  const temp=await temporaryWorkspace(),source=path.join(temp.root,'source'),root=path.join(temp.root,'wiki')
  mockFixtureSync(temp.root)
  await mkdir(source)
  const library=newLibrary('archive');library.wikiPath=root;library.sourceRoots=[source]
  const registry=emptyRegistry();registry.libraries=[library]
  const store=new LibraryStore(()=>registry),changes=new ChangeStore(store);await store.initialize(library.id)
  const records:SourceRecord[]=[]
  for(const id of ['a','b']){
    const absolutePath=path.join(source,id+'.md'),text='资料 '+id
    await writeFile(absolutePath,text)
    records.push({id,absolutePath,root:source,relativePath:id+'.md',hash:signature(text),bytes:Buffer.byteLength(text),state:'active',previousPaths:[]})
  }
  await writeState(root,'.llmwiki/sources/catalog.json',records)
  const originals=new Map<string,string>(),knowledge:KnowledgeCatalog={version:1,pages:[]}
  if(withKnowledge){
    await mkdir(path.join(root,'concepts'))
    for(const [name,ids] of [['single',['a']],['shared',['a','b']],['manual',['a']]] as const){
      const page:KnowledgePage={path:'concepts/'+name+'.md',type:'concept',title:name,identity:name,aliases:[],tags:[],conflicts:[],blockHash:'',
        claims:ids.map(id=>({id:name+id,text:'主张 '+id,evidence:{sourceId:id,hash:records.find(record=>record.id===id)!.hash,chunkId:'chunk-'+id,quote:'资料 '+id,cleanStart:0,originalStart:0,line:1}}))}
      const raw=renderKnowledge(page,null,records)+(name==='manual'?'\n人工补充必须留在原位置。\r\n':'')
      page.blockHash=blockSignature(raw)!;knowledge.pages.push(page);originals.set(page.path,raw);await writeFile(path.join(root,page.path),raw)
    }
    await writeState(root,'.llmwiki/knowledge/catalog.json',knowledge)
  }
  return {...temp,root,source,library,store,changes,records,originals}
}
describe('来源撤出归档与清理',()=>{
  it('无活动依据的纯生成页归档，其他来源与人工内容保留，索引和状态同批提交且可撤销',async()=>{
    const f=await fixture()
    try{
      const batch=await prepareSourceState(f.store,f.library.id,['a'],'withdrawn',true),preview=await f.changes.preview(f.library.id,batch.id)
      const archived=preview.pages.find(page=>page.path.startsWith('archive/'))!
      expect(archived.path).toMatch(/\/concepts\/single\.md$/);expect(archived.after).toContain('主张 a')
      expect(archived.after).toContain('../../../../sources/a.md#chunk-a')
      expect(preview.pages.filter(page=>page.after===null).map(page=>page.path)).toEqual(['concepts/single.md'])
      expect(await listArchive(f.store,f.library.id)).toMatchObject({files:[]})
      await f.changes.commit(f.library.id,batch.id,batch.digest)
      await expect(readFile(path.join(f.root,'concepts/single.md'))).rejects.toThrow()
      expect(await readFile(path.join(f.root,'concepts/shared.md'),'utf8')).toContain('主张 b')
      expect(await readFile(path.join(f.root,'concepts/manual.md'),'utf8')).toContain('人工补充必须留在原位置。\r\n')
      expect(await readFile(path.join(f.root,'index.md'),'utf8')).not.toContain('concepts/single.md')
      expect((await listArchive(f.store,f.library.id)).files.map(file=>file.path)).toEqual([archived.path])
      expect(await readFile(path.join(f.source,'a.md'),'utf8')).toBe('资料 a')
      const undo=await f.changes.prepareRevert(f.library.id,batch.id,batch.digest);await f.changes.commit(f.library.id,undo.id,undo.digest)
      expect(await readFile(path.join(f.root,'concepts/single.md'),'utf8')).toBe(f.originals.get('concepts/single.md'))
      expect((await listArchive(f.store,f.library.id)).files).toEqual([])
    }finally{await f.cleanup()}
  })
  it('归档半提交后保留恢复标记，恢复还原原页且不会留下归档副本',async()=>{
    const f=await fixture()
    try{
      const batch=await prepareSourceState(f.store,f.library.id,['a'],'withdrawn',true)
      const failing=new ChangeStore(f.store,{async write(root,page,bytes){await nativePageWriter.write(root,page,bytes);throw new Error('模拟归档中断')}})
      await expect(failing.commit(f.library.id,batch.id,batch.digest)).rejects.toThrow('归档中断')
      await expect(listArchive(f.store,f.library.id)).rejects.toThrow('等待恢复')
      await f.changes.recover(f.library.id,batch.id,batch.digest)
      expect((await listArchive(f.store,f.library.id)).files).toEqual([])
      for(const [relative,raw] of f.originals)expect(await readFile(path.join(f.root,relative),'utf8')).toBe(raw)
    }finally{await f.cleanup()}
  })
  it('清理需绑定归档清单，新增或人工修改使旧预览失效；确认后可通过批次撤销恢复',async()=>{
    const f=await fixture()
    try{
      const archive=await prepareSourceState(f.store,f.library.id,['a'],'withdrawn',true);await f.changes.commit(f.library.id,archive.id,archive.digest)
      const view=await listArchive(f.store,f.library.id),file=view.files[0]!,original=await readFile(path.join(f.root,file.path),'utf8')
      await writeFile(path.join(f.root,file.path),original+'人工修改')
      await expect(prepareArchiveCleanup(f.store,f.library.id,view.revision)).rejects.toThrow('归档已变化')
      const cleanup=await prepareArchiveCleanup(f.store,f.library.id,(await listArchive(f.store,f.library.id)).revision)
      await writeFile(path.join(f.root,path.posix.dirname(file.path),'later.MD'),'# 新归档')
      await writeFile(path.join(f.root,path.posix.dirname(file.path),'keep.bin'),'保留其他归档资源')
      await expect(f.changes.commit(f.library.id,cleanup.id,cleanup.digest)).rejects.toThrow('依据目录已变化')
      const next=await prepareArchiveCleanup(f.store,f.library.id,(await listArchive(f.store,f.library.id)).revision)
      expect((await listArchive(f.store,f.library.id)).files).toHaveLength(2)
      await f.changes.commit(f.library.id,next.id,next.digest)
      expect((await listArchive(f.store,f.library.id)).files).toEqual([])
      expect(await readFile(path.join(f.root,path.posix.dirname(file.path),'keep.bin'),'utf8')).toBe('保留其他归档资源')
      const undo=await f.changes.prepareRevert(f.library.id,next.id,next.digest);await f.changes.commit(f.library.id,undo.id,undo.digest)
      expect(await readFile(path.join(f.root,file.path),'utf8')).toBe(original+'人工修改')
      f.library.kind='obsidian';f.library.mode='readonly'
      await expect(prepareArchiveCleanup(f.store,f.library.id,(await listArchive(f.store,f.library.id)).revision)).rejects.toThrow('只读')
    }finally{await f.cleanup()}
  })
  it('尚未生成 Wiki 也能撤出来源，不创建知识页或空索引',async()=>{
    const f=await fixture(false)
    try{
      const batch=await prepareSourceState(f.store,f.library.id,['a'],'withdrawn')
      expect(batch.pages.map(page=>page.path)).toEqual(['.llmwiki/sources/catalog.json'])
      await f.changes.commit(f.library.id,batch.id,batch.digest)
      expect(await readdir(f.root)).toEqual(['.llmwiki'])
    }finally{await f.cleanup()}
  })
  it('取消来源处理或清理时不留下可提交批次',async()=>{
    const f=await fixture(),abort=new AbortController();abort.abort(new Error('用户已取消'))
    try{
      await expect(prepareSourceState(f.store,f.library.id,['a'],'withdrawn',true,abort.signal)).rejects.toThrow('用户已取消')
      await expect(prepareArchiveCleanup(f.store,f.library.id,'',abort.signal)).rejects.toThrow('用户已取消')
      await expect(f.changes.prepare(f.library.id,'取消准备',[{path:'concepts/later.md',content:'# 新页',expectedBefore:null}],[],abort.signal)).rejects.toThrow('用户已取消')
      expect(await f.changes.list(f.library.id)).toEqual([])
    }finally{await f.cleanup()}
  })
})
