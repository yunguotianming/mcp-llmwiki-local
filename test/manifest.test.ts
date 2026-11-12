import { mkdir,writeFile,symlink } from 'node:fs/promises'
import path from 'node:path'
import { describe,expect,it } from 'vitest'
import { readSharedManifest } from '../src/storage/manifest.js'
import { WikiQuery } from '../src/wiki/query.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { newLibrary,emptyRegistry } from '../src/domain/config.js'
import { temporaryWorkspace } from './temp.js'
describe('Obsidian 共享清单',()=>{
  it('区分缺失与损坏，并拒绝链接越出 Vault',async()=>{
    const temp=await temporaryWorkspace(),vault=path.join(temp.root,'vault')
    try{
      await mkdir(path.join(vault,'.obsidian'),{recursive:true})
      expect((await readSharedManifest(vault)).found).toBe(false)
      const file=path.join(vault,'.llm-wiki-databases.json');await writeFile(file,'{bad')
      await expect(readSharedManifest(vault)).rejects.toThrow()
      await mkdir(path.join(temp.root,'outside'));await symlink(path.join(temp.root,'outside'),path.join(vault,'linked'),'junction')
      await writeFile(file,JSON.stringify({version:1,databases:[{name:'越界库',wikiFolder:'linked'}]}))
      await expect(readSharedManifest(vault)).rejects.toThrow('越出')
    }finally{await temp.cleanup()}
  })
  it('每次查询沿用清单最新名称与启用范围，保留本地禁用偏好',async()=>{
    const temp=await temporaryWorkspace()
    try{
      await mkdir(path.join(temp.root,'.obsidian'));await mkdir(path.join(temp.root,'wiki','concepts'),{recursive:true})
      await writeFile(path.join(temp.root,'wiki','concepts','a.md'),'# 查询页\n资料')
      const file=path.join(temp.root,'.llm-wiki-databases.json')
      const set=async(name:string,enabled:boolean)=>writeFile(file,JSON.stringify({version:1,vaultId:null,databases:[{name,wikiFolder:'wiki',dshEnabled:enabled}]}))
      const library=newLibrary('shared');Object.assign(library,{kind:'obsidian',mode:'readonly',wikiPath:path.join(temp.root,'wiki'),vaultPath:temp.root,name:'旧名称'})
      const registry=emptyRegistry();registry.libraries=[library];const query=new WikiQuery(new LibraryStore(()=>registry))
      await set('新名称',true);expect((await query.catalog()).libraries[0]?.name).toBe('新名称')
      expect((await query.search('查询页','新名称')).total).toBe(1)
      await set('新名称',false);expect((await query.catalog()).libraries).toEqual([])
      await set('新名称',true);library.enabled=false;expect((await query.catalog()).libraries).toEqual([])
    }finally{await temp.cleanup()}
  })
})
