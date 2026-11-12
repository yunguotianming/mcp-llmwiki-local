// 模型夹具按请求协议返回相同的预定分组；业务结论仍由各场景独立定义。
export function groupingResponse(system:string,groups:{members:string[];conflicts?:string[][]}[]):string {
  if(!system.includes('"singletons"'))return JSON.stringify({groups})
  return JSON.stringify({groups:groups.filter(group=>group.members.length>1).map(({conflicts:_,...group})=>group),singletons:groups.filter(group=>group.members.length===1).flatMap(group=>group.members)})
}
