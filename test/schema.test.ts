import { readFile,writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach,describe,expect,it,vi } from 'vitest'
import { newLibrary,emptyRegistry } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { ChangeStore,nativePageWriter } from '../src/storage/changes.js'
import { initialSchema,prepareSchema,readSchema,suggestSchema } from '../src/wiki/schema.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { temporaryWorkspace } from './temp.js'
import { mockFixtureSync } from './layered-fixture.js'
vi.mock('node:fs/promises',async original=>({...await original<typeof import('node:fs/promises')>()}))
afterEach(()=>vi.restoreAllMocks())
async function fixture(){
  const temp=await temporaryWorkspace(),library=newLibrary('schema');library.wikiPath=temp.root;library.models.unified={provider:'fake',model:'schema'}
  mockFixtureSync(temp.root)
  const registry=emptyRegistry();registry.libraries=[library];const store=new LibraryStore(()=>registry);await store.initialize(library.id)
  return {...temp,library,store,changes:new ChangeStore(store)}
}
describe('Schema 建议、预览与备份',()=>{
  it('初始化需确认，轮换保留三份，回滚能恢复被轮换的备份',async()=>{
    const f=await fixture()
    try{
      let view=await readSchema(f.store,f.library.id)
      const first=await prepareSchema(f.store,f.library.id,view.revision,initialSchema('en'))
      expect((await readSchema(f.store,f.library.id)).config).toBeNull()
      await f.changes.commit(f.library.id,first.id,first.digest)
      let previous:string[]=[]
      for(let index=0;index<4;index++){
        view=await readSchema(f.store,f.library.id);previous=view.backups
        const batch=await prepareSchema(f.store,f.library.id,view.revision,'# Schema '+index+'\n')
        if(index===3){
          const interrupted=new ChangeStore(f.store,{async write(root,page,bytes){await nativePageWriter.write(root,page,bytes);if(page.after===null)throw new Error('模拟轮换后中断')}})
          await expect(interrupted.commit(f.library.id,batch.id,batch.digest)).rejects.toThrow('模拟轮换后中断')
          expect((await readSchema(f.store,f.library.id)).backups).toHaveLength(3)
          await f.changes.recover(f.library.id,batch.id,batch.digest)
          const restored=await readSchema(f.store,f.library.id)
          expect(restored.backups).toEqual(previous);expect(restored.config).toBe(view.config)
        }else await f.changes.commit(f.library.id,batch.id,batch.digest)
      }
    }finally{await f.cleanup()}
  })
  it('模型建议单独预览；提交建议不修改配置，应用时再次校验版本',async()=>{
    const f=await fixture()
    try{
      const runtime:ModelRuntime={async resolveModelInfo(provider,id){return{provider,id,name:id}},async*stream(){yield{type:'text-delta',index:0,text:JSON.stringify({config:'# 方法知识结构\n',reason:'按库简介补充方法和适用条件。'})};yield{type:'finish',reason:{kind:'stop'}}}}
      let view=await readSchema(f.store,f.library.id)
      const batch=await suggestSchema(f.store,f.library.id,view.revision,runtime,new AbortController().signal)
      await f.changes.commit(f.library.id,batch.id,batch.digest)
      view=await readSchema(f.store,f.library.id)
      expect(view.config).toBeNull();expect(view.proposal?.config).toBe('# 方法知识结构')
      const apply=await prepareSchema(f.store,f.library.id,view.revision,view.proposal!.config)
      await writeFile(path.join(f.root,'schema/suggestions.md'),'人工修改建议')
      await expect(f.changes.commit(f.library.id,apply.id,apply.digest)).rejects.toThrow('生成依据已变化')
      await expect(readFile(path.join(f.root,'schema/config.md'))).rejects.toThrow()
    }finally{await f.cleanup()}
  })
})
