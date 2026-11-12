import * as fs from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { cleanupLayeredFixtures, layeredIncrementalFixture, snapshotFixture } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
// 固定离线输入的发布与恢复对照；真实计时统计另由成本专项覆盖。
vi.mock('../src/layered/costs.js', async original => ({ ...await original<typeof import('../src/layered/costs.js')>(),
  meteredOptions: (_root: string, _pending: unknown, options: unknown) => options }))
afterEach(async () => { vi.useRealTimers(); await cleanupLayeredFixtures() })

it('草稿对象已写而检查点引用未写时中断，续做内容等同一次完成且复用回执不重复计费', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-12T00:00:00Z'))
  const f = await layeredIncrementalFixture()
  await fs.writeFile(path.join(f.knowledgeRoot, 'a.md'), '甲组初版证据。')
  await buildLayeredLibrary(f.options)
  await fs.writeFile(path.join(f.knowledgeRoot, 'b.md'), '乙组新增证据。')
  const initial = await snapshotFixture(f.knowledgeRoot)
  const published = async () => new Map([...((await snapshotFixture(f.root)).files)].filter(([name]) => /^(objects|versions|wiki)[\\/]/.test(name)))
  await buildLayeredLibrary(f.options)
  const expected = await published()
  const resumed = await layeredIncrementalFixture(initial, f.knowledgeRoot), rename = fs.rename
  let objectWritten = false, stopped = false
  const failure = vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
    if (!stopped && objectWritten && String(to).endsWith(`${path.sep}work${path.sep}pending.json`)) { stopped = true; throw new Error('固定崩溃点：对象已写，引用未写') }
    const result = await rename(from, to)
    if (String(to).includes(`${path.sep}objects${path.sep}pages${path.sep}`)) objectWritten = true
    return result
  })
  await expect(buildLayeredLibrary(resumed.options)).rejects.toThrow('固定崩溃点')
  expect(stopped).toBe(true); failure.mockRestore()
  resumed.call.mockClear()
  await buildLayeredLibrary(resumed.options)
  expect(resumed.call.mock.calls.filter(args => JSON.parse(args[2]).topic_id)).toHaveLength(0)
  const actual = await published()
  expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort())
  for (const [name, bytes] of expected) {
    if (name === path.join('versions', 'v000002.json')) {
      const reference = JSON.parse(bytes.toString()).manifest, recovered = JSON.parse(actual.get(name)!.toString()).manifest
      expect(reference.deps.pages['topics/T-0002.md'].calls).toHaveLength(1)
      expect(recovered.deps.pages['topics/T-0002.md'].calls).toEqual([])
      expect(recovered.log).toContain('主题 0 次')
      // 仅本轮实际调用记录不同；其余清单字段、页面对象和阅读文件继续严格比较。
      reference.deps.pages['topics/T-0002.md'].calls = []
      const offset = reference.log.lastIndexOf('主题 2 次')
      reference.log = reference.log.slice(0, offset) + reference.log.slice(offset).replace('主题 2 次', '主题 0 次')
      expect(recovered).toEqual(reference)
    } else expect(actual.get(name)?.equals(bytes), name).toBe(true)
  }
})

it('同一20篇离线输入在30、3、1路下全部对象、版本清单及阅读文件逐字节一致', async () => {
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-12T00:00:00Z'))
  const f = await layeredIncrementalFixture()
  await fs.writeFile(path.join(f.knowledgeRoot, 'base.md'), '甲组初版证据。')
  await buildLayeredLibrary(f.options)
  for (let i = 0; i < 20; i++) await fs.writeFile(path.join(f.knowledgeRoot, String(i).padStart(2, '0') + '.md'), `${i < 10 ? '甲组' : '乙组'}固定研究证据${i}。`)
  const initial = await snapshotFixture(f.knowledgeRoot)
  let expected: Map<string, Buffer> | undefined
  for (const concurrency of [30, 3, 1]) {
    const round = await layeredIncrementalFixture(initial, f.knowledgeRoot)
    round.policy.pageGenerationConcurrency = concurrency
    await buildLayeredLibrary(round.options)
    const actual = new Map([...((await snapshotFixture(f.root)).files)].filter(([name]) => /^(objects|versions|wiki)[\\/]/.test(name)))
    if (expected) {
      expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort())
      for (const [name, bytes] of expected) expect(actual.get(name)?.equals(bytes), `${concurrency}路：${name}`).toBe(true)
    } else expected = actual
  }
}, 60000)
