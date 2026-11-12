import type { LibraryPolicy } from '../domain/policy.js'
import type { Candidate,Extraction } from './extraction.js'
export interface AnalysisState {rounds?:Extraction[];convergence?:'exhausted'|'low-yield'|'limit'|'round-limit'|'partial'}
export async function analyzeRounds(state:AnalysisState,policy:LibraryPolicy,length:number,
  extract:(known:Candidate[],batchSize:number,round:number)=>Promise<Extraction>,validate:(extraction:Extraction,round:number)=>Candidate[],persist:()=>Promise<void>,recover?:(error:unknown,round:number)=>boolean):Promise<{candidates:Candidate[];images:Extraction['images']}>{
  const profile={minimal:[5,1,5],coarse:[10,3,10],balanced:[15,4,25],standard:[20,6,50],detailed:[25,9,75],fine:[30,12,100],custom:[Math.min(50,Math.max(5,policy.customEntityLimit+policy.customConceptLimit)),Math.max(1,Math.ceil((policy.customEntityLimit+policy.customConceptLimit)/50)),Infinity]}[policy.extractionGranularity]!
  let batchSize=profile[0]!,reduced=false
  const roundLimit=Math.min(profile[1]!*3,Math.max(2,Math.ceil(length/2000)+2)),totalLimit=policy.extractionGranularity==='custom'?Infinity:Math.min(profile[2]!,length<20000?Math.max(5,Math.ceil(length/600)):Infinity)
  const result:Candidate[]=[],images=new Map<string,Extraction['images'][number]>()
  state.rounds??=[]
  const normalize=(value:string)=>value.normalize('NFKC').trim().toLocaleLowerCase()
  const claimKey=(claim:Candidate['claims'][number])=>JSON.stringify([claim.text,claim.evidence.quote,claim.evidence.image?.id])
  for(let round=0;round<roundLimit;round++){
    let extraction=state.rounds[round]
    const fresh=!extraction
    try{extraction??=await extract(result,batchSize,round)}catch(error){
      if(!result.length||!recover?.(error,round))throw error
      state.convergence='partial';break
    }
    const candidates=validate(extraction,round);let added=0
    if(fresh){state.rounds.push(extraction);await persist()}
    for(const candidate of candidates){
      const known=result.find(item=>item.type===candidate.type&&normalize(item.identity)===normalize(candidate.identity)&&normalize(item.title)===normalize(candidate.title))
      if(known){
        const keys=new Set(known.claims.map(claimKey)),fresh=candidate.claims.filter(claim=>!keys.has(claimKey(claim)))
        known.claims.push(...fresh);known.aliases=[...new Set([...known.aliases,...candidate.aliases])];known.tags=[...new Set([...known.tags,...candidate.tags])];added+=fresh.length
      }else{
        const typeCap=policy.extractionGranularity==='custom'?(candidate.type==='entity'?policy.customEntityLimit:policy.customConceptLimit):Infinity
        if(result.length>=totalLimit||result.filter(item=>item.type===candidate.type).length>=typeCap)continue
        result.push(structuredClone(candidate));added++
      }
    }
    for(const image of extraction.images)if(!images.has(image.id))images.set(image.id,image)
    if(!added){state.convergence='exhausted';break}
    if(result.length>=totalLimit||(policy.extractionGranularity==='custom'&&result.filter(item=>item.type==='entity').length>=policy.customEntityLimit&&result.filter(item=>item.type==='concept').length>=policy.customConceptLimit)){state.convergence='limit';break}
    if(added<batchSize/2&&batchSize>5){
      if(reduced){state.convergence='low-yield';break}
      batchSize=Math.max(5,Math.floor(batchSize/2));reduced=true
    }
    if(round===roundLimit-1)state.convergence='round-limit'
  }
  await persist();return {candidates:result,images:[...images.values()]}
}
