import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { scanLibrary } from '../src/ingest/scanner.js'
import { generateWiki } from '../src/wiki/generation.js'
import { ChangeStore } from '../src/storage/changes.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { temporaryWorkspace } from './temp.js'
import { mockFixtureSync } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => vi.restoreAllMocks())

describe('知识页语言贯穿生成链路',()=>{
  it.each([
    ['zh-CN','参与者随访','参与者完成了定期随访。','综合知识','逐条出处'],
    ['en','Participant follow-up','Participants completed scheduled follow-up.','Synthesis','References'],
    ['ja','参加者の追跡','参加者は定期的な追跡調査を完了した。','総合知識','出典'],
    ['Esperanto','Partoprenanta sekvado','Partoprenantoj kompletigis planitan sekvadon.','Sintezo','Referencoj'],
  ])('%s 的标题、正文及模板使用设置语言，引文保留原文',async(language,title,claim,heading,references)=>{
    const temp=await temporaryWorkspace(),library=newLibrary('language-test'),quote='Participants completed scheduled follow-up.'
  mockFixtureSync(temp.root)
    library.wikiPath=path.join(temp.root,'wiki');library.sourceRoots=[path.join(temp.root,'source')];library.models.unified={provider:'fixture',model:'test'}
    const registry=emptyRegistry();registry.libraries=[library];const store=new LibraryStore(()=>registry),calls:string[]=[]
    try{
      await mkdir(library.sourceRoots[0]!);await writeFile(path.join(library.sourceRoots[0]!,'a.md'),quote)
      const view=await store.initialize(library.id);await store.savePolicy(library.id,{...view.policy,wikiLanguage:language,batchDelayMs:0},view.revision);await scanLibrary(store,library.id)
      const runtime:ModelRuntime={async resolveModelInfo(provider,id){return {provider,id,name:id}},async *stream(options){
        const input=JSON.parse((options.messages[0]!.content[0] as {text:string}).text);calls.push(input.language)
        const output=input.template?{knowledge:'Sintezo',disagreement:'Malkonsentoj',conflict:'Malkonsento',evidence:'Pruvo',noEvidence:'Neniu aktiva pruvo.',references:'Referencoj',source:'Originala fonto',version:'Versio',line:'Linio',image:'Originala bildo',originalImages:'Fontaj bildoj',offset:'Pozicio',claim:'Aserto',imageOnly:'Vidu la originalajn bildojn.',welcome:'Vikia gvidilo',guide:'Komencu ĉe la [indekso](index.md).'}
          :input.candidates?{groups:[{type:'concept',title,identity:title,aliases:[],tags:[],members:input.candidates.map((item:{id:string})=>item.id),conflicts:[]}]}
          :{candidates:input.round===1?[{type:'concept',title,identity:title,aliases:[],tags:[],mentionOnly:false,claims:[{text:claim,quote}]}]:[],images:[]}
        yield {type:'text-delta',index:0,text:JSON.stringify(output)};yield {type:'finish',reason:{kind:'stop'}}
      }}
      const job=await generateWiki(store,library.id,runtime,new AbortController().signal),preview=await new ChangeStore(store).preview(library.id,job.batchId!)
      const page=preview.pages.find(page=>page.path.startsWith('concepts/'))!.after!
      expect(page).toContain('## '+heading);expect(page).toContain('## '+references);expect(page).toContain(claim);expect(page).toContain(quote)
      expect(calls.every(value=>value===language)).toBe(true)
      if(language!=='zh-CN')expect(page).not.toContain('## 综合知识')
    }finally{await temp.cleanup()}
  })
})
