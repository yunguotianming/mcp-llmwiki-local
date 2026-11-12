import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { withLibraryLock } from '../src/storage/lock.js'
import { safePath, validateRoots } from '../src/storage/paths.js'
import { temporaryWorkspace } from './temp.js'
import { scanLibrary } from '../src/ingest/scanner.js'
import { validatePolicy } from '../src/domain/policy.js'

describe('库状态、权限与快照', () => {
  it.skipIf(process.platform !== 'win32')('默认 .llmwiki 不设置 Windows 隐藏属性，自定名称目录保持可见', async () => {
    const temp = await temporaryWorkspace()
    try {
      for (const folder of ['.llmwiki', '自定义Wiki']) {
        const library = newLibrary('hidden-test'); library.wikiPath = path.join(temp.root, '中文 H 目录', folder)
        const registry = emptyRegistry(); registry.libraries = [library]
        const store = new LibraryStore(() => registry)
        expect((await store.initialize(library.id)).initialized).toBe(true)
        const { stdout } = await promisify(execFile)('attrib.exe', [library.wikiPath], { windowsHide: true })
        // 路径可能使用本地代码页；只读取盘符或 UNC 路径之前的 ASCII 属性栏。
        const attributes = stdout.match(/^([A-Z ]+)(?:[A-Za-z]:\\|\\\\)/)?.[1]
        expect(attributes).toBeDefined()
        expect(attributes!.includes('H')).toBe(false)
      }
    } finally { await temp.cleanup() }
  })

  it('只读库查询不创建状态区，后端拒绝初始化', async () => {
    const temp = await temporaryWorkspace()
    try {
      const library = newLibrary('readonly'); library.wikiPath = temp.root; library.mode = 'readonly'
      const registry = emptyRegistry(); registry.libraries = [library]
      const store = new LibraryStore(() => registry)
      expect((await store.policy(library.id)).initialized).toBe(false)
      await expect(store.initialize(library.id)).rejects.toThrow('只读')
      expect(await readdir(temp.root)).toEqual([])
    } finally { await temp.cleanup() }
  })
  it('策略随库持久化且绑定版本，拒绝静默覆盖', async () => {
    const temp = await temporaryWorkspace()
    try {
      const library = newLibrary('policy'); library.wikiPath = temp.root
      const registry = emptyRegistry(); registry.libraries = [library]
      const store = new LibraryStore(() => registry), first = await store.initialize(library.id)
      expect(first.policy.analysisConcurrency).toBe(1);expect(first.policy.pageGenerationConcurrency).toBe(3)
      const next = await store.savePolicy(library.id, { ...first.policy, wikiLanguage: 'zh-CN',analysisConcurrency:50,pageGenerationConcurrency:50 }, first.revision)
      expect(next.policy.wikiLanguage).toBe('zh-CN')
      expect(next.policy.analysisConcurrency).toBe(50);expect(next.policy.pageGenerationConcurrency).toBe(50);expect(validatePolicy(next.policy)).toEqual([])
      expect(validatePolicy({...next.policy,concurrencyLimit:1000,analysisConcurrency:1000,pageGenerationConcurrency:1000})).toEqual([])
      const invalid={...next.policy,analysisConcurrency:1001,pageGenerationConcurrency:1001}
      expect(validatePolicy(invalid)).toContain('analysisConcurrency 应为 1～1000 的整数。')
      expect(validatePolicy(invalid)).toContain('pageGenerationConcurrency 应为 1～1000 的整数。')
      await expect(store.savePolicy(library.id,invalid,next.revision)).rejects.toThrow()
      await expect(store.savePolicy(library.id, first.policy, first.revision)).rejects.toThrow('已被修改')
      expect(await readFile(path.join(temp.root, '.llmwiki/library.json'), 'utf8')).toContain('policy')
      await expect(store.savePolicy(library.id, { ...next.policy, apiKey: '不得保存' }, next.revision)).rejects.toThrow()
      expect(JSON.stringify(registry)).not.toContain('wikiLanguage')
    } finally { await temp.cleanup() }
  })
  it('同库排他且失败后释放本进程持有的锁', async () => {
    const temp = await temporaryWorkspace()
    try {
      await withLibraryLock(temp.root, 'first', async () => {
        await expect(withLibraryLock(temp.root, 'second', async () => {})).rejects.toThrow('写锁')
      })
      await expect(withLibraryLock(temp.root, 'failure', async () => { throw new Error('测试失败') })).rejects.toThrow('测试失败')
      await expect(withLibraryLock(temp.root, 'next', async () => 'ok')).resolves.toBe('ok')
    } finally { await temp.cleanup() }
  })
  it('允许 Wiki 位于资料目录内，拒绝把 Wiki 本身或其内部作为资料和库内路径越界', async () => {
    const temp = await temporaryWorkspace()
    try {
      const wiki = path.join(temp.root, 'wiki'), child = path.join(wiki, 'concepts')
      await mkdir(child, { recursive: true })
      expect(await validateRoots(wiki, [temp.root])).toEqual({ wiki: await realpath(wiki), sources: [await realpath(temp.root)] })
      await expect(validateRoots(wiki, [wiki])).rejects.toThrow('不能是 Wiki 目录本身')
      await expect(validateRoots(wiki, [child])).rejects.toThrow('不能是 Wiki 目录本身')
      await expect(safePath(temp.root, '../outside.md')).rejects.toThrow('越出')
    } finally { await temp.cleanup() }
  })
  it('内嵌 Wiki 整个子树和输出图片均不作为原始资料，重扫不回灌且原文不变', async () => {
    const temp = await temporaryWorkspace()
    try {
      const library = newLibrary('nested'); library.wikiPath = path.join(temp.root, 'wiki'); library.sourceRoots = [temp.root]
      const registry = emptyRegistry(); registry.libraries = [library]
      const store = new LibraryStore(() => registry); await store.initialize(library.id)
      await mkdir(path.join(library.wikiPath, 'concepts'))
      await writeFile(path.join(library.wikiPath, 'concepts', 'output.md'), '# 已有成果\n不参与扫描。')
      await writeFile(path.join(library.wikiPath, 'output.png'), '虚构图片')
      const raw = '# 原始资料\n\n内容不变。![输出图片](wiki/output.png)'
      await writeFile(path.join(temp.root, 'note.md'), raw)
      const first = await scanLibrary(store, library.id)
      expect(first.files.map(file => path.basename(file.path))).toEqual(['note.md'])
      expect(first.errors).toEqual([])
      expect(first.excluded).toContainEqual({ path: await realpath(library.wikiPath), reason: 'Wiki 输出目录不参与资料扫描。' })
      const versions = await readdir(path.join(library.wikiPath, '.llmwiki/sources', first.files[0]!.sourceId))
      const version = JSON.parse(await readFile(path.join(library.wikiPath, '.llmwiki/sources', first.files[0]!.sourceId, versions[0]!), 'utf8'))
      expect(version.images[0]).toMatchObject({ state: 'failed', reason: '图片路径超出已选资料范围或属于 Wiki 输出。' })
      await writeFile(path.join(library.wikiPath, 'concepts', 'output.md'), '# 更新的成果\n仍不参与扫描。')
      const second = await scanLibrary(store, library.id)
      expect(second.files).toHaveLength(1); expect(second.files[0]?.change).toBe('unchanged')
      expect(await readFile(path.join(temp.root, 'note.md'), 'utf8')).toBe(raw)
    } finally { await temp.cleanup() }
  })
  it('扫描保留原件、复用未变版本，图片编码不进入正文', async () => {
    const temp = await temporaryWorkspace()
    try {
      const source = path.join(temp.root, 'source'), wiki = path.join(temp.root, 'wiki')
      await mkdir(source); const raw = '# 资料\n\n正文。\n\n![图片](data:image/png;base64,aGVsbG8=)\n' + '长'.repeat(5000)
      await writeFile(path.join(source, 'a.md'), raw)
      const library = newLibrary('scan'); library.wikiPath = wiki; library.sourceRoots = [source]
      const registry = emptyRegistry(); registry.libraries = [library]
      const store = new LibraryStore(() => registry); await store.initialize(library.id)
      const first = await scanLibrary(store, library.id, undefined, 1000)
      expect(first.files[0]).toMatchObject({ change: 'new', images: 1, pendingImages: 0 })
      expect(first.errors).toEqual([])
      const versions = await readdir(path.join(wiki, '.llmwiki/sources', first.files[0]!.sourceId))
      const version = JSON.parse(await readFile(path.join(wiki, '.llmwiki/sources', first.files[0]!.sourceId, versions[0]!), 'utf8'))
      const clean = await readFile(path.join(wiki, '.llmwiki/objects', version.textObject), 'utf8')
      expect(clean).not.toContain('aGVsbG8='); expect(clean).toContain('正文。')
      expect((await scanLibrary(store, library.id)).files[0]!.change).toBe('unchanged')
      expect(await readFile(path.join(source, 'a.md'), 'utf8')).toBe(raw)
      await writeFile(path.join(source, 'a.md'), raw + '\n更新')
      expect((await scanLibrary(store, library.id)).files[0]!.change).toBe('changed')
    } finally { await temp.cleanup() }
  })
  it('拒绝把旧库登记的策略写到新目录', async () => {
    const temp = await temporaryWorkspace()
    try {
      const library = newLibrary('moved'); library.wikiPath = path.join(temp.root, 'one')
      const registry = emptyRegistry(); registry.libraries = [library]
      const store = new LibraryStore(() => registry), key = JSON.stringify(library)
      const first = await store.initialize(library.id)
      library.wikiPath = path.join(temp.root, 'two'); await store.initialize(library.id)
      await expect(store.savePolicy(library.id, first.policy, first.revision, key)).rejects.toThrow('登记已变化')
    } finally { await temp.cleanup() }
  })
})
