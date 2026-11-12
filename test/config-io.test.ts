import { describe,expect,it } from 'vitest'
import { emptyRegistry,newLibrary } from '../src/domain/config.js'
import { exportConfig,importConfig } from '../src/domain/config-io.js'
describe('非敏感配置迁移',()=>{
  it('完整往返模型覆盖与备用引用，拒绝凭据及未知字段',()=>{
    const registry=emptyRegistry(),library=newLibrary('io');library.wikiPath='E:\\wiki';library.models.unified={provider:'host',model:'base'};library.models.query={provider:'host',model:'saved-override'};library.models.fallbacks=[{provider:'host',model:'backup'}];registry.libraries=[library];registry.activeLibraryId='io'
    const text=exportConfig(registry)
    expect(importConfig(text,emptyRegistry(),'replace')).toEqual(registry)
    const value=JSON.parse(text);value.registry.libraries[0].models.unified.apiKey='不应写入'
    expect(()=>importConfig(JSON.stringify(value),registry,'replace')).toThrow()
    expect(()=>importConfig(text,registry,'append')).toThrow('标识无效或重复')
  })
  it('旧 wikis 以只读方式迁移，不把历史 workspacePath 当作默认输出目录',()=>{
    const current=emptyRegistry(),imported=importConfig(JSON.stringify({wikis:[{name:'旧科研库',path:'E:\\旧资料\\wiki',enabled:false}],readMaxChars:6000,workspacePath:'E:\\workspace',refreshFromShared:true}),current,'replace')
    expect(imported.libraries[0]).toMatchObject({kind:'obsidian',mode:'readonly',enabled:false,wikiPath:'E:\\旧资料\\wiki'})
    expect(imported.readMaxChars).toBe(6000);expect(current.libraries).toHaveLength(0)
    expect(()=>importConfig(JSON.stringify({wikis:[{name:'相对路径',path:'../wiki'}]}),current,'replace')).toThrow('绝对路径')
  })
})
