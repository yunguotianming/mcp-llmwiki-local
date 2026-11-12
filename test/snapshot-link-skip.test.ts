// 失效、越界或指向目录的链接只跳过该附件，不中断整库快照；正常附件仍保留。
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { readLocalSource, snapshotSource } from '../src/layered/snapshot.js'

const temporary: string[] = []
afterEach(async () => { for (const base of temporary.splice(0)) await rm(base, { recursive: true, force: true }) })

async function prepare() {
  const base = await mkdtemp(path.join(tmpdir(), 'dsh-snapshot-link-'))
  temporary.push(base)
  const knowledgeRoot = path.join(base, 'knowledge'), root = path.join(knowledgeRoot, '.llmwiki')
  await mkdir(knowledgeRoot); await mkdir(root)
  return {
    base, knowledgeRoot, root,
    async snapshot(text: string) {
      const file = path.join(knowledgeRoot, 'note.md')
      await writeFile(file, text)
      const source = await readLocalSource(file, 'Markdown')
      return await snapshotSource(root, knowledgeRoot, 'S-0001', source)
    },
  }
}

describe('快照跳过失效链接', () => {
  it('正文中指向不存在目标的链接跳过，建库不抛错', async () => {
    const f = await prepare()
    const files = await f.snapshot('# 笔记\n\n[见图3](见图3)\n')
    expect(files.assets).toEqual([])
  })
  it('资料根外与 Wiki 输出内的链接跳过，不复制对应文件', async () => {
    const f = await prepare()
    await mkdir(path.join(f.base, 'outside'))
    await writeFile(path.join(f.base, 'outside/a.png'), '资料根外')
    await writeFile(path.join(f.root, 'inner.png'), 'Wiki 输出')
    const files = await f.snapshot('# 笔记\n\n[外](../outside/a.png)\n\n[内](.llmwiki/inner.png)\n')
    expect(files.assets).toEqual([])
  })
  it('指向资料根内目录的链接跳过', async () => {
    const f = await prepare()
    await mkdir(path.join(f.knowledgeRoot, 'docs'))
    const files = await f.snapshot('# 笔记\n\n[目录](docs)\n')
    expect(files.assets).toEqual([])
  })
  it('含非法百分号编码的链接跳过', async () => {
    const f = await prepare()
    const files = await f.snapshot('# 笔记\n\n[坏图](a%ZZ.png)\n')
    expect(files.assets).toEqual([])
  })
  it('正常的本地图片仍写入附件', async () => {
    const f = await prepare()
    await mkdir(path.join(f.knowledgeRoot, 'img'))
    await writeFile(path.join(f.knowledgeRoot, 'img/a.png'), Buffer.from([1, 2, 3]))
    const files = await f.snapshot('# 笔记\n\n![图](img/a.png)\n')
    expect(files.assets).toHaveLength(1)
    expect(files.assets[0]!.original_path).toBe('img/a.png')
    expect(await readFile(path.join(f.root, files.assets[0]!.path))).toEqual(Buffer.from([1, 2, 3]))
  })
})
