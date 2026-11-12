import { describe,expect,it } from 'vitest'
import { candidatesFrom } from '../src/ingest/extraction.js'

function extract(text:string,quote:string) {
  return candidatesFrom({candidates:[{type:'concept',title:'初检',identity:'初检流程',aliases:[],tags:[],mentionOnly:false,
    claims:[{text:'初检完成了20份样本中的18份。',quote}]}],images:[]},text,{id:'chunk',start:100},{id:'source',hash:'version'},
    offset=>({originalStart:offset+200,line:3}),false)[0]!.claims[0]!.evidence
}

describe('正文引文定位',()=>{
  it('仅空白不同则保存实际原文片段及偏移',()=>{
    const raw='CRNs complete\r\n  18/20 cases.',text='说明\n'+raw+'\n后记'
    const evidence=extract(text,'CRNs complete 18/20 cases.')
    expect(evidence).toMatchObject({quote:raw,cleanStart:103,originalStart:303,line:3})
    expect(text.slice(evidence.cleanStart-100,evidence.cleanStart-100+evidence.quote.length)).toBe(evidence.quote)
  })
  it('存在逐字匹配时优先选择逐字片段，特殊字符按原文处理',()=>{
    const quote='CRNs (a+b)[1].* 18/20?',text=quote.replace(' 18','\n 18')+'\n'+quote
    expect(extract(text,quote).cleanStart).toBe(100+text.lastIndexOf(quote))
    expect(()=>extract('CRNs aaaa 18/20?',quote)).toThrow('无法在当前段落定位')
  })
  it('数值变动和改写仍无法作为正文引文',()=>{
    const text='CRNs complete\n 18/20 cases.'
    expect(()=>extract(text,'CRNs complete 19/20 cases.')).toThrow('无法在当前段落定位')
    expect(()=>extract(text,'CRNs finish 18/20 cases.')).toThrow('无法在当前段落定位')
  })
  it('不消除词间空白来拼接不同文字',()=>{
    expect(()=>extract('CRNs complete 18/20 cases.','CRNs complete18/20 cases.')).toThrow('无法在当前段落定位')
  })
  it('表格跨行拼接引文被拒绝并反馈纠正方法，连续原文仍可定位',()=>{
    const text="| Autonomy | Finds value in being a 'change | Personal expertise |\n| Challenge | agent' and the supportive link | Responsibility |"
    const stitched="Finds value in being a 'change | agent' and the supportive link"
    expect(()=>extract(text,stitched)).toThrow('表格同一列的跨行文字在 Markdown 中通常不连续')
    expect(()=>extract(text,"Finds value in being a 'change agent' and the supportive link")).toThrow('删掉分隔符')
    expect(()=>extract(text,stitched)).toThrow(JSON.stringify(text))
    const quote=text.slice(text.indexOf('Finds value'),text.indexOf(' | Responsibility'))
    expect(extract(text,quote)).toMatchObject({quote,cleanStart:100+text.indexOf('Finds value')})
  })
})
