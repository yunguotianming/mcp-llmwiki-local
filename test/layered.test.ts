// 精确字段契约增加提示词内容哈希、当前与别名路径和实际模型，其余字段及逐字校验保持。
import { expectModelCalls } from './layered-fixture.js'
import * as filesystem from 'node:fs/promises'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'yaml'
import { buildLayeredLibrary, readLayeredPage } from '../src/layered/index.js'
import { extractionPromptHash } from '../src/layered/extraction.js'
import { sections } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, layeredFixture, snapshotManifest } from './layered-fixture.js'

vi.mock('node:fs/promises', async importOriginal => ({ ...await importOriginal<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
describe('分层 Wiki 最小链路', () => {
  it('扫描排除成果和备份，生成不可变快照、附件、完整来源页与发布文件', async () => {
    const fixture = await layeredFixture(), { knowledgeRoot, root } = fixture
    await mkdir(path.join(knowledgeRoot, 'state'), { recursive: true })
    await writeFile(path.join(knowledgeRoot, 'state/layout.json'), JSON.stringify({ version: 1, directory: 'state' }))
    await mkdir(path.join(root, 'nested'), { recursive: true })
    await writeFile(path.join(root, 'library.yaml'), 'format_version: 2\nname: 测试库\ndomain: 通用\nsource_type: Markdown\ndefault_credibility: unknown\n')
    await writeFile(path.join(root, 'nested/generated.md'), '# 不应被导入')
    await writeFile(path.join(knowledgeRoot, 'image.png'), Buffer.from([1, 2, 3]))
    const content = '# 测试资料\r\n\r\n这是可引用的资料。\r\n第二行仍为原文。\r\n\r\n![图](image.png)\r\n'
    await writeFile(path.join(knowledgeRoot, 'a.md'), content)
    const result = await buildLayeredLibrary(fixture.options), manifest = await snapshotManifest(root), entry = manifest.sources[0]!
    // 含标签归并调用：一次提取后，三个去重标签归并 1 次。
    expect(result).toMatchObject({ version: 'v000001', added: ['S-0001'], modelCalls: 2 + 1 }) // 向量模式默认关闭补标，按其余文本阶段精确计数。
    expectModelCalls(fixture.call, { extraction: 1, review: 1, merge: 1 })
    expect(manifest.sources).toHaveLength(1); expect(entry.current_path).toBe('a.md')
    expect(entry).toHaveProperty('previous_paths'); expect(entry.extract.processing).toEqual({ tier: 50, prompt_version: 'layered-extract-v5', prompt_hash: extractionPromptHash(), model: 'mock/extractor' })
    expect(await readFile(path.join(root, entry.files.source), 'utf8')).toBe(content)
    expect(await readFile(path.join(root, entry.files.assets[0]!.path))).toEqual(Buffer.from([1, 2, 3]))
    expect(entry.resource_version).toEqual([entry.files.assets[0]!.hash])
    const extraction = JSON.parse(await readFile(path.join(root, entry.extract.path), 'utf8'))
    expect(extraction.segments.flatMap((segment: { points: unknown[] }) => segment.points)).toHaveLength(4)
    const page = await readLayeredPage(knowledgeRoot, 'sources/S-0001.md'), header = parse(page.split('---')[1]!)
    expect(Object.keys(header).sort()).toEqual(['current_path', 'alias_paths', 'models', 'type', 'created', 'aliases', 'tags', 'id', 'page_type', 'title', 'source_type', 'credibility', 'source_date', 'sources', 'source_version', 'updated'].sort())
    expect(header).toMatchObject({ id: 'S-0001', page_type: 'source', source_version: entry.content_hash, sources: ['S-0001'] })
    for (const section of [...sections, '术语清单']) expect(page).toContain('## ' + section)
    expect(page).toContain('文件时间'); expect(page).toContain(`[S-0001@${entry.content_hash}#`)
    const card = parse(await readFile(path.join(root, 'library.yaml'), 'utf8'))
    expect(card).toMatchObject({ format_version: 2, origin_type: 'local', source_count: 1 })
    for (const field of ['name', 'domain', 'source_type', 'default_credibility', 'updated_at']) expect(card).toHaveProperty(field)
    expect((await stat(path.join(root, 'versions/v000001.json'))).isFile()).toBe(true)
    for (const field of ['pages', 'deps', 'aliases']) expect(manifest).toHaveProperty(field)
    expect((await stat(path.join(root, 'wiki/index.md'))).isFile()).toBe(true)
    expect(await readLayeredPage(knowledgeRoot)).toContain('sources/S-0001.md')
    expect(await readFile(path.join(root, 'logs/build.md'), 'utf8')).toContain('提取 1 次')
    await expect(stat(path.join(root, 'work/pending.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('未变零模型调用且不重写快照，新增分配稳定编号并追加历史', async () => {
    const fixture = await layeredFixture()
    await writeFile(path.join(fixture.knowledgeRoot, 'b.md'), '# 资料乙\n\n乙的结论。')
    await buildLayeredLibrary(fixture.options)
    const first = await snapshotManifest(fixture.root), original = first.sources[0]!, before = await stat(path.join(fixture.root, original.files.source))
    fixture.call.mockClear()
    expect(await buildLayeredLibrary(fixture.options)).toMatchObject({ unchanged: true, modelCalls: 0, version: 'v000001' })
    expect(fixture.call).not.toHaveBeenCalled()
    expect((await stat(path.join(fixture.root, original.files.source))).mtimeMs).toBe(before.mtimeMs)
    await writeFile(path.join(fixture.knowledgeRoot, 'a.md'), '# 资料甲\n\n甲的结论。')
    expect(await buildLayeredLibrary(fixture.options)).toMatchObject({ added: ['S-0002'], modelCalls: 1 + 1, version: 'v000002' }) // 向量模式默认关闭补标，按其余文本阶段精确计数。
    expectModelCalls(fixture.call, { extraction: 1, review: 1 })
    const next = await snapshotManifest(fixture.root)
    expect(next.sources.map(entry => [entry.source_id, entry.current_path])).toEqual([['S-0001', 'b.md'], ['S-0002', 'a.md']])
    expect((await readFile(path.join(fixture.root, 'logs/build.md'), 'utf8')).match(/## \[/g)).toHaveLength(2)
  })
  it('整篇过长时按章节提取并合成摘要，程序拼接同一来源页', async () => {
    const fixture = await layeredFixture()
    await writeFile(path.join(fixture.knowledgeRoot, 'long.md'), '# 长文\n\n' + [1, 2, 3].map(number => `## 章节${number}\n\n${String(number).repeat(500)}\n`).join('\n'))
    const result = await buildLayeredLibrary({ ...fixture.options, maxInputBytes: 3800 })
    // 含标签归并调用：三次章节提取、一次摘要合成后，三个去重标签归并 1 次。
    // 每章长主张按核对输入预算分两批，三章增加六次核对。
    expect(result.modelCalls).toBe(5 + 6); expect(fixture.call).toHaveBeenCalledTimes(5 + 6) // 向量模式默认关闭补标，按其余文本阶段精确计数。
    expectModelCalls(fixture.call, { extraction: 3, summary: 1, review: 6, merge: 1 })
    const page = await readLayeredPage(fixture.knowledgeRoot, 'sources/S-0001.md')
    for (const number of [1, 2, 3]) expect(page).toContain(String(number).repeat(500))
    for (const request of fixture.requests) expect(Buffer.byteLength(request.system + JSON.stringify(request.input))).toBeLessThanOrEqual(3500)
    expect((await snapshotManifest(fixture.root)).sources).toHaveLength(1)
  })
  it('发布中途失败保持旧指针与旧读结果，待更新清单恢复时零调用', async () => {
    const fixture = await layeredFixture()
    await writeFile(path.join(fixture.knowledgeRoot, 'old.md'), '# 旧资料\n\n旧资料的结论。')
    await buildLayeredLibrary(fixture.options)
    const pointerFile = path.join(fixture.root, 'state/current.json'), pointer = await readFile(pointerFile, 'utf8'), oldIndex = await readLayeredPage(fixture.knowledgeRoot)
    await writeFile(path.join(fixture.knowledgeRoot, 'new.md'), '# 新资料\n\n新资料的结论。')
    const rename = filesystem.rename
    vi.spyOn(filesystem, 'rename').mockImplementation(async (from, to) => {
      if (String(to).replaceAll('\\', '/').includes('/objects/pages/') && (await readFile(String(from), 'utf8')).includes('id: S-0002')) throw new Error('模拟发布写入失败')
      return await rename(from, to)
    })
    await expect(buildLayeredLibrary(fixture.options)).rejects.toThrow('模拟发布写入失败')
    expect(await readFile(pointerFile, 'utf8')).toBe(pointer); expect(await readLayeredPage(fixture.knowledgeRoot)).toBe(oldIndex)
    await expect(readLayeredPage(fixture.knowledgeRoot, 'sources/S-0002.md')).rejects.toMatchObject({ code: 'ENOENT' })
    expect(JSON.parse(await readFile(path.join(fixture.root, 'work/pending.json'), 'utf8')).added).toEqual(['S-0002'])
    vi.restoreAllMocks(); const calls = vi.spyOn(fixture.client, 'call')
    expect(await buildLayeredLibrary(fixture.options)).toMatchObject({ version: 'v000003', modelCalls: 0 })
    expect(calls).not.toHaveBeenCalled(); expect(await readLayeredPage(fixture.knowledgeRoot)).toContain('S-0002')
    await expect(stat(path.join(fixture.root, 'work/pending.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
  it('无卡片旧目录备份，旧分层格式拒绝重建且原数据不动', async () => {
    for (const version of [undefined, 99]) {
      const fixture = await layeredFixture()
      // 通用夹具预置当前库卡片；本项明确构造无卡片或旧格式目录。
      await unlink(path.join(fixture.root, 'library.yaml'))
      await mkdir(path.join(fixture.root, 'sources'), { recursive: true })
      await writeFile(path.join(fixture.root, 'sources/legacy.md'), '# 旧数据必须保留')
      if (version !== undefined) await writeFile(path.join(fixture.root, 'library.yaml'), `format_version: ${version}\n`)
      await writeFile(path.join(fixture.knowledgeRoot, 'new.md'), '# 新资料\n\n可提取正文。')
      if (version !== undefined) {
        await expect(buildLayeredLibrary(fixture.options)).rejects.toThrow('请重建')
        expect(await readFile(path.join(fixture.root, 'sources/legacy.md'), 'utf8')).toBe('# 旧数据必须保留')
        expect((await readdir(fixture.knowledgeRoot)).filter(name => name.startsWith('.llmwiki.bak'))).toHaveLength(0)
        continue
      }
      await buildLayeredLibrary({ ...fixture.options, legacyLibraryAction: 'backup' })
      const backups = (await readdir(fixture.knowledgeRoot)).filter(name => /^\.llmwiki\.bak-\d{8}-\d{6}/.test(name))
      expect(backups).toHaveLength(1)
      expect(await readFile(path.join(fixture.knowledgeRoot, backups[0]!, 'sources/legacy.md'), 'utf8')).toBe('# 旧数据必须保留')
      expect((await snapshotManifest(fixture.root)).sources).toHaveLength(1)
      fixture.call.mockClear(); await buildLayeredLibrary(fixture.options); expect(fixture.call).not.toHaveBeenCalled()
    }
  })
})
