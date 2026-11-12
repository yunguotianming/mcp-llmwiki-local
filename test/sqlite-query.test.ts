import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { sqliteIndex } from '../src/storage/jobs.js'
import { WikiQuery } from '../src/wiki/query.js'
import { temporaryWorkspace } from './temp.js'

async function fixture() {
  const temp=await temporaryWorkspace(),library=newLibrary('sqlite-query')
  library.wikiPath=path.join(temp.root,'wiki');const registry=emptyRegistry();registry.libraries=[library]
  const store=new LibraryStore(()=>registry);await store.initialize(library.id);await store.migrateStorage(library.id)
  await mkdir(path.join(library.wikiPath,'concepts'))
  await writeFile(path.join(library.wikiPath,'concepts/nurse.md'),'---\ntitle: 科研护士\naliases: [research nurse, 研究护士]\n---\n\n# 科研护士\n\n负责受试者随访和研究协调。')
  await writeFile(path.join(library.wikiPath,'concepts/ethics.md'),'---\ntitle: 伦理审查\n---\n\n# 伦理审查\n\n研究开展前需要伦理批准。')
  return {...temp,library,store,query:new WikiQuery(store)}
}
describe('SQLite中文全文索引',()=>{
  it('中文正文、双语别名及短查询可召回，读取原始页面',async()=>{
    const f=await fixture()
    try{
      expect((await f.query.search('受试者随访')).results[0]?.title).toBe('科研护士')
      expect((await f.query.search('research nurse')).results[0]?.title).toBe('科研护士')
      expect((await f.query.search('护士')).results[0]?.path).toBe('concepts/nurse.md')
      expect((await f.query.read('研究护士')).content).toContain('负责受试者随访')
    }finally{await f.cleanup()}
  },30000)
  it('外部编辑只刷新变更页的索引，未变页记录保持',async()=>{
    const f=await fixture()
    try{
      await f.query.search('护士')
      const before=await sqliteIndex<{path:string;stamp:string;data:string}[]>(f.library.wikiPath,'index-read')
      await writeFile(path.join(f.library.wikiPath,'concepts/nurse.md'),'# 科研护士\n\n新增专业术语：临床协调岗位。')
      expect((await f.query.search('临床协调岗位')).results.some(page=>page.path==='concepts/nurse.md')).toBe(true)
      const after=await sqliteIndex<{path:string;stamp:string;data:string}[]>(f.library.wikiPath,'index-read')
      expect(after.find(page=>page.path==='concepts/ethics.md')).toEqual(before.find(page=>page.path==='concepts/ethics.md'))
      expect((await f.query.read('科研护士')).content).toContain('临床协调岗位')
    }finally{await f.cleanup()}
  },30000)
  it('FTS操作符作为文本处理，不能改变数据库结构',async()=>{
    const f=await fixture()
    try{
      await expect(f.query.search('" OR * ; DROP TABLE jobs --')).resolves.toMatchObject({total:0})
      expect((await f.query.search('科研护士')).results[0]?.title).toBe('科研护士')
      expect(await readFile(path.join(f.library.wikiPath,'.llmwiki/storage.json'),'utf8')).toContain('sqlite')
    }finally{await f.cleanup()}
  },30000)
})
