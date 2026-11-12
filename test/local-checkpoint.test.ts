import * as fs from 'node:fs/promises'
import path from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, expect, it, vi } from 'vitest'
import { hash, withRevocationLock, withStorageGeneration, withoutStorageGeneration, writeJson } from '../src/layered/files.js'
import { pageObjectPath, readPageObject } from '../src/layered/objects.js'
import { hydrateVectors, storageJson } from '../src/layered/vectors.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
const roots: string[] = []
afterEach(async () => { vi.restoreAllMocks(); for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), 'wiki-checkpoint-')); roots.push(root)
  await writeJson(root, 'state/revocations.json', { generation: 0 })
  return root
}
const pending = () => ({ marker: '检查点', nested: { ids: ['甲'], detail: { title: '原始标题' } },
  topics: { pages: { 'topics/甲.md': { content: '正文\n中文与😀', dependencies: { ids: ['甲'] } } } },
  terms: { pages: { 'terms/甲.md': { content_id: '旧身份', dependencies: { ids: ['乙'] }, content: '术语正文' } } } })
function originalBytes(value: unknown): string {
  const plain = JSON.parse(storageJson(value))
  for (const build of [plain.topics, plain.terms]) for (const page of Object.values(build?.pages ?? {}) as { content?: string; content_id?: string }[]) {
    if (page.content !== undefined) { page.content_id = hash(page.content); delete page.content }
  }
  return JSON.stringify(plain) + '\n'
}
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }

it('检查点只编码一次，字段顺序与旧格式逐字节一致且继续剔除向量', async () => {
  const root = await fixture(), value = { ...pending(), vectors: { p: { vector_id: '已存', vector: [1, 0], input_hash: '输入' } },
    topic: { parent_id: null, centroid: [1, 0], point_ids: ['p'], title: '主题' } }
  const expected = originalBytes(value), stringify = vi.spyOn(JSON, 'stringify')
  await writeJson(root, 'work/pending.json', value)
  expect(stringify.mock.calls.filter(([item]) => item?.marker === '检查点')).toHaveLength(1)
  expect(await fs.readFile(path.join(root, 'work/pending.json'), 'utf8')).toBe(expected)
  expect(value.topics.pages['topics/甲.md'].content).toBe('正文\n中文与😀')
  expect(expected).not.toContain('"vector":'); expect(expected).not.toContain('"centroid":')
  await expect(writeJson(root, 'work/pending.json', { vector: [1] })).rejects.toThrow('向量尚未写入对象库')
})

it('等锁时捕获深层状态，合并等待者只在对象和最新检查点落盘后返回', async () => {
  const root = await fixture(), value = pending(), entered = deferred(), release = deferred()
  const lock = withRevocationLock(root, async () => { entered.resolve(); await release.promise })
  await entered.promise
  let completed = 0
  const first = writeJson(root, 'work/pending.json', value).then(() => { completed++ })
  value.nested.ids.push('乙'); value.topics.pages['topics/甲.md'].content = '最新正文'
  const expected = originalBytes(value)
  const second = writeJson(root, 'work/pending.json', value).then(() => { completed++ })
  value.nested.detail.title = '异步污染'; value.nested.ids.push('丙')
  value.topics.pages['topics/甲.md'].dependencies.ids.push('异步污染'); value.topics.pages['topics/甲.md'].content = '异步污染'
  await Promise.resolve(); expect(completed).toBe(0)
  release.resolve(); await Promise.all([lock, first, second])
  expect(completed).toBe(2)
  expect(await fs.readFile(path.join(root, 'work/pending.json'), 'utf8')).toBe(expected)
  expect(await readPageObject(root, hash('最新正文'))).toBe('最新正文')
})

it('对象写完而引用替换前中断，旧检查点完整，续做与一次写完字节一致', async () => {
  const root = await fixture(), control = await fixture(), value = pending()
  await writeJson(root, 'work/pending.json', value)
  const before = await fs.readFile(path.join(root, 'work/pending.json'), 'utf8')
  value.topics.pages['topics/甲.md'].content = '恢复后的正文'
  const rename = fs.rename
  const fail = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === path.join(root, 'work/pending.json')) throw new Error('对象已写，引用未写')
    return rename(from, to)
  })
  await expect(writeJson(root, 'work/pending.json', value)).rejects.toThrow('对象已写，引用未写')
  expect(await fs.readFile(path.join(root, pageObjectPath(hash('恢复后的正文'))), 'utf8')).toBe('恢复后的正文')
  expect(await fs.readFile(path.join(root, 'work/pending.json'), 'utf8')).toBe(before)
  fail.mockRestore()
  // 重新读旧检查点模拟进程丢失运行态缓存，再接续相同业务修改。
  const restored = await hydrateVectors(root, JSON.parse(before))
  restored.topics.pages['topics/甲.md'].content = '恢复后的正文'
  await writeJson(root, 'work/pending.json', restored)
  // 恢复带回 content_id；一次完成的参照也从相同持久输入开始。
  const uninterrupted = await hydrateVectors(root, JSON.parse(before))
  uninterrupted.topics.pages['topics/甲.md'].content = '恢复后的正文'
  await writeJson(control, 'work/pending.json', uninterrupted)
  expect(await fs.readFile(path.join(root, 'work/pending.json'))).toEqual(await fs.readFile(path.join(control, 'work/pending.json')))
})

it('排队期间插入撤权拒绝旧代次，既不写引用也不恢复已撤对象', async () => {
  const root = await fixture(), value = pending(), entered = deferred(), release = deferred()
  await withStorageGeneration(root, async () => {
    const lock = withoutStorageGeneration(() => withRevocationLock(root, async () => {
      entered.resolve(); await release.promise
      await writeJson(root, 'state/revocations.json', { generation: 1 })
    }))
    await entered.promise
    const writing = writeJson(root, 'work/pending.json', value)
    const rejected = expect(writing).rejects.toThrow('撤权代次变化')
    release.resolve(); await lock; await rejected
  })
  await expect(fs.stat(path.join(root, 'work/pending.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(fs.stat(path.join(root, pageObjectPath(hash(value.topics.pages['topics/甲.md'].content))))).rejects.toMatchObject({ code: 'ENOENT' })
})

it('对象写入暂停后继续修改输入，不污染进行中的快照且下一检查点保留修改', async () => {
  const root = await fixture(), value = pending(), entered = deferred(), release = deferred(), expected = originalBytes(value)
  const rename = fs.rename
  let blocked = false
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (!blocked && String(to).includes(`${path.sep}objects${path.sep}pages${path.sep}`)) { blocked = true; entered.resolve(); await release.promise }
    return rename(from, to)
  })
  const first = writeJson(root, 'work/pending.json', value)
  await entered.promise
  value.nested.detail.title = '后续修改'; value.terms.pages['terms/甲.md'].content = '后续术语'
  release.resolve(); await first
  expect(await fs.readFile(path.join(root, 'work/pending.json'), 'utf8')).toBe(expected)
  await writeJson(root, 'work/pending.json', value)
  expect(await fs.readFile(path.join(root, 'work/pending.json'), 'utf8')).toBe(originalBytes(value))
})
