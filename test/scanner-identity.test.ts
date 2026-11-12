import { randomUUID } from 'node:crypto'
import { mkdir,readFile,rename,unlink,writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach,expect,it,vi } from 'vitest'
import { emptyRegistry,newLibrary } from '../src/domain/config.js'
import { scanLibrary } from '../src/ingest/scanner.js'
import type { SourceRecord } from '../src/ingest/scanner.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { safePath } from '../src/storage/paths.js'
import { temporaryWorkspace } from './temp.js'
import { cleanupLayeredFixtures,mockFixtureSync } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

async function fixture(){
  const temp=await temporaryWorkspace(),source=path.join(temp.root,'source'),wiki=path.join(temp.root,'wiki')
  mockFixtureSync(temp.root)
  await mkdir(source);const library=newLibrary('scan-identity');library.wikiPath=wiki;library.sourceRoots=[source]
  const registry=emptyRegistry();registry.libraries=[library];const store=new LibraryStore(()=>registry);await store.initialize(library.id)
  const catalog=async()=>JSON.parse(await readFile(await safePath(wiki,'.llmwiki/sources/catalog.json'),'utf8')) as SourceRecord[]
  return {...temp,source,wiki,store,library,catalog}
}

it('唯一重编号保留身份、版本与缓存，同时识别新文档和待更新的来源路径',async()=>{
  const f=await fixture()
  try{
    const oldPath=path.join(f.source,'01-原文.md'),newPath=path.join(f.source,'02-原文.md')
    await writeFile(oldPath,'资料正文。\n![示意图](data:image/png;base64,aW1hZ2U=)')
    await scanLibrary(f.store,f.library.id);const records=await f.catalog(),original=records[0]!
    original.committedHash=original.hash
    await writeFile(await safePath(f.wiki,'.llmwiki/sources/catalog.json'),JSON.stringify(records))
    const versionPath=await safePath(f.wiki,`.llmwiki/sources/${original.id}/${original.hash}.json`),version=await readFile(versionPath,'utf8')
    const cachePath=await safePath(f.wiki,'.llmwiki/analysis/retained.json');await mkdir(path.dirname(cachePath));await writeFile(cachePath,'既有提取缓存')
    await rename(oldPath,newPath);await writeFile(path.join(f.source,'03-新增.md'),'新增资料。')
    const scan=await scanLibrary(f.store,f.library.id),moved=scan.files.find(file=>file.sourceId===original.id)!,current=(await f.catalog()).find(record=>record.id===original.id)!
    expect(scan.errors).toEqual([]);expect(moved).toMatchObject({path:newPath,previousPath:oldPath,change:'moved',needsGeneration:true,generation:'update'})
    expect(current).toMatchObject({id:original.id,hash:original.hash,absolutePath:newPath,previousPaths:[oldPath],committedPath:oldPath})
    expect(scan.files.filter(file=>file.change==='new')).toHaveLength(1)
    expect(await readFile(versionPath,'utf8')).toBe(version);expect(await readFile(cachePath,'utf8')).toBe('既有提取缓存')
    expect((await scanLibrary(f.store,f.library.id)).files.find(file=>file.sourceId===original.id)).toMatchObject({change:'unchanged',needsGeneration:true,generation:'update'})
  }finally{await f.cleanup()}
})

it('原件仍存在的同内容副本共用原身份并登记别名',async()=>{
  const f=await fixture()
  try{
    await writeFile(path.join(f.source,'原件.md'),'相同正文。');await scanLibrary(f.store,f.library.id)
    const original=(await f.catalog())[0]!
    await writeFile(path.join(f.source,'副本.md'),'相同正文。');const scan=await scanLibrary(f.store,f.library.id)
    // 同内容副本不再分配来源编号；扫描仍列出每个物理路径。
    expect(scan.files.find(file=>file.path.endsWith('副本.md'))).toMatchObject({change:'unchanged',sourceId:original.id})
    expect(new Set(scan.files.map(file=>file.sourceId)).size).toBe(1)
    expect(await f.catalog()).toHaveLength(1)
    expect((await f.catalog())[0]!.aliasPaths).toEqual([path.join(f.source,'副本.md')])
    expect((await f.catalog()).find(record=>record.id===original.id)!.previousPaths).toEqual([])
  }finally{await f.cleanup()}
})

it.each([[1,2],[2,1]])('同哈希旧路径%d个、新路径%d个时保留唯一内容身份',async(oldCount,newCount)=>{
  const f=await fixture()
  try{
    for(let n=0;n<oldCount;n++)await writeFile(path.join(f.source,`旧${n}.md`),'相同正文。')
    await scanLibrary(f.store,f.library.id);const originals=await f.catalog()
    for(let n=0;n<oldCount;n++)await unlink(path.join(f.source,`旧${n}.md`))
    for(let n=0;n<newCount;n++)await writeFile(path.join(f.source,`新${n}.md`),'相同正文。')
    const scan=await scanLibrary(f.store,f.library.id)
    // 路径数量不再制造身份歧义：同哈希路径统一对应旧来源。
    expect(scan.files.filter(file=>file.change==='moved')).toHaveLength(newCount)
    expect(scan.files.filter(file=>file.change==='new')).toHaveLength(0)
    expect(scan.files.every(file=>file.sourceId===originals[0]!.id)).toBe(true)
    expect(scan.files.filter(file=>file.change==='missing')).toHaveLength(0)
    expect((await f.catalog()).filter(record=>record.state==='active')).toHaveLength(1)
  }finally{await f.cleanup()}
})

it('持久生成任务运行时拒绝扫描，来源清单保持原字节',async()=>{
  const f=await fixture()
  try{
    await writeFile(path.join(f.source,'原件.md'),'正文。');await scanLibrary(f.store,f.library.id)
    const file=await safePath(f.wiki,'.llmwiki/sources/catalog.json'),before=await readFile(file,'utf8')
    const jobId=randomUUID(),jobFile=await safePath(f.wiki,`.llmwiki/jobs/${jobId}.json`)
    await writeFile(jobFile,JSON.stringify({kind:'generate',id:jobId,status:'running'}));await writeFile(path.join(f.source,'新增.md'),'新增。')
    await expect(scanLibrary(f.store,f.library.id)).rejects.toThrow('运行中的生成任务')
    expect(await readFile(file,'utf8')).toBe(before)
  }finally{await f.cleanup()}
})

it.each([false,true])('跨目录移动含相对图片=%s时核对身份与原图版本边界',async(relativeImage)=>{
  const f=await fixture()
  try{
    const oldFolder=path.join(f.source,'旧目录'),newFolder=path.join(f.source,'新目录')
    await mkdir(oldFolder);await mkdir(newFolder)
    await writeFile(path.join(oldFolder,'image.png'),'原图');await writeFile(path.join(newFolder,'image.png'),'另一张图')
    const oldPath=path.join(oldFolder,'资料.md'),newPath=path.join(newFolder,'资料.md')
    await writeFile(oldPath,relativeImage?'正文。\n![原图](image.png)':'正文。')
    await scanLibrary(f.store,f.library.id);const original=(await f.catalog())[0]!
    const versionPath=await safePath(f.wiki,`.llmwiki/sources/${original.id}/${original.hash}.json`),before=await readFile(versionPath,'utf8')
    await rename(oldPath,newPath);const scan=await scanLibrary(f.store,f.library.id),current=scan.files.find(file=>file.path===newPath)!
    expect(current.change).toBe(relativeImage?'new':'moved')
    expect(current.sourceId===original.id).toBe(!relativeImage)
    expect(await readFile(versionPath,'utf8')).toBe(before)
    if(relativeImage){
      const version=JSON.parse(await readFile(await safePath(f.wiki,`.llmwiki/sources/${current.sourceId}/${original.hash}.json`),'utf8'))
      expect(version.images[0].assetId).not.toBe(JSON.parse(before).images[0].assetId)
    }
  }finally{await f.cleanup()}
})

it('重编号保留已撤出状态，不自动恢复来源',async()=>{
  const f=await fixture()
  try{
    const oldPath=path.join(f.source,'旧.md'),newPath=path.join(f.source,'新.md')
    await writeFile(oldPath,'正文。');await scanLibrary(f.store,f.library.id);const records=await f.catalog(),original=records[0]!
    original.state='withdrawn';await writeFile(await safePath(f.wiki,'.llmwiki/sources/catalog.json'),JSON.stringify(records))
    await rename(oldPath,newPath);const scan=await scanLibrary(f.store,f.library.id)
    expect(scan.files[0]).toMatchObject({sourceId:original.id,path:newPath,previousPath:oldPath,change:'withdrawn',needsGeneration:false,generation:'inactive'})
    expect((await f.catalog())[0]).toMatchObject({id:original.id,state:'withdrawn',absolutePath:newPath})
  }finally{await f.cleanup()}
})
