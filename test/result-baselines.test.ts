import { mockSupportReview } from './layered-fixture.js'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import type { Candidate } from '../src/ingest/extraction.js'
import { scanLibrary } from '../src/ingest/scanner.js'
import type { SourceRecord } from '../src/ingest/scanner.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { ChangeStore } from '../src/storage/changes.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { safePath } from '../src/storage/paths.js'
import { BEGIN, END } from '../src/wiki/documents.js'
import type { KnowledgeCatalog } from '../src/wiki/documents.js'
import { generateWiki } from '../src/wiki/generation.js'
import { checkWiki, prepareMaintenance } from '../src/wiki/maintenance.js'
import { WikiQuery } from '../src/wiki/query.js'
import { temporaryWorkspace } from './temp.js'
import { mockFixtureSync } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => vi.restoreAllMocks())

const baseline = async (name: string) => JSON.parse(await readFile(new URL(`./baselines/${name}.json`, import.meta.url), 'utf8'))
const body = (raw: string) => raw.slice(raw.indexOf(BEGIN) + BEGIN.length + 1, raw.indexOf(END)).trimEnd()
const byPath = <T extends { path: string }>(items: T[]) => items.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
const operation = (page: { before: string | null; after: string | null }) => page.after === null ? 'delete' : page.before === null ? 'create' : 'update'

async function fixture(readonly = false) {
  const temp = await temporaryWorkspace(), library = newLibrary('result-baselines')
  mockFixtureSync(temp.root)
  library.name = '研究资料'; library.wikiPath = path.join(temp.root, 'wiki')
  library.models.unified = { provider: 'fixture', model: 'controlled' }
  if (readonly) { library.kind = 'obsidian'; library.mode = 'readonly' }
  const registry = emptyRegistry(); registry.libraries = [library]
  const store = new LibraryStore(() => registry)
  if (!readonly) {
    const view = await store.initialize(library.id)
    await store.savePolicy(library.id, { ...view.policy, wikiLanguage: 'zh', batchDelayMs: 0, analysisConcurrency: 2, pageGenerationConcurrency: 2 }, view.revision)
  }
  await mkdir(path.join(library.wikiPath, 'concepts'), { recursive: true })
  await mkdir(path.join(library.wikiPath, 'sources'), { recursive: true })
  const put = (relative: string, raw: string) => writeFile(path.join(library.wikiPath, relative), raw)
  return { ...temp, library, store, put, changes: new ChangeStore(store), query: new WikiQuery(store) }
}

// 只控制模型输出；解析、验证、综合、批次提交与读取均经过生产入口。
const controlledModel: ModelRuntime = {
  async resolveModelInfo(provider, id) { return { provider, id, name: id } },
  async *stream(options): AsyncIterable<StreamChunk> {
    const input = JSON.parse((options.messages[0]!.content[0] as { text: string }).text)
      const support = mockSupportReview(input)
      if (support) { yield { type: 'text-delta', index: 0, text: support }; yield { type: 'finish', reason: { kind: 'stop' } }; return }
    let output: unknown
    if (input.candidates) {
      const candidates = input.candidates as Candidate[], claims = candidates.flatMap(candidate => candidate.claims)
      output = { groups: [{ type: 'concept', title: '青松初检流程', identity: '青松初检流程', aliases: ['青松'], tags: [],
        members: candidates.map(candidate => candidate.id), conflicts: [claims.map(claim => claim.id)] }] }
    } else {
      expect(input.text).not.toContain('base64')
      const quote = /青松流程初检为\d+\/20。/.exec(input.text)![0]
      output = { candidates: input.round === 1 ? [{ type: 'concept', title: '青松初检流程', identity: '青松初检流程', aliases: ['青松'], tags: [], mentionOnly: false, claims: [{ text: quote, quote }] }] : [], images: [] }
    }
    yield { type: 'text-delta', index: 0, text: JSON.stringify(output) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

describe('生产入口的固定结果基线', () => {
  it('生成保留冲突、逐条出处和原图，重建删除集合可预览后提交', async () => {
    const f = await fixture(), source = path.join(f.root, '资料')
    const originals = { 'a.md': '# 观察A\n\n青松流程初检为18/20。\n\n![流程图](data:image/png;base64,AQID)', 'b.md': '# 观察B\n\n青松流程初检为17/20。' }
    try {
      await mkdir(source); f.library.sourceRoots = [source]
      for (const [name, raw] of Object.entries(originals)) await writeFile(path.join(source, name), raw)
      await f.put('concepts/legacy.md', '# 旧知识\n\n旧版内容。')
      await f.put('index.md', '# 旧索引\n')
      await scanLibrary(f.store, f.library.id)
      const job = await generateWiki(f.store, f.library.id, controlledModel, new AbortController().signal, undefined, undefined, true)
      const preview = await f.changes.preview(f.library.id, job.batchId!)
      const records = JSON.parse(await readFile(await safePath(f.library.wikiPath, '.llmwiki/sources/catalog.json'), 'utf8')) as SourceRecord[]
      const catalog = JSON.parse(preview.pages.find(page => page.path === '.llmwiki/knowledge/catalog.json')!.after!) as KnowledgeCatalog
      const names = new Map(records.map(record => [record.id, path.basename(record.absolutePath)]))
      // 只替换本次已知的随机身份和版本，保留主张、引文、路径结构及正文顺序。
      const stable = (raw: string) => {
        for (const record of records) {
          const name = names.get(record.id)!.slice(0, -3)
          const chunks = job.chunks.filter(chunk => chunk.sourceId === record.id && chunk.status === 'complete')
          for (const chunk of chunks) raw = raw.replaceAll(chunk.chunkId, `chunk-${name}`)
          raw = raw.replaceAll(record.hash, `version-${name}`).replaceAll(record.hash.slice(0, 12), `version-${name}`).replaceAll(record.id, `source-${name}`)
        }
        return raw
      }
      const result = {
        status: job.status, sources: [job.sourcesCompleted, job.sourceTotal],
        changes: byPath(preview.pages.map(page => ({ path: stable(page.path), operation: operation(page) }))),
        knowledge: catalog.pages.map(page => ({ path: page.path, type: page.type, title: page.title, identity: page.identity, aliases: page.aliases, tags: page.tags,
          claims: page.claims.map(claim => ({ text: claim.text, source: names.get(claim.evidence.sourceId), quote: claim.evidence.quote, line: claim.evidence.line })).sort((a, b) => a.source!.localeCompare(b.source!)),
          conflicts: page.conflicts.map(group => group.map(id => page.claims.find(claim => claim.id === id)!.text).sort()),
          body: stable(body(preview.pages.find(proposal => proposal.path === page.path)!.after!)),
        })),
        sourceQuotes: byPath(records.map(record => ({ path: names.get(record.id)!, quotes: preview.pages.find(page => page.path === `sources/${record.id}.md`)!.after!.split('\n').filter(line => line.startsWith('> ')) }))),
        images: preview.pages.filter(page => page.path.startsWith('sources/')).flatMap(page => [...page.after!.matchAll(/!\[[^\]]*\]\([^\n]*\)/g)].map(match => match[0])),
      }
      expect(result).toEqual(await baseline('generation'))
      expect(await readFile(path.join(f.library.wikiPath, 'concepts/legacy.md'), 'utf8')).toBe('# 旧知识\n\n旧版内容。')
      await f.changes.commit(f.library.id, job.batchId!, preview.batch.digest)
      expect(await readFile(path.join(f.library.wikiPath, catalog.pages[0]!.path), 'utf8')).toBe(preview.pages.find(page => page.path === catalog.pages[0]!.path)!.after)
      await expect(readFile(path.join(f.library.wikiPath, 'concepts/legacy.md'))).rejects.toThrow()
      expect((await f.query.read('青松')).title).toBe('青松初检流程')
      for (const [name, raw] of Object.entries(originals)) expect(await readFile(path.join(source, name), 'utf8')).toBe(raw)
    } finally { await f.cleanup() }
  })

  it('只读查询固定别名排序、链接传播、类型筛选及完整阅读结果', async () => {
    const f = await fixture(true)
    try {
      await f.put('concepts/design.md', '---\ntitle: 抽样流程\naliases: [青松]\ntags: [方法]\n---\n# 抽样流程\n\n相互独立的样本。[[sources/note]]')
      await f.put('sources/note.md', '# 资料说明\n\n来源原文。')
      await f.put('concepts/inactive.md', '---\nllmwikiNoActiveEvidence: true\n---\n# 青松旧结论\n\n撤出内容。')
      const search = await f.query.search('青松'), filtered = await f.query.search('青松', f.library.name, ['source'])
      const project = (result: typeof search) => ({ query: result.query, total: result.total, searchedLibraries: result.searchedLibraries,
        results: result.results.map(({ library, path, type, title, aliases, summary }) => ({ library, path, type, title, aliases, summary })) })
      const result = { catalog: (await f.query.catalog()).libraries.map(({ libraryId: _, path: __, ...library }) => library), search: project(search), filtered: project(filtered), read: await f.query.read('青松') }
      expect(result).toEqual(await baseline('query'))
      expect((await f.query.search('撤出内容')).results).toEqual([])
      expect(await readdir(f.library.wikiPath)).toEqual(['concepts', 'sources'])
    } finally { await f.cleanup() }
  })

  it('维护固定诊断、标题与占位修复、索引变更并保留人工原文', async () => {
    const f = await fixture(), original = '# 人工索引\r\n\r\n保留这一段。  \r\n'
    try {
      await f.put('concepts/a.md', '---\ntitle: 抽样流程\n---\n正文 [[待补概念]]。\n')
      await f.put('index.md', original)
      const report = await checkWiki(f.store, f.library.id)
      const repair = await prepareMaintenance(f.store, f.library.id, report.revision, 'repair')
      const preview = await f.changes.preview(f.library.id, repair.id)
      expect(await readFile(path.join(f.library.wikiPath, 'concepts/a.md'), 'utf8')).not.toContain('# 抽样流程')
      await f.changes.commit(f.library.id, repair.id, repair.digest)
      const index = await prepareMaintenance(f.store, f.library.id, (await checkWiki(f.store, f.library.id)).revision, 'index')
      const indexed = await f.changes.preview(f.library.id, index.id)
      const result = {
        issues: report.issues.map(({ path, kind, message, repairable }) => ({ path, kind, message, repairable })),
        repair: byPath(preview.pages.map(page => ({ path: page.path, operation: operation(page), after: page.after }))),
        index: byPath(indexed.pages.map(page => ({ path: page.path, operation: operation(page), body: body(page.after!).replaceAll(repair.createdAt, '<时间>').replaceAll(repair.id, '<批次>') }))),
      }
      expect(result).toEqual(await baseline('maintenance'))
      await f.changes.commit(f.library.id, index.id, index.digest)
      expect((await readFile(path.join(f.library.wikiPath, 'index.md'), 'utf8')).startsWith(original)).toBe(true)
      expect((await checkWiki(f.store, f.library.id)).issues.some(issue => issue.kind === 'broken-link')).toBe(false)
    } finally { await f.cleanup() }
  })
})
