import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { expect, it } from 'vitest'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { ChangeStore } from '../src/storage/changes.js'
import { askWiki } from '../src/wiki/chat.js'
import { checkWiki, prepareMaintenance, recordMaintenance } from '../src/wiki/maintenance.js'
import { BEGIN, END, blockSignature } from '../src/wiki/documents.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { temporaryWorkspace } from './temp.js'

async function fixture() {
  const temp = await temporaryWorkspace(), library = newLibrary('boundaries'), registry = emptyRegistry()
  library.wikiPath = path.join(temp.root, 'wiki'); library.models.unified = { provider: 'fake', model: 'fake' }; registry.libraries = [library]
  const store = new LibraryStore(() => registry); await store.initialize(library.id)
  await mkdir(path.join(library.wikiPath, 'concepts'))
  const put = (name: string, text: string) => writeFile(path.join(library.wikiPath, name), text)
  return { ...temp, library, store, put }
}
const runtime = (answer: string, contextWindow = 100000): ModelRuntime => ({
  async resolveModelInfo(provider, id) { return { provider, id, name: id, defaultMaxTokens: 1000, context: { contextWindow } } },
  async *stream() { yield { type: 'text-delta', text: answer }; yield { type: 'finish', reason: { kind: 'stop' } } },
})

it('检查和智能修复跳过生成区，只修复人工区坏链接并保留生成区哈希', async () => {
  const f = await fixture()
  try {
    const before = `# 页面\n\n${BEGIN}\n[[生成区坏链接]]\n${END}\n\n人工 [[拼错]]，[[#页面]]，[[https://example.com]]。\n`
    await f.put('concepts/a.md', before); await f.put('concepts/target.md', '# 目标\n\n已有依据。')
    let calls = 0
    const model = runtime('')
    model.stream = async function* () { calls++; yield { type: 'text-delta', text: '{"links":[{"path":"concepts/a.md","ref":"拼错","target":"concepts/target.md","reason":"对应已有页面"}],"duplicates":[]}' }; yield { type: 'finish', reason: { kind: 'stop' } } }
    const report = await checkWiki(f.store, f.library.id, undefined, model)
    expect(calls).toBe(1); expect(report.issues.some(issue => issue.message.includes('生成区坏链接'))).toBe(false); await recordMaintenance(f.store, f.library.id, report)
    const batch = await prepareMaintenance(f.store, f.library.id, report.revision, 'smart-repair')
    await new ChangeStore(f.store).commit(f.library.id, batch.id, batch.digest)
    const after = await readFile(path.join(f.library.wikiPath, 'concepts/a.md'), 'utf8')
    expect(blockSignature(after)).toBe(blockSignature(before)); expect(after).toContain('人工 [[concepts/target]]')
    expect(after).toContain('[[#页面]]，[[https://example.com]]')
    await expect(readFile(path.join(f.library.wikiPath, 'concepts/generated.md'), 'utf8')).rejects.toThrow()
  } finally { await f.cleanup() }
})

it('问答拒绝正文未出现证据编号的回答', async () => {
  const f = await fixture()
  try {
    await f.put('concepts/a.md', '# 测试方法\n\n虚构依据。')
    await expect(askWiki(f.store, f.library.id, '测试方法', [], runtime('{"answer":"没有引用编号","citations":[1]}'))).rejects.toThrow('正文必须使用引用编号')
  } finally { await f.cleanup() }
})

it('问答通过既有图排序获取间接相连的 Wiki 依据', async () => {
  const f = await fixture()
  try {
    await f.put('concepts/a.md', '# 测试方法\n\n[[concepts/b]]')
    await f.put('concepts/b.md', '# 桥接\n\n[[concepts/c]]')
    await f.put('concepts/c.md', '# 最终条件\n\n必须核对实际出处。')
    const answer = await askWiki(f.store, f.library.id, '测试方法', [], runtime('{"answer":"核对出处 [3]","citations":[3]}'))
    expect(answer.citations[0]?.path).toBe('concepts/c.md')
  } finally { await f.cleanup() }
})

it('问答预算不足时移除旧历史后缩短证据，返回实际使用的快照', async () => {
  const f = await fixture()
  try {
    await f.put('concepts/a.md', '# 测试方法\n\n' + '虚构知识依据。'.repeat(1000))
    const answer = await askWiki(f.store, f.library.id, '测试方法', [{ question: '旧问题', answer: '旧答案'.repeat(1000) }], runtime('{"answer":"依据 [1]","citations":[1]}', 3500))
    expect(answer.historyUsed).toBe(0)
    expect(answer.citations[0]!.excerpt.length).toBeLessThan(1000)
  } finally { await f.cleanup() }
})

it('问答尊重 Obsidian 共享清单的名称及参与查询开关', async () => {
  const f = await fixture()
  try {
    await f.put('concepts/a.md', '# 测试方法\n\n虚构依据。')
    await mkdir(path.join(f.root, '.obsidian'))
    f.library.kind = 'obsidian'; f.library.mode = 'readonly'; f.library.vaultPath = f.root
    const manifest = { version: 1, databases: [{ name: '清单中的名称', description: '清单简介', wikiFolder: 'wiki', dshEnabled: true }] }
    await writeFile(path.join(f.root, '.llm-wiki-databases.json'), JSON.stringify(manifest))
    expect((await askWiki(f.store, f.library.id, '测试方法', [], runtime('{"answer":"依据 [1]","citations":[1]}'))).citations[0]?.path).toBe('concepts/a.md')
    manifest.databases[0]!.dshEnabled = false
    await writeFile(path.join(f.root, '.llm-wiki-databases.json'), JSON.stringify(manifest))
    await expect(askWiki(f.store, f.library.id, '测试方法', [], runtime(''))).rejects.toThrow('查询开关')
  } finally { await f.cleanup() }
})
