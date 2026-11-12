export interface SearchIdentity {id:string;title:string;identity:string;aliases:string[]}
const normalize=(text:string)=>text.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim()
export function terms(text:string):Set<string>{
  const result=new Set<string>()
  for(const word of normalize(text).match(/[\p{L}\p{N}]+/gu)??[]){
    if(/\p{Script=Han}/u.test(word)){
      const chars=Array.from(word)
      if(chars.length===1)result.add(word)
      for(let i=0;i<chars.length-1;i++)result.add(chars[i]!+chars[i+1]!)
    }else if(word.length>1)result.add(word)
  }
  return result
}
// 借鉴相关候选窗口：本地召回只缩小比较范围，是否同一对象仍由模型判断。
export function relatedIdentityWindows<T extends SearchIdentity>(nodes:T[],signal?:AbortSignal,options:{contexts?:ReadonlyMap<string,string>;groups?:string[][]}={}):T[][] {
  signal?.throwIfAborted()
  const topK=30,postings=new Map<string,number[]>(),names=new Map<string,number[]>(),vectors:Map<string,number>[]=[]
  if(nodes.length<=topK*2)return nodes.length>1?[nodes]:[]
  for(const [index,node] of nodes.entries()){
    signal?.throwIfAborted()
    const vector=new Map<string,number>()
    for(const term of terms(options.contexts?.get(node.id)??''))vector.set(term,0.4)
    for(const term of terms(node.identity))vector.set(term,1)
    for(const name of [node.title,...node.aliases]){
      const key=normalize(name)
      if(key)names.set(key,[...(names.get(key)??[]),index])
      for(const term of terms(name))vector.set(term,3)
    }
    vectors.push(vector)
    for(const term of vector.keys())postings.set(term,[...(postings.get(term)??[]),index])
  }
  // 高频背景词不产生相关关系；正文只用于本地召回，不随比较输入反复发送。
  const weights=new Map([...postings].filter(([,items])=>items.length<=nodes.length*0.2).map(([term,items])=>[term,Math.log(1+nodes.length/items.length)]))
  const norms=vectors.map(vector=>Math.sqrt([...vector].reduce((sum,[term,value])=>sum+(value*(weights.get(term)??0))**2,0)))
  const edges=nodes.map(()=>new Map<number,number>())
  const connect=(a:number,b:number,score:number)=>{if(a!==b){edges[a]!.set(b,Math.max(edges[a]!.get(b)??0,score));edges[b]!.set(a,Math.max(edges[b]!.get(a)??0,score))}}
  for(const [index,node] of nodes.entries()){
    signal?.throwIfAborted()
    const scores=new Map<number,number>(),exact=new Set<number>()
    for(const name of [node.title,...node.aliases])for(const other of names.get(normalize(name))??[])if(other!==index)exact.add(other)
    for(const [term,value] of vectors[index]!){
      const weight=weights.get(term)
      if(weight===undefined)continue
      for(const other of postings.get(term)!)if(other!==index)scores.set(other,(scores.get(other)??0)+value*vectors[other]!.get(term)!*weight*weight)
    }
    for(const other of exact)if(!scores.has(other))scores.set(other,0)
    const ranked=[...scores].map(([other,score])=>({other,score:(score/(norms[index]!*norms[other]!)||0)+(exact.has(other)?1:0)}))
      .sort((a,b)=>b.score-a.score||nodes[a.other]!.id.localeCompare(nodes[b.other]!.id)).slice(0,topK)
    for(const {other,score} of ranked)connect(index,other,score)
  }
  // 旧模型已经确认的关系补充召回边，仍由当前比较校验，不能按历史标签直接合并。
  const positions=new Map(nodes.map((node,index)=>[node.id,index]))
  for(const group of options.groups??[]){
    const members=group.map(id=>positions.get(id)).filter((index):index is number=>index!==undefined)
    for(let i=0;i<members.length;i++)for(let j=i+1;j<members.length;j++)connect(members[i]!,members[j]!,2)
  }
  const result:T[][]=[]
  while(true){
    signal?.throwIfAborted()
    let seed=-1
    for(let i=0;i<nodes.length;i++)if(edges[i]!.size&&(seed<0||edges[i]!.size>edges[seed]!.size))seed=i
    if(seed<0)break
    const indices:number[]=[],selected=new Set<number>(),gains=new Map<number,{count:number;score:number}>()
    let next=seed
    while(indices.length<=topK){
      indices.push(next);selected.add(next);gains.delete(next)
      for(const [other,score] of edges[next]!)if(!selected.has(other)){
        const gain=gains.get(other)??{count:0,score:0};gain.count++;gain.score+=score;gains.set(other,gain)
      }
      const ranked=[...gains].sort(([a,x],[b,y])=>y.count-x.count||y.score-x.score||nodes[a]!.id.localeCompare(nodes[b]!.id))
      if(!ranked.length)break
      next=ranked[0]![0]
    }
    result.push(indices.map(index=>nodes[index]!))
    // 同一窗口已经包含的边不再另建窗口，避免近义簇中的重复请求。
    for(const a of indices)for(const b of indices)edges[a]!.delete(b)
  }
  return result
}
