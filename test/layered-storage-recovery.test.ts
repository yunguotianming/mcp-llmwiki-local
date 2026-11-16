// 同路径内容修改夹具保留稳定标题，使段哈希重合率达到 50%；存储、恢复及冲突断言保持。
import * as fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary, readLayeredPage } from '../src/layered/index.js'
import { readVersion, pageObjectPath } from '../src/layered/objects.js'
import { collectGarbage } from '../src/layered/retention.js'
import { cleanupLayeredFixtures, layeredFixture, layeredIncrementalFixture, snapshotManifest } from './layered-fixture.js'

import { atomicWrite, hash } from '../src/layered/files.js'
import { meteredOptions } from '../src/layered/costs.js'
import { validatedTask } from '../src/layered/extraction-cache.js'
import type { PendingBuild } from '../src/layered/schema.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('阅读副本只改变化页、最后换索引，删除失效页并保留笔记和 Obsidian 配置', async () => {
  const f = await layeredIncrementalFixture()
  await fs.writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组保留。')
  await fs.writeFile(path.join(f.knowledgeRoot, 'b.md'), '乙组删除。')
  await buildLayeredLibrary(f.options)
  await fs.mkdir(path.join(f.root, 'wiki/.obsidian'), { recursive: true })
  await fs.writeFile(path.join(f.root, 'wiki/.obsidian/config.json'), '{"用户":true}')
  await fs.writeFile(path.join(f.root, 'wiki/sources/自建.md'), '自建笔记')
  const page = path.join(f.root, 'wiki/sources/S-0001.md'), time = (await fs.stat(page)).mtimeMs
  const changes: string[] = [], rename = fs.rename
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).includes(`${path.sep}wiki${path.sep}`)) changes.push(path.relative(path.join(f.root, 'wiki'), String(to)).replaceAll('\\', '/'))
    return rename(from, to)
  })
  await fs.unlink(path.join(f.knowledgeRoot, 'b.md'))
  await buildLayeredLibrary(f.options)
  expect((await fs.stat(page)).mtimeMs).toBe(time)
  expect(changes).not.toContain('sources/S-0001.md'); expect(changes.at(-1)).toBe('index.md')
  await expect(fs.stat(path.join(f.root, 'wiki/sources/S-0002.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await fs.readFile(path.join(f.root, 'wiki/sources/自建.md'), 'utf8')).toBe('自建笔记')
  expect(await fs.readFile(path.join(f.root, 'wiki/.obsidian/config.json'), 'utf8')).toBe('{"用户":true}')
})

it('手改页面保持原样并保存新对象引用，文件占用有限重试后补同步', async () => {
  const f = await layeredIncrementalFixture()
  await fs.writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 资料a\n\n甲组旧内容。')
  await fs.writeFile(path.join(f.knowledgeRoot, 'b.md'), '# 资料b\n\n乙组旧内容。')
  await buildLayeredLibrary(f.options)
  const a = path.join(f.root, 'wiki/sources/S-0001.md'), b = path.join(f.root, 'wiki/sources/S-0002.md')
  await fs.writeFile(a, '用户手改独有内容')
  await fs.writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 资料a\n\n甲组新内容。')
  await fs.writeFile(path.join(f.knowledgeRoot, 'b.md'), '# 资料b\n\n乙组新内容。')
  const rename = fs.rename
  const busy = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === b) throw Object.assign(new Error('模拟文件占用'), { code: 'EBUSY' })
    return rename(from, to)
  })
  const built = await buildLayeredLibrary(f.options)
  expect(busy.mock.calls.filter(call => String(call[1]) === b)).toHaveLength(10)
  busy.mockRestore()
  expect(await fs.readFile(a, 'utf8')).toBe('用户手改独有内容')
  expect(await fs.readFile(b, 'utf8')).toContain('乙组旧内容')
  expect(await readLayeredPage(f.knowledgeRoot, 'S-0001')).toContain('甲组新内容')
  expect(await readLayeredPage(f.knowledgeRoot, 'S-0001')).not.toContain('用户手改')
  const conflictFile = (await fs.readdir(path.join(f.root, 'conflicts')))[0]!
  const conflict = JSON.parse(await fs.readFile(path.join(f.root, 'conflicts', conflictFile), 'utf8'))
  expect(conflict.new_object).toBe((await readVersion(f.root, built.version)).pages!['sources/S-0001.md'])
  const state = JSON.parse(await fs.readFile(path.join(f.root, 'state/reading-copy.json'), 'utf8'))
  expect(state.target).toBe(built.version); expect(state.failures).toHaveProperty('sources/S-0002.md')
  await buildLayeredLibrary(f.options)
  expect(await fs.readFile(b, 'utf8')).toContain('乙组新内容')
  expect(JSON.parse(await fs.readFile(path.join(f.root, 'state/reading-copy.json'), 'utf8')).target).toBeNull()
  expect(await fs.readFile(a, 'utf8')).toBe('用户手改独有内容')
  await collectGarbage(f.root)
  expect(await fs.readFile(path.join(f.root, pageObjectPath(conflict.new_object)), 'utf8')).toContain('甲组新内容')
}, 20_000)

it('对象写入和清单写完切换前中断，旧版完整可查，恢复不重提取', async () => {
  const f = await layeredIncrementalFixture()
  await fs.writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组初版。')
  await buildLayeredLibrary(f.options)
  const old = await readLayeredPage(f.knowledgeRoot)
  await fs.writeFile(path.join(f.knowledgeRoot, 'b.md'), '乙组增量。')
  for (const stage of ['objects', 'pointer']) {
    const rename = fs.rename
    const failure = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (stage === 'objects' && String(to).includes(`${path.sep}objects${path.sep}pages${path.sep}`)
        || stage === 'pointer' && String(to).endsWith('current.json')) throw new Error('模拟中断 ' + stage)
      return rename(from, to)
    })
    await expect(buildLayeredLibrary(f.options)).rejects.toThrow('模拟中断')
    failure.mockRestore()
    expect(await readLayeredPage(f.knowledgeRoot)).toBe(old)
    f.requests.length = 0
  }
  await buildLayeredLibrary(f.options)
  expect(f.requests).toHaveLength(0)
  expect(await readLayeredPage(f.knowledgeRoot)).toContain('S-0002')
})

it('切换后刷新及清理中断不影响完整查询，重启续建补齐阅读副本并收敛两版', async () => {
  const f = await layeredIncrementalFixture()
  await fs.writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 资料a\n\n甲组版本零。')
  await buildLayeredLibrary(f.options)
  await fs.writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 资料a\n\n甲组版本一。')
  const rename = fs.rename
  const stop = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to).endsWith(`${path.sep}wiki${path.sep}index.md`)) throw new Error('模拟刷新退出')
    return rename(from, to)
  })
  await expect(buildLayeredLibrary(f.options)).rejects.toThrow('模拟刷新退出')
  stop.mockRestore()
  expect(await readLayeredPage(f.knowledgeRoot, 'S-0001')).toContain('甲组版本一')
  await buildLayeredLibrary(f.options)
  expect(await fs.readFile(path.join(f.root, 'wiki/index.md'), 'utf8')).toBe(await readLayeredPage(f.knowledgeRoot))
  await fs.writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 资料a\n\n甲组版本二。')
  const unlink = fs.unlink
  const cleanup = vi.spyOn(fs, 'unlink').mockImplementation(async file => {
    if (String(file).includes(`${path.sep}versions${path.sep}`)) throw new Error('模拟清理退出')
    return unlink(file)
  })
  await expect(buildLayeredLibrary(f.options)).rejects.toThrow('模拟清理退出')
  cleanup.mockRestore()
  expect(await readLayeredPage(f.knowledgeRoot, 'S-0001')).toContain('甲组版本二')
  await buildLayeredLibrary(f.options)
  expect(await fs.readdir(path.join(f.root, 'versions'))).toHaveLength(2)
})

it('替换成功但物化记录未写入时可恢复，用户删除不会被静默重建', async () => {
  const f = await layeredIncrementalFixture()
  await fs.writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 资料a\n\n甲组旧状态。')
  await buildLayeredLibrary(f.options)
  await fs.writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 资料a\n\n甲组新状态。')
  const rename = fs.rename; let replaced = false
  const stop = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (replaced && String(to).endsWith('reading-copy.json')) throw new Error('模拟物化记录退出')
    await rename(from, to)
    if (String(to).endsWith(`${path.sep}wiki${path.sep}sources${path.sep}S-0001.md`)) replaced = true
  })
  await expect(buildLayeredLibrary(f.options)).rejects.toThrow('模拟物化记录退出')
  stop.mockRestore(); await buildLayeredLibrary(f.options)
  expect(await fs.readFile(path.join(f.root, 'wiki/sources/S-0001.md'), 'utf8')).toContain('甲组新状态')
  expect(await fs.readdir(path.join(f.root, 'conflicts')).catch(error => { if (error.code === 'ENOENT') return []; throw error })).toEqual([])
  await fs.unlink(path.join(f.root, 'wiki/sources/S-0001.md'))
  await fs.writeFile(path.join(f.knowledgeRoot, 'a.md'), '# 资料a\n\n甲组第三状态。')
  await buildLayeredLibrary(f.options)
  await expect(fs.stat(path.join(f.root, 'wiki/sources/S-0001.md'))).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await fs.readdir(path.join(f.root, 'conflicts'))).toHaveLength(1)
})

it.each(['EPERM', 'EBUSY', 'EACCES'])('原子替换遇到 %s 时保持旧内容直到完整替换', async code => {
  const f = await layeredFixture(), target = path.join(f.root, 'state/test.json')
  await atomicWrite(f.root, 'state/test.json', '旧内容')
  const rename = fs.rename; let attempts = 0
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to) === target) {
      expect(await fs.readFile(target, 'utf8')).toBe('旧内容')
      expect(await fs.readFile(from, 'utf8')).toBe('完整新内容')
      if (++attempts <= 2) throw Object.assign(new Error('短暂占用'), { code })
    }
    return rename(from, to)
  })
  await atomicWrite(f.root, 'state/test.json', '完整新内容')
  expect(attempts).toBe(3)
  expect(await fs.readFile(target, 'utf8')).toBe('完整新内容')
})

it('三类占用交错至重试上限仍保留旧文件并抛第一次原始错误', async () => {
  const f = await layeredFixture(), target = path.join(f.root, 'state/test.json')
  await atomicWrite(f.root, 'state/test.json', '旧内容')
  const first = Object.assign(new Error('第一次占用'), { code: 'EPERM' })
  const rename = fs.rename; let attempts = 0
  vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (String(to) !== target) return rename(from, to)
    attempts++
    throw attempts === 1 ? first : Object.assign(new Error('仍占用'), { code: attempts % 2 ? 'EACCES' : 'EBUSY' })
  })
  const started = Date.now()
  await expect(atomicWrite(f.root, 'state/test.json', '完整新内容')).rejects.toBe(first)
  expect(Date.now() - started).toBeGreaterThanOrEqual(6400)
  expect(attempts).toBe(10)
  expect(await fs.readFile(target, 'utf8')).toBe('旧内容')
  expect((await fs.readdir(path.dirname(target))).some(name => name.endsWith('.tmp'))).toBe(false)
}, 20_000)

it('并发任务的调用记录关联单元、指纹、真实回执及各次用量，回执命中零新增', async () => {
  const f = await layeredFixture(), pending = { started_at: '2026-11-14' } as PendingBuild
  f.call.mockImplementation(async (_task, _system, _input, _signal, _images, options) => {
    options?.beforeAttempt?.()
    options?.onAttempt?.({ route: { provider: 'mock', model: 'test' }, startedAt: new Date().toISOString(), durationMs: 1,
      finish: 'stop', usage: { inputTokens: 7, outputTokens: 3 } })
    return '{"完成":true}'
  })
  const options = meteredOptions(f.root, pending, { ...f.options, invalidationReason: '成员输入变化' })
  const run = (id: string) => validatedTask(options, 'topic', { id }, async () => {
    await options.client.call('ingest', '主题提示', JSON.stringify({ topic_id: id }), undefined, [], { operation: 'topic' })
    return { complete: true }
  }, value => value.complete)
  await Promise.all([run('T-0001'), run('T-0002')])
  expect(pending.costs!.calls).toHaveLength(2)
  const records = pending.costs!.calls!
  expect(new Set(records.map(record => record.logical_task_id)).size).toBe(2)
  expect(new Set(records.map(record => record.receipt_key)).size).toBe(2)
  for (const record of records) {
    expect(record).toMatchObject({ invalidation_reason: '成员输入变化', status: 'completed' })
    expect(record.unit_id).toMatch(/^topics\/T-000[12]\.md$/)
    expect(record.input_fingerprint).toMatch(/^sha256:/)
    expect(record.attempts[0]!.usage).toEqual({ inputTokens: 7, outputTokens: 3 })
    const receipt = JSON.parse(await fs.readFile(path.join(f.root, 'cache/tasks', record.receipt_key!.slice(7) + '.json'), 'utf8'))
    expect(receipt.key).toBe(record.receipt_key)
    expect(hash(JSON.stringify(receipt.value))).toBe(receipt.digest)
  }
  expect((await run('T-0001')).reused).toBe(true)
  expect(f.call).toHaveBeenCalledTimes(2)
  expect(JSON.parse(await fs.readFile(path.join(f.root, 'work/pending.json'), 'utf8')).costs.calls).toEqual(records)
  const embedding = meteredOptions(f.root, pending, { ...f.options, embeddingClient: { embed: async input => input.map(() => [1, 0]) } })
  await embedding.embeddingClient!.embed(['向量输入'])
  expect(pending.costs!.calls!.at(-1)).toMatchObject({ stage: '嵌入', status: 'completed', receipt_key: null,
    input_fingerprint: hash(JSON.stringify(['向量输入'])) })
})
