import { mockSupportReview } from './layered-fixture.js'
import { pageObjectPath, readVersion } from '../src/layered/objects.js'
import * as filesystem from 'node:fs/promises'
import { readFile, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { buildLayeredLibrary, readLayeredDocument, readLayeredPage, readLayeredSource, revokeLayeredSources } from '../src/layered/index.js'
import { cleanupLayeredFixtures, layeredTopicFixture, shareLayeredFixture, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
let template: Awaited<ReturnType<typeof shareLayeredFixture>>
let reuseRoot: string
beforeAll(async () => {
  const fixture = await layeredTopicFixture()
  reuseRoot = fixture.knowledgeRoot
  await Promise.all(['甲组撤权专有证据', '甲组剩余合法证据', '乙组独立证据'].map((text, index) => writeFile(path.join(fixture.knowledgeRoot, `${index}.md`),
    (index === 0 ? '---\ntitle: |\n  标题0\n  撤权导航私密内容\n---\n\n' : '') + `# 标题${index}\n\n${text}。`)))
  await buildLayeredLibrary(fixture.options)
  template = await shareLayeredFixture(fixture)
})
const fixtureWithTopics = () => layeredTopicFixture(template, reuseRoot)
describe('分层 Wiki 撤权与回滚隔离', () => {
  it('落表立即过滤来源、主题、导航及快照；直接指定旧版本和指针回退均不能绕过', async () => {
    const fixture = await fixtureWithTopics(), oldPointer = await readFile(path.join(fixture.root, 'state/current.json'), 'utf8')
    await writeFile(path.join(fixture.knowledgeRoot, '3.md'), '# 新资料\n\n乙组新增证据。')
    await buildLayeredLibrary(fixture.options)
    const latestPointer = await readFile(path.join(fixture.root, 'state/current.json'), 'utf8')
    expect(await readLayeredSource(fixture.knowledgeRoot, 'S-0002', { sourceVersion: 'sha256:旧版本' })).toMatchObject({ status: 'updated', content: '已更新' })
    expect(await readLayeredSource(fixture.knowledgeRoot, 'S-0002')).toMatchObject({ status: 'ok', warning: '未指定版本' })
    fixture.call.mockClear(); fixture.embed.mockClear()
    await revokeLayeredSources(fixture.knowledgeRoot, ['S-0001'], '用户撤回授权')
    expect(fixture.call).not.toHaveBeenCalled(); expect(fixture.embed).not.toHaveBeenCalled()
    for (const version of [undefined, 'v000001']) for (const page of ['sources/S-0001.md', 'topics/T-0001.md']) {
      expect(await readLayeredDocument(fixture.knowledgeRoot, page, { version })).toMatchObject({ status: 'updating', content: '更新中' })
    }
    expect(await readLayeredSource(fixture.knowledgeRoot, 'S-0001')).toMatchObject({ status: 'updating', content: '更新中' })
    const index = await readLayeredPage(fixture.knowledgeRoot)
    expect(index).not.toContain('标题0'); expect(index).not.toContain('甲组主题'); expect(index).toContain('更新中'); expect(index).toContain('乙组主题')
    expect(index).not.toContain('撤权导航私密内容')
    expect(await readLayeredPage(fixture.knowledgeRoot, 'sources/S-0002.md')).toContain('剩余合法证据')
    await writeFile(path.join(fixture.root, 'state/current.json'), oldPointer)
    expect(await readLayeredPage(fixture.knowledgeRoot, 'topics/T-0001.md')).toBe('更新中')
    await writeFile(path.join(fixture.root, 'state/current.json'), latestPointer)
  })
  it('按剩余要点重建并保留空主题无引文旧页，撤权永久保留且旧目录继续屏蔽', async () => {
    const fixture = await fixtureWithTopics(), oldPointer = await readFile(path.join(fixture.root, 'state/current.json'), 'utf8')
    await revokeLayeredSources(fixture.knowledgeRoot, ['S-0001', 'S-0003'], '移出收录范围')
    fixture.topicRequests.splice(0); fixture.call.mockClear(); fixture.embed.mockClear()
    const result = await buildLayeredLibrary(fixture.options)
    expect(result.modelCalls).toBe(1 + 1) // 存续主题新增一次核对。
    ; expect(fixture.embed).not.toHaveBeenCalled(); expect(fixture.topicRequests).toHaveLength(1)
    const input = fixture.topicRequests[0]!.input
    expect(input.mode).toBe('rebuild'); expect(input.current_page).toBeUndefined()
    expect(input.points.every(point => point.source_id === 'S-0002' && /^P\d+$/.test(point.point_id))).toBe(true)
    expect(JSON.stringify(input)).not.toContain('撤权专有证据')
    expect(await readLayeredDocument(fixture.knowledgeRoot, 'topics/T-0001.md')).toMatchObject({ status: 'ok' })
    const page = await readLayeredPage(fixture.knowledgeRoot, 'topics/T-0001.md')
    expect(page).toContain('单来源'); expect(page).not.toContain('S-0001'); expect(page).toContain('S-0002')
    expect(await readLayeredPage(fixture.knowledgeRoot, 'sources/S-0001.md')).toBe('更新中')
    expect((await snapshotManifest(fixture.root)).sources.map(source => source.source_id)).toEqual(['S-0002'])
    expect((await stat(path.join(fixture.root, pageObjectPath((await readVersion(fixture.root, result.version)).pages!['topics/T-0002.md']!)))).isFile()).toBe(true)
    expect(await readLayeredPage(fixture.knowledgeRoot, 'T-0002')).toContain('旧主题保留')
    expect(await readLayeredPage(fixture.knowledgeRoot, 'T-0002')).not.toContain('S-0003@')
    expect(await readLayeredPage(fixture.knowledgeRoot)).toContain('T-0002')
    expect(JSON.parse(await readFile(path.join(fixture.root, 'state/revocations.json'), 'utf8')).sources).toHaveLength(2)
    const log = await readFile(path.join(fixture.root, 'logs/build.md'), 'utf8')
    expect(log).toContain('revoke | S-0001'); expect(log).toContain('重建或修订主题：T-0001')
    expect(await readLayeredPage(fixture.knowledgeRoot, 'topics/T-0001.md', { version: 'v000001' })).toBe('更新中')
    await writeFile(path.join(fixture.root, 'state/current.json'), oldPointer)
    expect(await readLayeredPage(fixture.knowledgeRoot, 'topics/T-0001.md')).toBe('更新中')
  })
  it('重建发布中途失败不解除屏蔽、不切换指针；恢复复用干净主题且不能读取未发布目录', async () => {
    const fixture = await fixtureWithTopics(), pointer = await readFile(path.join(fixture.root, 'state/current.json'), 'utf8')
    await revokeLayeredSources(fixture.knowledgeRoot, ['S-0001'], '权限撤回')
    const rename = filesystem.rename
    const fault = vi.spyOn(filesystem, 'rename').mockImplementation(async (from, to) => {
      if (String(to).replaceAll('\\', '/').endsWith('versions/v000002.json')) throw new Error('模拟重建发布失败')
      return await rename(from, to)
    })
    await expect(buildLayeredLibrary(fixture.options)).rejects.toThrow('模拟重建发布失败')
    expect(await readFile(path.join(fixture.root, 'state/current.json'), 'utf8')).toBe(pointer)
    expect(await readLayeredPage(fixture.knowledgeRoot, 'topics/T-0001.md')).toBe('更新中')
    await expect(readLayeredPage(fixture.knowledgeRoot, 'topics/T-0001.md', { version: 'v000002' })).rejects.toThrow('尚未发布')
    fault.mockRestore(); fixture.call.mockClear(); fixture.embed.mockClear()
    expect(await buildLayeredLibrary(fixture.options)).toMatchObject({ version: 'v000003', modelCalls: 0 })
    expect(fixture.call).not.toHaveBeenCalled(); expect(fixture.embed).not.toHaveBeenCalled()
    expect(await readLayeredDocument(fixture.knowledgeRoot, 'topics/T-0001.md')).toMatchObject({ status: 'ok' })
  })
  it('生成期间撤权立即生效并阻止旧代次发布；接续丢弃污染缓存只用剩余要点', async () => {
    const fixture = await fixtureWithTopics(), pointer = await readFile(path.join(fixture.root, 'state/current.json'), 'utf8')
    await writeFile(path.join(fixture.knowledgeRoot, '3.md'), '# 新增\n\n甲组新增证据。')
    const implementation = fixture.call.getMockImplementation()!
    let revoked = false
    fixture.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
      const output = await implementation(...args)
      if (JSON.parse(args[2]).topic_id && !revoked) {
        revoked = true; await revokeLayeredSources(fixture.knowledgeRoot, ['S-0001'], '生成期间撤权')
        expect(await readLayeredPage(fixture.knowledgeRoot, 'topics/T-0001.md')).toBe('更新中')
      }
      return output
    })
    await expect(buildLayeredLibrary(fixture.options)).rejects.toThrow('撤权代次变化')
    expect(await readFile(path.join(fixture.root, 'state/current.json'), 'utf8')).toBe(pointer)
    fixture.topicRequests.splice(0)
    await buildLayeredLibrary(fixture.options)
    expect(fixture.topicRequests).toHaveLength(1)
    expect(fixture.topicRequests[0]!.input).toMatchObject({ mode: 'rebuild' })
    expect(fixture.topicRequests[0]!.input.current_page).toBeUndefined()
    expect(JSON.stringify(fixture.topicRequests[0]!.input)).not.toContain('撤权专有证据')
  })
  it('读取正文后发生撤权，返回前复核代次并替换为更新中', async () => {
    const fixture = await fixtureWithTopics(), originalRead = filesystem.readFile
    const target = path.join(fixture.root, pageObjectPath((await snapshotManifest(fixture.root)).pages!['topics/T-0001.md']!))
    let fired = false
    vi.spyOn(filesystem, 'readFile').mockImplementation((async (...args: Parameters<typeof readFile>) => {
      const output = await originalRead(...args)
      if (!fired && String(args[0]) === target) {
        fired = true; await revokeLayeredSources(fixture.knowledgeRoot, ['S-0001'], '读取期间撤权')
      }
      return output
    }) as typeof readFile)
    expect(await readLayeredDocument(fixture.knowledgeRoot, 'topics/T-0001.md')).toMatchObject({ status: 'updating', content: '更新中' })
    expect(fired).toBe(true)
  })
})
