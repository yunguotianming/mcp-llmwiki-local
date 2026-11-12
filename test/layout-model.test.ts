import { afterEach, expect, it, vi } from 'vitest'
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { embeddingStandardName } from '../src/domain/embedding-name.js'
import { defaultWikiPath, emptyRegistry } from '../src/domain/config.js'
import { scanSourceFiles } from '../src/ingest/scanner.js'
import { safePath } from '../src/storage/paths.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { replaceIdentity, recoverIdentity } from '../src/storage/identity.js'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { withBuildLock, hash, writeJson } from '../src/layered/files.js'
import { collectGarbage, listFiles, pinVersion } from '../src/layered/retention.js'
import { revokeSourcesAtRoot, withLayeredRead } from '../src/layered/revocations.js'
import { pageObjectPath } from '../src/layered/objects.js'
import { validatedTask } from '../src/layered/extraction-cache.js'
import { resumeReadingCopy } from '../src/layered/reading-copy.js'
import { cleanupLayeredFixtures, layeredTopicFixture, snapshotManifest } from './layered-fixture.js'
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
it('标准模型名覆盖约定、云端、全文和非法字符，默认路径按模型命名', () => {
  for (const [model, name] of [['qwen3-embedding:8b', 'qwen3-8b'], ['qwen3-embedding:4b', 'qwen3-4b'], ['qwen3-embedding:0.6b', 'qwen3-06b'], ['text-embedding-3-small', 'text-3-small'], [' A/B_中文:1.2! ', 'ab-12']]) expect(embeddingStandardName({ model })).toBe(name)
  expect(embeddingStandardName({ embeddingMode: 'none' })).toBe('fulltext'); expect(embeddingStandardName({ provider: 'lexical' })).toBe('fulltext')
  expect(() => embeddingStandardName({ model: '中文?' })).toThrow()
  expect(defaultWikiPath(['C:\\资料'], { localEmbeddingModel: 'qwen3-embedding:8b' })).toBe('C:\\资料\\.llmwiki-qwen3-8b')
})
it('扫描排除同根所有模型库和备份，同一资料根的建库锁互斥', async () => {
  const f = await layeredTopicFixture()
  for (const name of ['.llmwiki', '.llmwiki-qwen3-8b', '.llmwiki-qwen3-06b', '.llmwiki.bak-20261112']) {
    await fs.mkdir(path.join(f.knowledgeRoot, name), { recursive: true }); await fs.writeFile(path.join(f.knowledgeRoot, name, 'wiki.md'), '不应扫描')
  }
  await fs.writeFile(path.join(f.knowledgeRoot, 'input.md'), '资料')
  const scan = await scanSourceFiles([f.knowledgeRoot], path.join(f.knowledgeRoot, '.llmwiki-qwen3-8b'))
  expect(scan.inputs.map(item => path.basename(item.actual))).toEqual(['input.md'])
  await withBuildLock(f.knowledgeRoot, async () => {
    for (const name of ['.llmwiki-qwen3-8b', '.llmwiki-qwen3-06b']) {
      await expect(buildLayeredLibrary({ ...f.options, wikiPath: path.join(f.knowledgeRoot, name) })).rejects.toThrow('建库正在运行')
    }
  })
})
async function buildPair() {
  const f = await layeredTopicFixture(), nextRoot = path.join(f.knowledgeRoot, '.llmwiki-qwen3-8b')
  await fs.writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 甲组\n\n甲组的研究结果。')
  f.options.topics = { ...f.options.topics || {}, localEmbeddingModel: 'qwen3-embedding:8b' }
  return { ...f, nextRoot }
}
it('相同输入的新旧布局阅读页面和对象哈希一致，根目录仅保留分区内容', async () => {
  const f = await buildPair(), now = Date.now(); vi.spyOn(Date.prototype, 'toISOString').mockReturnValue(new Date(now).toISOString())
  await buildLayeredLibrary({ ...f.options, wikiPath: f.root })
  await buildLayeredLibrary({ ...f.options, wikiPath: f.nextRoot })
  const inventory = async (root: string, relative: string) => Object.fromEntries(await Promise.all((await listFiles(root, relative)).sort().map(async file => [file, hash(await fs.readFile(await safePath(root, file)))])))
  expect(await inventory(f.nextRoot, 'wiki')).toEqual(await inventory(f.root, 'wiki'))
  expect(await inventory(f.nextRoot, 'objects')).toEqual(await inventory(f.root, 'objects'))
  expect((await fs.readdir(f.nextRoot)).sort()).toEqual(['README.md', 'data', 'library.yaml', 'wiki'])
  expect(await safePath(f.nextRoot, '.llmwiki/library.json')).toBe(await safePath(f.nextRoot, 'state/library.json'))
})
it('新布局身份事务回滚及重新签发均使用同一份元数据', async () => {
  const f = await buildPair(); await buildLayeredLibrary({ ...f.options, wikiPath: f.nextRoot })
  const metadata = { libraryId: 'old', formatVersion: 1, protocolVersion: 1 }
  await writeJson(f.nextRoot, '.llmwiki/library.json', metadata)
  await expect(replaceIdentity(f.nextRoot, [{ ...metadata, libraryId: 'bad' }, { ...metadata, libraryId: 'bad' }, undefined], () => { throw new Error('回滚') })).rejects.toThrow('回滚')
  await recoverIdentity(f.nextRoot)
  expect(JSON.parse(await fs.readFile(await safePath(f.nextRoot, 'state/library.json'), 'utf8')).libraryId).toBe('old')
  const store = new LibraryStore(() => emptyRegistry()), result = await store.reissueIdentity({ path: f.nextRoot, name: '重新登记', expectedLibraryId: 'old', reissueId: true })
  expect(result.id).not.toBe('old'); expect(result.layered?.localEmbeddingModel).toBe('qwen3-embedding:8b')
  expect(JSON.parse(await fs.readFile(await safePath(f.nextRoot, '.llmwiki/library.json'), 'utf8')).libraryId).toBe(result.id)
})
it('新布局读者租约、GC、阅读副本恢复和撤权清理保留协议行为', async () => {
  const f = await buildPair(); await buildLayeredLibrary({ ...f.options, wikiPath: f.nextRoot })
  const first = await snapshotManifest(f.nextRoot), pin = await pinVersion(f.nextRoot, first.version!)
  expect((await listFiles(f.nextRoot, 'state/readers')).length).toBeGreaterThan(0)
  await collectGarbage(f.nextRoot, 0)
  expect(await fs.readFile(await safePath(f.nextRoot, `versions/${first.version}.json`), 'utf8')).toContain(first.version!)
  await pin.release()
  await writeJson(f.nextRoot, 'state/reading-copy.json', { version: null, target: first.version, materialized: {}, failures: {} })
  await resumeReadingCopy(f.nextRoot, first.version!)
  await revokeSourcesAtRoot(f.nextRoot, [first.sources[0]!.source_id], '验收撤权')
  await collectGarbage(f.nextRoot, 0)
  expect((await snapshotManifest(f.nextRoot)).sources).toEqual([])
  expect(await listFiles(f.nextRoot, 'wiki/sources')).toEqual([])
})

it('任务回执写入选中模型库的 data 分区，重复调用复用且不污染同根旧库', async () => {
  const f = await buildPair(); await buildLayeredLibrary({ ...f.options, wikiPath: f.nextRoot })
  const work = vi.fn(async () => ({ text: '已核对' }))
  const run = () => validatedTask({ ...f.options, wikiPath: f.nextRoot }, 'term', { input: '新布局回执' }, work, value => value.text === '已核对')
  expect((await run()).reused).toBe(false); expect((await run()).reused).toBe(true)
  expect(work).toHaveBeenCalledTimes(1)
  expect((await fs.readdir(await safePath(f.nextRoot, 'cache/tasks'))).length).toBeGreaterThan(0)
  await expect(fs.stat(path.join(f.root, 'cache/tasks'))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('新布局对象变化使整版验齐缓存失效，读索引也会回退完整旧版', async () => {
  const f = await buildPair(), options = { ...f.options, wikiPath: f.nextRoot }
  await buildLayeredLibrary(options)
  const first = await snapshotManifest(f.nextRoot)
  await fs.writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 甲组\n\n甲组的新研究结果。')
  await buildLayeredLibrary(options)
  const second = await snapshotManifest(f.nextRoot)
  const read = () => withLayeredRead(f.nextRoot, view => view.document('index.md'))
  expect((await read()).version).toBe(second.version)
  await fs.unlink(await safePath(f.nextRoot, pageObjectPath(second.pages['sources/S-0001.md']!)))
  expect(await read()).toMatchObject({ version: first.version, warning: expect.stringContaining('更新未完整') })
})
