import * as fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as markdown from '../src/ingest/markdown.js'
import { newLibrary } from '../src/domain/config.js'
import { putPage, writeVersion } from '../src/layered/objects.js'
import { LayeredQuery } from '../src/wiki/layered-query.js'
import type { LayeredLibrary } from '../src/wiki/layered-query.js'
import { pageParagraphs } from '../src/wiki/page-search.js'
import { temporaryWorkspace } from './temp.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
vi.mock('../src/ingest/markdown.js', async original => ({ ...await original<typeof import('../src/ingest/markdown.js')>() }))
afterEach(() => vi.restoreAllMocks())

it('中文块映射按字节限容，超大单篇不入缓存，超限保留 LRU 且返回结果不变', () => {
  const mib = 1024 * 1024, limit = 32 * mib, separator = '\n\n## 导航\n\n'
  const page = (id: string, chars: number) => '证据正文。\n\n ^p' + id + separator + '中'.repeat(chars)
  const a = page('a', 4 * mib), b = page('b', 4 * mib), c = page('c', 4 * mib), large = page('large', 12 * mib)
  expect(large.length).toBeLessThan(limit)
  expect(Buffer.byteLength(large, 'utf8')).toBeGreaterThan(limit)
  expect([a, b, c].reduce((sum, content) => sum + Buffer.byteLength(content, 'utf8'), 0)).toBeGreaterThan(limit)
  // 真实中文正文参与计量；只解析证据前缀，避免容量用例花时间构造无关的巨型导航 AST。
  const original = markdown.parseMarkdown
  const parse = vi.spyOn(markdown, 'parseMarkdown').mockImplementation(content => original(content.split(separator, 1)[0]!))
  const results = new Map<string, string>()
  let request = 0
  const read = (content: string, id: string) => {
    // 每次更换无关变体，绕过段落结果缓存，单独观察块映射缓存是否命中。
    const blocks = pageParagraphs(content, ['证据', '未命中' + ++request])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ content: '证据正文。', anchor: '^p' + id, locator: 'L1-L1' })
    const bytes = JSON.stringify(blocks)
    if (results.has(id)) expect(bytes).toBe(results.get(id))
    else results.set(id, bytes)
  }
  read(a, 'a'); read(b, 'b')
  expect(parse).toHaveBeenCalledTimes(2)
  read(large, 'large'); read(large, 'large')
  expect(parse).toHaveBeenCalledTimes(4)
  read(a, 'a'); read(b, 'b')
  expect(parse).toHaveBeenCalledTimes(4) // 超大单篇既不驻留，也不清空已有条目。
  read(c, 'c')
  expect(parse).toHaveBeenCalledTimes(5) // 三篇中文超限，最久未使用的甲页被淘汰。
  read(c, 'c'); read(b, 'b')
  expect(parse).toHaveBeenCalledTimes(5) // 扣减也按字节，乙、丙均可保留；命中乙页更新顺序。
  read(a, 'a')
  expect(parse).toHaveBeenCalledTimes(6)
  read(b, 'b')
  expect(parse).toHaveBeenCalledTimes(6) // 乙比丙更近使用，不能按原插入顺序淘汰乙。
  read(c, 'c')
  expect(parse).toHaveBeenCalledTimes(7)
}, 15000)

it('两库并发读取一路抛错后，后续查询重新识别各自布局并返回正确正文', async () => {
  const temp = await temporaryWorkspace(), query = new LayeredQuery()
  const enteredA = Promise.withResolvers<void>(), enteredB = Promise.withResolvers<void>()
  const releaseA = Promise.withResolvers<void>(), releaseB = Promise.withResolvers<void>(), retry = Promise.withResolvers<void>()
  const retries: Promise<Awaited<ReturnType<typeof query.read>>>[] = []
  let initial: Promise<PromiseSettledResult<Awaited<ReturnType<typeof query.read>>>[]> | undefined
  try {
    const fixture = async (name: string, partitioned: boolean) => {
      const root = path.join(temp.root, name), storage = partitioned ? path.join(root, 'data') : root
      await fs.mkdir(path.join(storage, 'state'), { recursive: true })
      if (partitioned) await fs.writeFile(path.join(storage, 'layout.json'), JSON.stringify({ version: 2, directory: 'data' }))
      const content = '# ' + name + '\n\n' + name + '的查询证据。\n'
      const library = Object.assign(newLibrary(name), { wikiPath: root })
      const layered: LayeredLibrary = { root, card: { name, domain: '测试', origin_type: 'local', source_type: '测试',
        default_credibility: 'unknown', source_count: 0, updated_at: '2026-11-13T00:00:00Z', format_version: 2 } }
      await fs.writeFile(path.join(storage, 'state/revocations.json'), JSON.stringify({ generation: 0, sources: [] }))
      await writeVersion(root, { format_version: 2, version: 'v000001', next_source_number: 1, revocation_generation: 0,
        sources: [], pages: { 'index.md': await putPage(root, content) }, deps: { pages: {}, reverse: {} }, aliases: {} })
      await fs.writeFile(path.join(storage, 'state/current.json'), JSON.stringify({ version: 'v000001', revocation_generation: 0 }))
      return { root, storage, content, library, layered }
    }
    const a = await fixture('甲库', false), b = await fixture('乙库', true)
    const read = (f: typeof a) => query.read(f.library, f.layered, 'index.md', 1000)
    const original = fs.readFile, failure = new Error('甲库读取失败')
    const seen = new Set<string>()
    vi.spyOn(fs, 'readFile').mockImplementation(async (...args: Parameters<typeof fs.readFile>) => {
      const file = String(args[0])
      const f = [a, b].find(item => file === path.join(item.storage, 'state/current.json'))
      if (f && !seen.has(f.root)) {
        seen.add(f.root)
        // 在旧查询上下文里创建后续查询，覆盖 finally 失效及异步上下文残留的边界。
        const next = retry.promise.then(() => read(f))
        retries.push(next); void next.catch(() => {})
        if (f === a) { enteredA.resolve(); await releaseA.promise; throw failure }
        enteredB.resolve(); await releaseB.promise
      }
      return original(...args)
    })
    const firstA = read(a), firstB = read(b)
    initial = Promise.allSettled([firstA, firstB])
    await Promise.all([enteredA.promise, enteredB.promise])
    releaseA.resolve()
    await expect(firstA).rejects.toBe(failure)
    releaseB.resolve()
    const first = await initial
    expect(first[1]).toMatchObject({ status: 'fulfilled', value: { value: { status: 'ok', content: b.content } } })

    // 两路都结束后交换物理布局，正文与版本保持原样，旧布局下的路径不再存在。
    await fs.mkdir(path.join(a.root, 'data'))
    for (const directory of ['state', 'objects', 'versions']) {
      await fs.rename(path.join(a.root, directory), path.join(a.root, 'data', directory))
      await fs.rename(path.join(b.root, 'data', directory), path.join(b.root, directory))
    }
    await fs.writeFile(path.join(a.root, 'data/layout.json'), JSON.stringify({ version: 2, directory: 'data' }))
    await fs.unlink(path.join(b.root, 'data/layout.json'))
    retry.resolve()
    const recovered = await Promise.all(retries)
    expect(recovered.map(result => result.value?.content).sort()).toEqual([a.content, b.content].sort())
    expect(recovered.every(result => result.value?.status === 'ok')).toBe(true)
    expect(recovered.find(result => result.value?.content === b.content)?.value).toEqual((await firstB).value)
  } finally {
    releaseA.resolve(); releaseB.resolve(); retry.resolve()
    await initial; await Promise.allSettled(retries)
    vi.restoreAllMocks()
    await temp.cleanup()
  }
}, 15000)
