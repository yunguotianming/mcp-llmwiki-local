import { parse,stringify } from 'yaml'
import type { Claim } from '../ingest/extraction.js'
import type { SourceRecord } from '../ingest/scanner.js'
import { signature } from '../storage/files.js'
import type { Compilation } from './compilation.js'
import { pageLabels } from './language.js'
import type { PageLabels } from './language.js'
import type { GenerationDiagnostic } from './generation-diagnostics.js'
export const BEGIN='<!-- llmwiki:begin v1 -->',END='<!-- llmwiki:end v1 -->'
export const WIKI_GUIDE='## 阅读与维护\n\n从 [知识索引](index.md) 进入；在 dsh 中通过 wiki_search 检索，再用 wiki_read 阅读依据。\n\n本库从原始资料正文提取和综合知识。每项主张保留来源及版本；来源分歧分别列出。原文图片保留在来源页供阅读，不再识图或 OCR；图片编码不作为正文发送模型。\n\n修改先形成变更批次，查看差异并确认后写入。已提交批次可生成撤销预览；存在后续修改时先核对冲突。原始资料目录保持只读。'
export const escapeText=(text:string)=>text.replaceAll('\r','').replaceAll('\n',' ').replaceAll('<','&lt;').replaceAll('>','&gt;')
export function sourceIndex(records:Pick<SourceRecord,'id'|'relativePath'>[],label='原始资料'):string {
  return records.length?'\n\n## '+label+'\n\n'+records.map(record=>`- [${escapeText(record.relativePath).replaceAll('[','\\[').replaceAll(']','\\]')}](sources/${record.id}.md)`).join('\n'):''
}
export interface KnowledgePage {path:string;pageId?:string;language?:string;labels?:PageLabels;type:'entity'|'concept';title:string;identity:string;aliases:string[];tags:string[];claims:Claim[];conflicts:string[][];blockHash:string;coverageWarning?:string}
export interface KnowledgeCatalog {version:1;pages:KnowledgePage[];compilation?:Compilation;labels?:PageLabels;quality?:{complete:false;diagnostics:GenerationDiagnostic[]}}
export function blockSignature(content:string):string|null {
  const first=content.indexOf(BEGIN),last=content.indexOf(END)
  return first>=0&&last>first?signature(content.slice(first,last+END.length)):null
}
export function managedDocument(current:string|null,title:string,metadata:Record<string,unknown>,body:string):string {
  const block=BEGIN+'\n'+body+'\n'+END
  if(current!==null){
    const first=current.indexOf(BEGIN),last=current.indexOf(END)
    if(first<0||last<first||current.indexOf(BEGIN,first+1)>=0)throw new Error('目标包含未登记人工内容，需先确认接入与合并：'+title)
    const updated=current.slice(0,first)+block+current.slice(last+END.length)
    const fm=/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(updated)
    if(!fm)throw new Error('已生成页面缺少元数据，请先核对：'+title)
    const existing:unknown=parse(fm[1]!)
    if(!existing||typeof existing!=='object'||Array.isArray(existing))throw new Error('页面元数据格式无效：'+title)
    return '---\n'+stringify({...existing,title,...metadata})+'---\n'+updated.slice(fm[0].length)
  }
  return '---\n'+stringify({title,...metadata})+'---\n\n# '+escapeText(title)+'\n\n'+block+'\n'
}
export function utilityDocument(current: string | null, title: string, body: string): string {
  if (current === null) return managedDocument(null, title, { type: 'index' }, body)
  const start = current.indexOf(BEGIN), end = current.indexOf(END)
  if (start < 0 && end < 0) return current + (current.endsWith('\n') ? '\n' : '\n\n') + BEGIN + '\n' + body + '\n' + END + '\n'
  if (start < 0 || end < start || current.indexOf(BEGIN, start + 1) >= 0 || current.indexOf(END, end + 1) >= 0) throw new Error('维护页面的生成区标记无效，请先核对：' + title)
  return current.slice(0, start) + BEGIN + '\n' + body + '\n' + END + current.slice(end + END.length)
}
export function renderKnowledge(page:KnowledgePage,current:string|null,records:SourceRecord[],options: { includeInactive?: boolean; sourcePrefix?: string } = {}):string {
  const labels=pageLabels(page.language??'zh',page.labels)
  const chinese=/^zh(?:-|$)/i.test(page.language??'zh')
  const active=new Map(records.filter(record=>record.state==='active').map(record=>[record.id,record.hash]))
  const claims=page.claims.filter(claim=>options.includeInactive||active.get(claim.evidence.sourceId)===claim.evidence.hash),ids=new Set(claims.map(claim=>claim.id))
  const conflicts=page.conflicts.map(group=>group.filter(id=>ids.has(id))).filter(group=>group.length>=2),conflicting=new Set(conflicts.flat())
  const link=(claim:Claim)=>`[${labels.evidence}](${options.sourcePrefix ?? '../sources'}/${claim.evidence.sourceId}.md#${claim.evidence.chunkId})${claim.evidence.image?'（图像识别观察）':''}`
  const body=(page.coverageWarning?'> '+escapeText(page.coverageWarning)+' ['+labels.evidence+'](../quality-report.md)\n\n':'')+'## '+labels.knowledge+'\n\n'+(claims.length?claims.map(claim=>`- ${escapeText(claim.text)}${conflicting.has(claim.id)?' **（'+(chinese?'存在来源分歧':labels.disagreement)+'）**':''} ${link(claim)}`).join('\n'):labels.noEvidence)
    +(conflicts.length?'\n\n## '+labels.disagreement+'\n\n'+conflicts.map((group,index)=>`### ${labels.conflict} ${index+1}\n\n`+group.map(id=>{const claim=claims.find(claim=>claim.id===id)!;return `- ${escapeText(claim.text)} ${link(claim)}`}).join('\n')).join('\n\n'):'')
    +'\n\n## '+labels.references+'\n\n'+claims.map(claim=>`- ${escapeText(claim.evidence.quote)} — ${chinese?'来源':labels.source} ${claim.evidence.sourceId}，${chinese?'版本':labels.version} ${claim.evidence.hash.slice(0,12)}，${chinese?'第 '+claim.evidence.line+' 行':labels.line+' '+claim.evidence.line}${claim.evidence.image?`，${labels.image} ${claim.evidence.image.id}，${claim.evidence.image.provider}/${claim.evidence.image.model}`:''}。`).join('\n')
  return managedDocument(current,page.title,{type:page.type,identity:page.identity,aliases:page.aliases,tags:page.tags,
    ...(page.pageId?{pageId:page.pageId}:{}),...(page.language?{language:page.language}:{}),
    sources:[...new Set(claims.map(claim=>claim.evidence.sourceId))],llmwikiNoActiveEvidence:claims.length===0},body)
}
