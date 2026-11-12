import { mkdir,readFile,writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect,it } from 'vitest'
import { decodeSourceText } from '../src/ingest/text.js'
import { emptyRegistry,newLibrary } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { scanLibrary } from '../src/ingest/scanner.js'
import { generateWiki } from '../src/wiki/generation.js'
import { ChangeStore } from '../src/storage/changes.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { temporaryWorkspace } from './temp.js'

it('来源解码优先 UTF-8，兼容 UTF-16 BOM 与旧中文编码，损坏数据仍报错',()=>{
  expect(decodeSourceText(Buffer.from('中文 UTF-8'))).toBe('中文 UTF-8')
  expect(decodeSourceText(Buffer.from('\ufeff中文','utf16le'))).toBe('中文')
  expect(decodeSourceText(Buffer.from('feff4e2d6587','hex'))).toBe('中文')
  expect(decodeSourceText(Buffer.from('d6d0cec4','hex'))).toBe('中文')
  expect(()=>decodeSourceText(Buffer.from([0xff]))).toThrow()
})

it('旧中文来源可扫描和生成逐字引文，原始快照及文件字节不变',async()=>{
  const temp=await temporaryWorkspace(),source=path.join(temp.root,'source'),wiki=path.join(source,'wiki'),raw=Buffer.from('d6d0cec4','hex')
  try{
    await mkdir(source);const file=path.join(source,'a.txt');await writeFile(file,raw)
    const library=newLibrary('encoding');Object.assign(library,{wikiPath:wiki,sourceRoots:[source]});library.models.unified={provider:'fake',model:'test'}
    const registry=emptyRegistry();registry.libraries=[library];const store=new LibraryStore(()=>registry);await store.initialize(library.id)
    expect((await scanLibrary(store,library.id)).errors).toEqual([])
    const runtime:ModelRuntime={async resolveModelInfo(provider,id){return {provider,id,name:id}},async *stream(options){
      const input=JSON.parse((options.messages[0]!.content[0] as {text:string}).text)
      const output=input.candidates?{groups:[{type:'concept',title:'中文',identity:'中文',aliases:[],tags:[],members:input.candidates.map((candidate:{id:string})=>candidate.id),conflicts:[]}]}:
        {candidates:[{type:'concept',title:'中文',identity:'中文',aliases:[],tags:[],mentionOnly:false,claims:[{text:'资料正文为中文。',quote:'中文'}]}],images:[]}
      yield {type:'text-delta',index:0,text:JSON.stringify(output)};yield {type:'finish',reason:{kind:'stop'}}
    }}
    const job=await generateWiki(store,library.id,runtime,new AbortController().signal),preview=await new ChangeStore(store).preview(library.id,job.batchId!)
    expect(job.chunks[0]!.candidates[0]!.claims[0]!.evidence).toMatchObject({quote:'中文',originalStart:0,line:1})
    expect(preview.pages.find(page=>page.path.startsWith('sources/'))?.after).toContain('中文')
    const records=JSON.parse(await readFile(path.join(wiki,'.llmwiki/sources/catalog.json'),'utf8'))
    expect(await readFile(path.join(wiki,'.llmwiki/objects',records[0].hash))).toEqual(raw)
    expect(await readFile(file)).toEqual(raw)
  }finally{await temp.cleanup()}
})
