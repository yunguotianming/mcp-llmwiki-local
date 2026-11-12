import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import path from 'node:path'
import { fromMarkdown } from 'mdast-util-from-markdown'
import * as files from '../src/layered/files.js'
import { evidenceBlockIds, readBlock, migrateAnchors } from '../src/layered/anchors.js'
import { renderSource } from '../src/layered/extraction.js'
import { readLayeredPage } from '../src/layered/index.js'
import { pageParagraphs, excerpts } from '../src/wiki/page-search.js'
import { signature } from '../src/storage/files.js'
import { cleanupLayeredFixtures, snapshotManifest } from './layered-fixture.js'
import { built, extracted } from './tags-anchors-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
vi.mock('../src/layered/files.js', async original => ({ ...await original<typeof import('../src/layered/files.js')>() }))
afterEach(cleanupLayeredFixtures)
const chaptersText = '# 分章资料\n\n' + [1, 2, 3].map(n => `## 章节${n}\n\n第${n}章的研究证据。`).join('\n\n')
beforeAll(async () => { await built(true, chaptersText) })

it('A01 同页哈希碰撞、多证据及输入逆序仍稳定且不同页独立计数', () => {
  vi.spyOn(files, 'hash').mockReturnValue('sha256:' + 'a'.repeat(64))
  const point = (id: string, count = 1): any => ({ point_id: id, evidence: Array(count).fill({}) })
  const points = [point('S-0001:z'), point('S-0001:a', 2), point('S-0002:a')]
  const result = evidenceBlockIds(points)
  expect([...result]).toEqual([...evidenceBlockIds([...points].reverse())])
  expect(result.get('S-0001:a')).toEqual(['paaaaaaaaaaaa', 'paaaaaaaaaaaa-2'])
  expect(result.get('S-0001:z')).toEqual(['paaaaaaaaaaaa-3'])
  expect(result.get('S-0002:a')).toEqual(['paaaaaaaaaaaa'])
})

it('A02 全库逐条解析证据章节链接，目标块存在且每页唯一', async () => {
  const f = await built(true, chaptersText)
  const manifest = await snapshotManifest(f.root), pages = new Map<string, string>()
  for (const page of Object.keys(manifest.pages!)) pages.set(page, await readLayeredPage(f.knowledgeRoot, page))
  let count = 0, chapters = 0
  for (const [page, content] of pages) {
    const ids = [...content.matchAll(/ \^([A-Za-z0-9-]+)$/gm)].map(match => match[1])
    expect(new Set(ids).size).toBe(ids.length)
    const visit = (node: any) => {
      if (node.type === 'link' && node.url.includes('#')) {
        const [file, fragment] = node.url.split('#')
        const target = file ? path.posix.normalize(path.posix.join(path.posix.dirname(page), file)) : page
        expect(fragment).toMatch(/^\^[A-Za-z0-9-]+$/)
        expect(pages.get(target)?.split('\n').some(line => line.endsWith(' ' + fragment))).toBe(true)
        count++; if (fragment.startsWith('^chapter-')) chapters++
      }
      node.children?.forEach(visit)
    }
    visit(fromMarkdown(content))
  }
  expect(count).toBeGreaterThan(3); expect(chapters).toBeGreaterThan(1)
})

it('A03 多行证据包含列表时块 ID 必须标识整条证据而非最后的嵌套项', async () => {
  const f = await extracted('- 第一项研究证据\n- 第二项研究证据')
  const point = f.extraction.segments.flatMap(segment => segment.points)[0]!
  expect(point.evidence[0]!.quote).toContain('\n- ')
  const id = evidenceBlockIds([point]).get(point.point_id)![0]!
  const page = renderSource(f.entry, f.extraction), block = readBlock(page, '^' + id)!
  expect(block).toContain(point.point_id)
  expect(block).toContain(point.evidence[0]!.quote)
})

it('A04 围栏代码证据的块标记不得落入代码块或破坏闭合围栏', async () => {
  const f = await extracted('```text\n研究证据\n```', output => { if (output.points) output.points[0].text = '研究证据' })
  const point = f.extraction.segments.flatMap(segment => segment.points)[0]!
  const id = evidenceBlockIds([point]).get(point.point_id)![0]!
  const page = renderSource(f.entry, f.extraction), tree = fromMarkdown(page)
  const swallowed: string[] = []
  const visit = (node: any) => {
    if (node.type === 'code' && page.slice(node.position.start.offset, node.position.end.offset).includes('^' + id)) swallowed.push(page.slice(node.position.start.offset, node.position.end.offset))
    node.children?.forEach(visit)
  }
  visit(tree)
  expect(swallowed).toEqual([])
})

it('A05 新旧锚点混合读取与摘录逐字哈希，代码中的旧链接不应迁移', () => {
  const page = '<a id="legacy"></a>\n## 历史\n\n旧证据。\n\n## 新证据 ^chapter-new\n\n证据第一行\n第二行🦊 ^pabc\n'
  expect(pageParagraphs(page, ['旧证据']).find(item => item.content.includes('旧证据'))?.anchor).toBe('legacy')
  expect(pageParagraphs(page, ['第二行']).find(item => item.content.includes('第二行'))?.anchor).toBe('^pabc')
  for (const item of excerpts({ library: '审查', path: 'source.md', title: '证据', content: page }, ['证据'], 3000)) {
    expect(page).toContain(item.content); expect(item.content).not.toMatch(/ \^[\w-]+/)
    expect(item.quote_hash).toBe(signature(item.content))
  }
  const literal = '```md\n[逐字示例](../sources/S-0001.md#S-0001:old)\n```'
  expect(migrateAnchors(literal, new Map([['S-0001:old', ['pabc']]]))).toBe(literal)
  const inline = '`[逐字示例](../sources/S-0001.md#S-0001:old)`'
  expect(migrateAnchors(inline, new Map([['S-0001:old', ['pabc']]]))).toBe(inline)
  const real = '[真实引用](../sources/S-0001.md#S-0001:old)'
  expect(migrateAnchors(real + '\n\n' + literal + '\n\n' + inline, new Map([['S-0001:old', ['pabc']]])))
    .toBe(real.replace('#S-0001:old', '#^pabc') + '\n\n' + literal + '\n\n' + inline)
})
