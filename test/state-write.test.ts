import { it,expect,vi,afterEach } from 'vitest'
import path from 'node:path'
const failures=vi.hoisted(()=>({codes:[] as string[],calls:0,cleanup:false}))
vi.mock('node:fs/promises',async importOriginal=>{
  const fs=await importOriginal<typeof import('node:fs/promises')>()
  return {...fs,unlink:async(file:Parameters<typeof fs.unlink>[0])=>{
    if(failures.cleanup&&String(file).endsWith('.tmp'))throw Object.assign(new Error('模拟暂存清理占用'),{code:'EACCES'})
    return fs.unlink(file)
  },rename:async(...args:Parameters<typeof fs.rename>)=>{
    failures.calls++
    const code=failures.codes.shift()
    if(code)throw Object.assign(new Error('模拟文件替换失败：'+code),{code})
    return fs.rename(...args)
  }}
})
import { readFile,readdir } from 'node:fs/promises'
import { writeState } from '../src/storage/files.js'
import { withLibraryLock } from '../src/storage/lock.js'
import { temporaryWorkspace } from './temp.js'
afterEach(()=>{failures.codes=[];failures.calls=0;failures.cleanup=false})
const relative='.llmwiki/jobs/example.json'

it.skipIf(process.platform!=='win32')('Windows短暂占用重试原子替换，目标始终保留有效JSON',async()=>{
  const temp=await temporaryWorkspace()
  try{
    await withLibraryLock(temp.root,'test-write',async()=>{
      await writeState(temp.root,relative,{version:1});failures.calls=0
      failures.codes=['EPERM','EACCES','EBUSY']
      const pending=writeState(temp.root,relative,{version:2})
      expect(JSON.parse(await readFile(path.join(temp.root,relative),'utf8'))).toEqual({version:1})
      await pending
      expect(failures.calls).toBe(4)
      expect(JSON.parse(await readFile(path.join(temp.root,relative),'utf8'))).toEqual({version:2})
      expect((await readdir(path.join(temp.root,'.llmwiki'))).filter(name=>name.endsWith('.tmp'))).toEqual([])
    })
  }finally{await temp.cleanup()}
})

it.skipIf(process.platform!=='win32')('持续占用重试有界，失败后保留旧状态并清理暂存',async()=>{
  const temp=await temporaryWorkspace()
  try{
    await withLibraryLock(temp.root,'test-write',async()=>{
      await writeState(temp.root,relative,{version:1});failures.calls=0;failures.codes=Array(7).fill('EPERM')
      await expect(writeState(temp.root,relative,{version:2})).rejects.toMatchObject({code:'EPERM',ioDiagnostic:{operation:'rename',attempts:7,writerPid:process.pid,holder:'unknown',file:path.join(temp.root,relative)}})
      expect(failures.calls).toBe(7)
      expect(JSON.parse(await readFile(path.join(temp.root,relative),'utf8'))).toEqual({version:1})
      expect((await readdir(path.join(temp.root,'.llmwiki'))).filter(name=>name.endsWith('.tmp'))).toEqual([])
    })
  }finally{await temp.cleanup()}
})

it('清理暂存再次失败时保留原始IO诊断及附加清理错误',async()=>{
  const temp=await temporaryWorkspace()
  try{
    await writeState(temp.root,relative,{version:1});failures.codes=['ENOSPC'];failures.cleanup=true
    await expect(writeState(temp.root,relative,{version:2})).rejects.toMatchObject({code:'ENOSPC',ioDiagnostic:{operation:'rename'},cleanupError:{code:'EACCES'}})
    expect(JSON.parse(await readFile(path.join(temp.root,relative),'utf8'))).toEqual({version:1})
  }finally{failures.cleanup=false;await temp.cleanup()}
})

it('磁盘等非占用错误立即报错，目标内容不变',async()=>{
  const temp=await temporaryWorkspace()
  try{
    await withLibraryLock(temp.root,'test-write',async()=>{
      await writeState(temp.root,relative,{version:1});failures.calls=0;failures.codes=['ENOSPC']
      await expect(writeState(temp.root,relative,{version:2})).rejects.toMatchObject({code:'ENOSPC'})
      expect(failures.calls).toBe(1)
      expect(JSON.parse(await readFile(path.join(temp.root,relative),'utf8'))).toEqual({version:1})
    })
  }finally{await temp.cleanup()}
})

it('实际并发读取与连续保存只读到完整状态，最终版本正确',async()=>{
  const temp=await temporaryWorkspace();let reads=0
  try{
    await withLibraryLock(temp.root,'test-write',async()=>{
      await writeState(temp.root,relative,{version:0,text:'正文'.repeat(10000)})
      const reader=async()=>{for(let index=0;index<100;index++){const data=JSON.parse(await readFile(path.join(temp.root,relative),'utf8'));expect(data.text).toBe('正文'.repeat(10000));expect(data.version).toBeGreaterThanOrEqual(0);reads++}}
      const readers=Promise.all([reader(),reader()])
      try{for(let version=1;version<=20;version++)await writeState(temp.root,relative,{version,text:'正文'.repeat(10000)})}
      finally{await readers}
      expect(reads).toBe(200)
      expect(JSON.parse(await readFile(path.join(temp.root,relative),'utf8')).version).toBe(20)
    })
  }finally{await temp.cleanup()}
})
