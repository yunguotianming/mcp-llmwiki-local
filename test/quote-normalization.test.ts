import { expect,it } from 'vitest'
import { candidatesFrom,locateQuote } from '../src/ingest/extraction.js'

it('NFKC大小写和排版差异命中后返回连续原文及真实偏移',()=>{
  const raw='**ＣＲＮｓ** reported: CAFÉ cases.',text='前言\n'+raw+'\n后记'
  const found=locateQuote(text,'crns reported cafe\u0301 cases')
  expect(found.offset).toBe(5);expect(found.quote).toBe('ＣＲＮｓ** reported: CAFÉ cases')
  expect(text.slice(found.offset,found.offset+found.quote.length)).toBe(found.quote)
})
it('PDF连字符断词和Markdown链接仍回填包含原标记的原文',()=>{
  const text='The pre-\npared **protocol** [applies](https://example.test) today.'
  const found=locateQuote(text,'the prepared protocol applies today')
  expect(found.offset).toBe(0);expect(found.quote).toBe(text.slice(0,-1))
})
it('小数范围正负号和比较符号不视为排版差异',()=>{
  const text='OR = 1.5; p < 0.05; change -2; range 10–20.'
  for(const quote of ['OR = 15','p > 0.05','change 2','range 1020'])expect(locateQuote(text,quote).offset).toBe(-1)
})
it('不跳过表格邻列、不粘合英文词，归一化歧义不猜位置',()=>{
  expect(locateQuote('| first | other |\n| second | last |','first second').offset).toBe(-1)
  expect(locateQuote('|甲|乙|','甲乙').offset).toBe(-1)
  expect(locateQuote('| FIRST | SECOND |','first second').offset).toBe(-1)
  expect(locateQuote('complete 18/20 cases','complete18/20 cases').offset).toBe(-1)
  expect(locateQuote('ALPHA case; Alpha case','alpha case').offset).toBe(-1)
})
it('显式隔离时只移除无法定位的主张并保留原始诊断',()=>{
  const issues:unknown[]=[],candidates=candidatesFrom({candidates:[{type:'concept',title:'流程',identity:'流程',aliases:[],tags:[],mentionOnly:false,
    claims:[{text:'有效事实',quote:'有效事实'},{text:'缺失事实',quote:'不存在的证据'}]}],images:[]},'有效事实',{id:'chunk',start:12},{id:'source',hash:'hash'},offset=>({originalStart:offset+3,line:2}),false,[],issue=>issues.push(issue))
  expect(candidates[0]!.claims).toHaveLength(1);expect(candidates[0]!.claims[0]!.evidence.cleanStart).toBe(12)
  expect(issues).toMatchObject([{text:'缺失事实',quote:'不存在的证据',candidate:0,claim:1}])
})
