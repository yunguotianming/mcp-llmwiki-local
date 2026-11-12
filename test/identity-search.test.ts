import { expect,it } from 'vitest'
import { relatedIdentityWindows } from '../src/wiki/identity-search.js'
import type { SearchIdentity } from '../src/wiki/identity-search.js'

const fillers=():SearchIdentity[]=>Array.from({length:80},(_,i)=>({id:'filler-'+i,title:'Term'+i,identity:'Description'+i,aliases:[]}))
const together=(windows:SearchIdentity[][],a:string,b:string)=>windows.some(items=>items.some(item=>item.id===a)&&items.some(item=>item.id===b))
it('标题、别名及身份正文召回跨名称候选，不按实体概念类型隔离',()=>{
  const items=fillers().concat([{id:'a',title:'临床研究协调员',identity:'参与者随访管理',aliases:['CRC']},{id:'b',title:'CRC',identity:'协调研究访视',aliases:[]},
    {id:'c',title:'Independent Name',identity:'参与者随访管理',aliases:[]}])
  const windows=relatedIdentityWindows(items)
  expect(together(windows,'a','b')).toBe(true);expect(together(windows,'a','c')).toBe(true)
  expect(windows.flat().some(item=>item.id==='filler-0')).toBe(false)
})
it('大型同名目录使用有限窗口，排序稳定且窗口内没有重复候选',()=>{
  const items=Array.from({length:200},(_,i)=>({id:String(i).padStart(3,'0'),title:'共享名称',identity:'上下文'+i,aliases:[]}))
  const windows=relatedIdentityWindows(items)
  expect(windows.length).toBeLessThan(items.length*2);expect(windows.every(items=>items.length<=31&&new Set(items.map(item=>item.id)).size===items.length)).toBe(true)
  expect(relatedIdentityWindows(items)).toEqual(windows)
})
it('没有检索命中不丢候选，也不凭空建立模型比较；小目录一次覆盖',()=>{
  const items=fillers();expect(relatedIdentityWindows(items)).toEqual([])
  expect(relatedIdentityWindows(items.slice(0,5))).toEqual([items.slice(0,5)])
})
it('取消后停止建立比较计划',()=>{
  const abort=new AbortController();abort.abort(new Error('用户取消'))
  expect(()=>relatedIdentityWindows(fillers(),abort.signal)).toThrow('用户取消')
  expect(()=>relatedIdentityWindows(fillers().slice(0,2),abort.signal)).toThrow('用户取消')
})
it('正文补充跨名称召回，历史已确认关系仍进入模型比较窗口',()=>{
  const items=fillers().concat([{id:'a',title:'Alpha',identity:'UniqueA',aliases:[]},{id:'b',title:'Beta',identity:'UniqueB',aliases:[]},
    {id:'c',title:'Gamma',identity:'UniqueC',aliases:[]}])
  const windows=relatedIdentityWindows(items,undefined,{contexts:new Map([['a','访视参与者失访'],['b','访视参与者随访']]),groups:[['b','c']]})
  expect(together(windows,'a','b')).toBe(true);expect(together(windows,'b','c')).toBe(true)
})
