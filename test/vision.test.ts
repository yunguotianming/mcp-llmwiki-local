import { mkdir,readFile,writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll,afterEach,beforeAll,describe,expect,it,vi } from 'vitest'
import type { AttachmentStore,ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { emptyRegistry,newLibrary } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { scanLibrary } from '../src/ingest/scanner.js'
import type { SourceVersion,SourceRecord } from '../src/ingest/scanner.js'
import { ModelClient } from '../src/llm/client.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { recognizeImage } from '../src/ingest/vision.js'
import { candidatesFrom } from '../src/ingest/extraction.js'
import { generateWiki } from '../src/wiki/generation.js'
import { pageLabels } from '../src/wiki/language.js'
import { ChangeStore } from '../src/storage/changes.js'
import { WikiQuery } from '../src/wiki/query.js'
import { listSources,prepareSourceState } from '../src/wiki/sources.js'
import { checkWiki,prepareMaintenance } from '../src/wiki/maintenance.js'
import { temporaryWorkspace } from './temp.js'
import { mockFixtureSync,restoreFixture,snapshotFixture,type FixtureSnapshot } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => vi.restoreAllMocks())
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=','base64')
let seed:Awaited<ReturnType<typeof createFixture>>,initial:FixtureSnapshot
beforeAll(async()=>{seed=await createFixture();initial=await snapshotFixture(seed.root)})
afterAll(async()=>{await seed?.cleanup()})
async function createFixture() {
  const temp=await temporaryWorkspace(),source=path.join(temp.root,'source'),wiki=path.join(temp.root,'wiki')
  mockFixtureSync(temp.root)
  await mkdir(source);await writeFile(path.join(source,'a.md'),'# 图表\n\n![初检记录](data:image/png;base64,'+png.toString('base64')+')\n')
  const library=newLibrary('vision');library.wikiPath=wiki;library.sourceRoots=[source];library.models.unified={provider:'fake',model:'primary'}
  const registry=emptyRegistry();registry.libraries=[library];const store=new LibraryStore(()=>registry)
  const initialized=await store.initialize(library.id);initialized.policy.batchDelayMs=0
  await store.savePolicy(library.id,initialized.policy,initialized.revision);await scanLibrary(store,library.id)
  return {...temp,library}
}
async function fixture(imageCapable=true) {
  // 复用扫描完成的原字节，登记、模型与调用记录逐项重新创建。
  mockFixtureSync(seed.root);await restoreFixture(initial,seed.root)
  const library=structuredClone(seed.library),wiki=library.wikiPath,registry=emptyRegistry();registry.libraries=[library]
  const store=new LibraryStore(()=>registry)
  const records:SourceRecord[]=JSON.parse(await readFile(path.join(wiki,'.llmwiki/sources/catalog.json'),'utf8')),record=records[0]!
  const version:SourceVersion=JSON.parse(await readFile(path.join(wiki,`.llmwiki/sources/${record.id}/${record.hash}.json`),'utf8'))
  const calls:GenerateOptions[]=[],saved:Uint8Array[]=[]
  const attachments:Pick<AttachmentStore,'saveImage'>={async saveImage(input){saved.push(input.data);return {attachmentId:'test-image' as ImageAttachmentRef['attachmentId'],mediaType:input.mediaType,bytes:input.data.length,width:1,height:1}}}
  const runtime:ModelRuntime={async resolveModelInfo(provider,id){return {provider,id,name:id,...(imageCapable||id==='backup'?{inputModalities:['text','image'] as const}:{})}},async *stream(options){
    calls.push(options);yield {type:'text-delta',index:0,text:JSON.stringify({observedText:'初检 18/20',observations:['柱状图标注初检样本为20份。'],uncertain:['图例颜色含义不清楚。']})};yield {type:'finish',reason:{kind:'stop'}}
  }}
  const client=new ModelClient(runtime,library,(await store.policy(library.id)).policy)
  return {...seed,library,store,record,version,calls,saved,runtime,client,attachments,async cleanup(){}}
}
const signal=()=>new AbortController().signal
function emptyTextModel(calls:GenerateOptions[]):ModelRuntime {
  return {async resolveModelInfo(provider,id){return {provider,id,name:id}},async *stream(options){
    calls.push(options)
    const input=JSON.parse((options.messages[0]!.content[0] as {text:string}).text)
    expect(input.candidates).toBeUndefined()
    expect(JSON.stringify(options)).not.toContain(png.toString('base64'))
    expect(options.messages[0]!.content.every(block=>block.type==='text')).toBe(true)
    yield {type:'text-delta',index:0,text:JSON.stringify({candidates:[],images:[]})};yield {type:'finish',reason:{kind:'stop'}}
  }}
}
describe('真实图片输入与识别依据',()=>{
  it('图片能力未知时保留待处理，不保存附件也不调用模型',async()=>{
    const f=await fixture(false)
    try{
      const result=await recognizeImage(f.store,f.library,f.client,f.version.images[0]!,'上下文',signal(),f.attachments)
      expect(result.status).toBe('pending');expect(result.reason).toContain('图片输入能力')
      expect(f.saved).toHaveLength(0);expect(f.calls).toHaveLength(0)
    }finally{await f.cleanup()}
  })
  it('发送真实 ImageBlock，缓存复用相同语境、区分新语境和资源损坏',async()=>{
    const f=await fixture(),image=f.version.images[0]!
    try{
      const first=await recognizeImage(f.store,f.library,f.client,image,'语境甲',signal(),f.attachments)
      expect(first.status).toBe('recognized');expect(first.uncertain).toHaveLength(1)
      expect(f.saved[0]).toEqual(png);expect(f.calls[0]!.messages[0]!.content[1]).toMatchObject({type:'image',attachment:{attachmentId:'test-image'}})
      expect(await recognizeImage(f.store,f.library,f.client,image,'语境甲',signal(),f.attachments)).toEqual(first)
      expect(f.calls).toHaveLength(1)
      const second=await recognizeImage(f.store,f.library,f.client,image,'语境乙',signal(),f.attachments)
      expect(second.key).not.toBe(first.key);expect(f.calls).toHaveLength(2)
      await writeFile(path.join(f.library.wikiPath,'.llmwiki/objects',image.assetId!),'损坏')
      const damaged=await recognizeImage(f.store,f.library,f.client,image,'语境丙',signal(),f.attachments)
      expect(damaged.status).toBe('pending');expect(damaged.reason).toContain('签名校验')
      expect(f.calls).toHaveLength(2)
    }finally{await f.cleanup()}
  })
  it('主模型无图像能力时选择已声明能力的备用并记录实际模型',async()=>{
    const f=await fixture(false);f.library.models.fallbacks=[{provider:'fake',model:'backup'}]
    try{
      const result=await recognizeImage(f.store,f.library,f.client,f.version.images[0]!,'上下文',signal(),f.attachments)
      expect(result.status).toBe('recognized');expect(result.model).toEqual({provider:'fake',id:'backup'})
      expect(f.calls.map(call=>call.model)).toEqual(['backup'])
    }finally{await f.cleanup()}
  })
  it('图像主张只接受已识别记录中的逐字引文',()=>{
    const extraction={candidates:[{type:'concept' as const,title:'初检',identity:'初检',aliases:[],tags:[],mentionOnly:false,claims:[{text:'初检18/20。',quote:'初检 18/20',imageId:'image'}]}],images:[]}
    const image={id:'image',assetId:'asset',key:'recognition',observedText:'初检 18/20',observations:[],originalStart:40,line:3,model:{provider:'host',id:'vision'}}
    const extract=()=>candidatesFrom(extraction,'正文',{id:'chunk',start:0},{id:'source',hash:'version'},()=>({originalStart:0,line:1}),false,[image])
    expect(extract()[0]!.claims[0]!.evidence).toMatchObject({originalStart:40,line:3,image:{recognitionKey:'recognition',model:'vision'}})
    extraction.candidates[0]!.claims[0]!.quote='图例代表成功'
    expect(extract).toThrow('缺少已记录的识别依据')
  })
  it('生成保留原图展示，即使旧策略全部识图也不 OCR，模型和查询不接收 Base64',async()=>{
    const f=await fixture(),raw=await readFile(path.join(f.library.sourceRoots[0]!,'a.md'),'utf8')
    const view=await f.store.policy(f.library.id)
    await f.store.savePolicy(f.library.id,{...view.policy,imageStrategy:'all'},view.revision)
    f.runtime.stream=async function*(options){
      f.calls.push(options)
      expect(options.messages[0]!.content.every(block=>block.type==='text')).toBe(true)
      expect(JSON.stringify(options)).not.toContain(png.toString('base64'))
      const data=JSON.parse((options.messages[0]!.content[0] as {text:string}).text)
      const output=data.candidates?{groups:[{type:'concept',title:'初检',identity:'图表初检',aliases:[],tags:[],members:data.candidates.map((candidate:{id:string})=>candidate.id),conflicts:[]}]}:
        {candidates:[{type:'concept',title:'初检',identity:'图表初检',aliases:[],tags:[],mentionOnly:false,claims:[{text:'资料包含初检记录。',quote:'图表'}]}],images:data.images.map((image:{id:string})=>({id:image.id,decision:'needs-vision',reason:'旧模型建议识图也不能触发 OCR。',quote:''}))}
      yield {type:'text-delta',index:0,text:JSON.stringify(output)};yield {type:'finish',reason:{kind:'stop'}}
    }
    try{
      const job=await generateWiki(f.store,f.library.id,f.runtime,signal(),undefined,f.attachments)
      expect(job.pendingImages).toBe(0);expect(job.chunks[0]!.recognitions).toBeUndefined();expect(f.saved).toHaveLength(0)
      const changes=new ChangeStore(f.store),preview=await changes.preview(f.library.id,job.batchId!)
      const source=preview.pages.find(page=>page.path.startsWith('sources/'))!
      expect(source.after).toContain('## 原文图片');expect(source.after).toContain(png.toString('base64'))
      await changes.commit(f.library.id,job.batchId!,preview.batch.digest)
      const read=await new WikiQuery(f.store).read(source.path)
      expect(read.content).not.toContain(png.toString('base64'));expect(read.content).toContain('初检记录')
      expect(await readFile(path.join(f.library.sourceRoots[0]!,'a.md'),'utf8')).toBe(raw)
    }finally{await f.cleanup()}
  })
  it('旧图片覆盖判断无需逐字引文，正文概括仍保留原文证据',async()=>{
    const f=await fixture(),file=path.join(f.library.sourceRoots[0]!,'a.md')
    const quote='青松流程完成初检后 进入复核阶段。',originalQuote='青松流程完成初检后\r\n  进入复核阶段。'
    const raw='# 初检流程\n\n'+originalQuote+'\n\n![初检图表](data:image/png;base64,'+png.toString('base64')+')\n'
    try{
      await writeFile(file,raw);await scanLibrary(f.store,f.library.id)
      f.runtime.stream=async function*(options){
        f.calls.push(options)
        const data=JSON.parse((options.messages[0]!.content[0] as {text:string}).text)
        expect(data.validationFeedback).toBeUndefined()
        expect(JSON.stringify(options)).not.toContain(png.toString('base64'))
        const output=data.candidates?{groups:[{type:'concept',title:'青松流程',identity:'青松流程',aliases:[],tags:[],members:data.candidates.map((candidate:{id:string})=>candidate.id),conflicts:[]}]}:
          {candidates:[{type:'concept',title:'青松流程',identity:'青松流程',aliases:[],tags:[],mentionOnly:false,claims:[{text:'青松流程的复核安排在初检完成之后。',quote}]}],images:[{id:'旧模型图片判断',decision:'text-covered',reason:'遗留字段不参与正文证据校验。',quote:'这句图表说明不在正文中'}]}
        yield {type:'text-delta',index:0,text:JSON.stringify(output)};yield {type:'finish',reason:{kind:'stop'}}
      }
      const job=await generateWiki(f.store,f.library.id,f.runtime,signal(),undefined,f.attachments)
      expect(job.status).toBe('preview');expect(f.saved).toHaveLength(0)
      expect(job.chunks.every(chunk=>chunk.images.length===0&&chunk.recognitions===undefined)).toBe(true)
      const preview=await new ChangeStore(f.store).preview(f.library.id,job.batchId!)
      expect(preview.pages.find(page=>page.path.startsWith('concepts/'))?.after).toContain('青松流程的复核安排在初检完成之后。')
      const source=preview.pages.find(page=>page.path.startsWith('sources/'))!
      expect(source.after).toContain(originalQuote.replaceAll('\r','').replaceAll('\n',' '));expect(source.after).toContain(png.toString('base64'))
      expect(job.chunks[0]!.candidates[0]!.claims[0]!.evidence.quote).toBe(originalQuote)
      expect(source.after).not.toContain('这句图表说明不在正文中')
      expect(await readFile(file,'utf8')).toBe(raw)
    }finally{await f.cleanup()}
  })
  it('纯图表无主张仍生成完整资料页，提交后可检索且重复生成复用检查点',async()=>{
    const f=await fixture(),file=path.join(f.library.sourceRoots[0]!,'a.md'),runtime=emptyTextModel(f.calls)
    const raw='# 图表资料\n\n![初检记录](data:image/png;base64,'+png.toString('base64')+')\n\n![引用式记录][chart]\n\n[chart]: data:image/png;base64,'+png.toString('base64')+'\n\n<img src="charts/trend.png" alt="趋势图">\n'
    try{
      await mkdir(path.join(f.library.sourceRoots[0]!,'charts'));await writeFile(path.join(f.library.sourceRoots[0]!,'charts/trend.png'),png)
      await writeFile(file,raw);await scanLibrary(f.store,f.library.id)
      const job=await generateWiki(f.store,f.library.id,runtime,signal(),undefined,f.attachments)
      expect(job.status).toBe('preview');expect(job.imageTotal).toBe(3);expect(f.calls).toHaveLength(1);expect(f.saved).toHaveLength(0)
      const changes=new ChangeStore(f.store),preview=await changes.preview(f.library.id,job.batchId!),source=preview.pages.find(page=>page.path.startsWith('sources/'))!
      expect(preview.pages.some(page=>/^(entities|concepts)\//.test(page.path))).toBe(false)
      expect(source.after).toContain('图表请查看原图');expect(source.after).toContain(file)
      expect(source.after).toContain('初检记录');expect(source.after).toContain('引用式记录');expect(source.after).toContain('趋势图')
      expect(source.after?.match(/!\[/g)).toHaveLength(3);expect(source.after).toContain(png.toString('base64'));expect(source.after).toContain('charts/trend.png')
      expect(preview.pages.find(page=>page.path==='index.md')?.after).toContain(source.path)
      expect(JSON.parse(preview.pages.find(page=>page.path==='.llmwiki/knowledge/catalog.json')!.after!)).toEqual({version:1,pages:[],
        labels:pageLabels((await f.store.policy(f.library.id)).policy.wikiLanguage),
        compilation:expect.objectContaining({version:1,inputKey:expect.any(String),analysisKey:expect.any(String),
          sources:expect.arrayContaining([expect.objectContaining({path:file,state:'active',hash:expect.any(String)})]),
          files:expect.arrayContaining([expect.objectContaining({path:source.path,hash:expect.any(String)})])})})
      await expect(readFile(path.join(f.library.wikiPath,source.path))).rejects.toThrow()
      await changes.commit(f.library.id,job.batchId!,preview.batch.digest)
      const query=new WikiQuery(f.store),read=await query.read(source.path)
      expect(read.content).toContain('图表请查看原图');expect(read.content).not.toContain(png.toString('base64'))
      expect((await query.search('初检记录')).results[0]?.path).toBe(source.path)
      expect((await scanLibrary(f.store,f.library.id)).files[0]?.generation).toBe('current')
      expect((await generateWiki(f.store,f.library.id,runtime,signal())).status).toBe('unchanged');expect(f.calls).toHaveLength(1)
      expect(await readFile(file,'utf8')).toBe(raw)
    }finally{await f.cleanup()}
  })
  it('图表资料与正文资料混合时继续生成知识和全部来源页',async()=>{
    const f=await fixture(),quote='青松流程完成初检后进入复核阶段。'
    try{
      await writeFile(path.join(f.library.sourceRoots[0]!,'b.md'),quote);await scanLibrary(f.store,f.library.id)
      f.runtime.stream=async function*(options){
        f.calls.push(options)
        const input=JSON.parse((options.messages[0]!.content[0] as {text:string}).text)
        expect(JSON.stringify(options)).not.toContain(png.toString('base64'))
        const output=input.candidates?{groups:[{type:'concept',title:'青松流程',identity:'青松流程',aliases:[],tags:[],members:input.candidates.map((candidate:{id:string})=>candidate.id),conflicts:[]}]}:
          {candidates:input.text.includes(quote)?[{type:'concept',title:'青松流程',identity:'青松流程',aliases:[],tags:[],mentionOnly:false,claims:[{text:quote,quote}]}]:[],images:[]}
        yield {type:'text-delta',index:0,text:JSON.stringify(output)};yield {type:'finish',reason:{kind:'stop'}}
      }
      const job=await generateWiki(f.store,f.library.id,f.runtime,signal()),preview=await new ChangeStore(f.store).preview(f.library.id,job.batchId!)
      expect(preview.pages.filter(page=>page.path.startsWith('concepts/'))).toHaveLength(1)
      const sources=preview.pages.filter(page=>page.path.startsWith('sources/'));expect(sources).toHaveLength(2)
      expect(sources.find(page=>page.path===`sources/${f.record.id}.md`)?.after).toContain('图表请查看原图')
      expect(sources.find(page=>page.path!==`sources/${f.record.id}.md`)?.after).toContain(quote)
      for(const source of sources)expect(preview.pages.find(page=>page.path==='index.md')?.after).toContain(source.path)
      expect(job.chunks.every(chunk=>chunk.status==='complete')).toBe(true)
    }finally{await f.cleanup()}
  })
  it('无图片且没有正文主张时仍报告无知识，不生成空成果',async()=>{
    const f=await fixture()
    try{
      await writeFile(path.join(f.library.sourceRoots[0]!,'a.md'),'# 无事实资料\n');await scanLibrary(f.store,f.library.id)
      await expect(generateWiki(f.store,f.library.id,emptyTextModel(f.calls),signal())).rejects.toThrow('没有提取到有来源支持的知识')
      expect(await new ChangeStore(f.store).list(f.library.id)).toEqual([])
    }finally{await f.cleanup()}
  })
  it('图表资料页的来源撤出恢复和重建索引保持查询及入口一致',async()=>{
    const f=await fixture()
    try{
      const changes=new ChangeStore(f.store),job=await generateWiki(f.store,f.library.id,emptyTextModel(f.calls),signal())
      const first=await changes.preview(f.library.id,job.batchId!);await changes.commit(f.library.id,job.batchId!,first.batch.digest)
      const source=`sources/${f.record.id}.md`,index=path.join(f.library.wikiPath,'index.md'),query=new WikiQuery(f.store)
      const withdrawn=await prepareSourceState(f.store,f.library.id,[f.record.id],'withdrawn');await changes.commit(f.library.id,withdrawn.id,withdrawn.digest)
      expect((await query.search('初检记录')).results).toHaveLength(0);expect(await readFile(index,'utf8')).not.toContain(source)
      const restored=await prepareSourceState(f.store,f.library.id,[f.record.id],'active');await changes.commit(f.library.id,restored.id,restored.digest)
      expect((await query.search('初检记录')).results[0]?.path).toBe(source);expect(await readFile(index,'utf8')).toContain(source)
      const report=await checkWiki(f.store,f.library.id),rebuilt=await prepareMaintenance(f.store,f.library.id,report.revision,'index')
      await changes.commit(f.library.id,rebuilt.id,rebuilt.digest)
      expect(await readFile(index,'utf8')).toContain(source);expect((await listSources(f.store,f.library.id))[0]?.committedHash).toBe(f.record.hash)
    }finally{await f.cleanup()}
  })
})
