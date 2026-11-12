import path from 'node:path'
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import type { LibraryRegistration } from '../domain/config.js'
import { actualPath, directory, safePath, within } from './paths.js'
const manifestSchema=z.object({version:z.literal(1),vaultId:z.string().nullish(),updatedAt:z.string().optional(),databases:z.array(z.object({
  name:z.string().trim().min(1),description:z.string().default(''),wikiFolder:z.string().min(1),dshEnabled:z.boolean().default(true),
}))})
export interface SharedManifest {found:boolean;vaultPath:string;libraries:{name:string;description:string;wikiPath:string;enabled:boolean}[]}
export async function readSharedManifest(input:string):Promise<SharedManifest>{
  const vaultPath=await directory(input)
  await directory(await safePath(vaultPath,'.obsidian'))
  let raw:string
  try{raw=await readFile(await safePath(vaultPath,'.llm-wiki-databases.json'),'utf8')}
  catch(error){if(error instanceof Error && 'code' in error && error.code==='ENOENT')return {found:false,vaultPath,libraries:[]};throw error}
  const manifest=manifestSchema.parse(JSON.parse(raw)),libraries:SharedManifest['libraries']=[],seen=new Set<string>()
  for(const database of manifest.databases){
    if(path.isAbsolute(database.wikiFolder))throw new Error('共享清单的 wikiFolder 必须相对 Vault。')
    const wikiPath=await actualPath(path.resolve(vaultPath,database.wikiFolder))
    if(!within(vaultPath,wikiPath)||wikiPath===vaultPath)throw new Error('共享清单目录越出 Vault 或指向 Vault 根。')
    const key=wikiPath.toLowerCase();if(seen.has(key))throw new Error('共享清单重复登记了同一目录。');seen.add(key)
    libraries.push({name:database.name,description:database.description,wikiPath,enabled:database.dshEnabled})
  }
  return {found:true,vaultPath,libraries}
}
export async function resolveSharedRegistration(library:LibraryRegistration):Promise<LibraryRegistration|null>{
  if(library.kind!=='obsidian'||!library.vaultPath)return library
  const manifest=await readSharedManifest(library.vaultPath)
  if(!manifest.found)return library
  const root=await actualPath(library.wikiPath),entry=manifest.libraries.find(item=>item.wikiPath.toLowerCase()===root.toLowerCase())
  if(!entry||!entry.enabled)return null
  return {...library,name:entry.name,description:entry.description}
}
