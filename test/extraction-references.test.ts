import { describe,expect,it } from 'vitest'
import { extractionSchema,extractionWithReferences } from '../src/ingest/extraction.js'

const output=(claims:unknown[])=>({candidates:[{type:'concept',title:'职业体验',identity:'研究护士职业体验',aliases:[],tags:[],mentionOnly:false,claims}],images:[]})

describe('纠正输出的原文编号',()=>{
  it('只解析显式原文编号，回填后仍符合原提取格式，保留普通引文',()=>{
    const quote='| 自主 | 全部参与者完全 |\n| 挑战 | 满意研究护士工作 |'
    const data=output([{text:'全部参与者完全满意研究护士工作。',quoteRef:'fragment'},{text:'挑战。',quote:'挑战'}])
    expect(()=>extractionSchema.parse(data)).toThrow()
    const extraction=extractionWithReferences(data,new Map([['fragment',quote]]))
    expect(extraction.candidates[0]!.claims).toEqual([{text:'全部参与者完全满意研究护士工作。',quote},{text:'挑战。',quote:'挑战'}])
    expect(extractionSchema.parse(extraction)).toEqual(extraction)
  })
  it('未知编号或同时填写引文和编号均拒绝，不自动替换错误引文',()=>{
    const references=new Map([['fragment','原文']])
    expect(()=>extractionWithReferences(output([{text:'主张。',quoteRef:'unknown'}]),references)).toThrow('未提供的原文编号')
    expect(()=>extractionWithReferences(output([{text:'主张。',quote:'不存在',quoteRef:'fragment'}]),references)).toThrow()
    expect(extractionWithReferences(output([{text:'主张。',quote:'不存在'}]),references).candidates[0]!.claims[0]!.quote).toBe('不存在')
  })
  it('回填内容仍受原引文非空和长度限制',()=>{
    const data=output([{text:'主张。',quoteRef:'fragment'}])
    expect(()=>extractionWithReferences(data,new Map([['fragment','']]))).toThrow()
    expect(()=>extractionWithReferences(data,new Map([['fragment','字'.repeat(4001)]]))).toThrow()
  })
})
