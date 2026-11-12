import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { ChangeStore } from '../src/storage/changes.js'
import { checkWiki, maintenanceHistory, prepareMaintenance, recordMaintenance } from '../src/wiki/maintenance.js'
import { askWiki } from '../src/wiki/chat.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { temporaryWorkspace } from './temp.js'
import { mockFixtureSync } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => vi.restoreAllMocks())

async function fixture() {
  const temp = await temporaryWorkspace(), library = newLibrary('migration')
  mockFixtureSync(temp.root)
  library.wikiPath = temp.root; library.models.unified = { provider: 'fake', model: 'fake' }
  const registry = emptyRegistry(); registry.libraries = [library]
  const store = new LibraryStore(() => registry); await store.initialize(library.id)
  await mkdir(path.join(temp.root, 'concepts')); await mkdir(path.join(temp.root, 'sources'))
  const put = (name: string, text: string) => writeFile(path.join(temp.root, name), text)
  const policy = async (changes: object) => { const view = await store.policy(library.id); await store.savePolicy(library.id, { ...view.policy, ...changes }, view.revision) }
  return { ...temp, library, store, put, policy }
}
function runtime(answer: (options: GenerateOptions) => string | Promise<string>): ModelRuntime {
  return { async resolveModelInfo(provider, id) { return { provider, id, name: id, context: { contextWindow: 100000 } } },
    async *stream(options) { yield { type: 'text-delta', text: await answer(options) }; yield { type: 'finish', reason: { kind: 'stop' } } } }
}

describe('Obsidian 设置执行语义补齐', () => {
  it('链接、正文和标题阈值改变检查结果，来源仅互相查重且可排除', async () => {
    const f = await fixture()
    try {
      await f.put('concepts/a.md', '# 阿尔法\n\nalpha beta gamma\n\n[[共同]] [[左侧]]')
      await f.put('concepts/b.md', '# 贝塔\n\nalpha beta delta\n\n[[共同]] [[右侧]]')
      await f.policy({ lintBigramThreshold: 1, lintJaccardLinkThreshold: 0.3, lintJaccardBodyGate: 0.2 })
      expect((await checkWiki(f.store, f.library.id)).duplicates).toHaveLength(1)
      await f.policy({ lintJaccardBodyGate: 1 })
      expect((await checkWiki(f.store, f.library.id)).duplicates).toEqual([])
      await f.policy({ lintJaccardBodyGate: 0.2, lintJaccardLinkThreshold: 0.8 })
      expect((await checkWiki(f.store, f.library.id)).duplicates).toEqual([])
      await f.put('concepts/b.md', '# 阿尔法变体\n\n完全不同的正文。')
      await f.policy({ lintBigramThreshold: 0.4 })
      expect((await checkWiki(f.store, f.library.id)).duplicates?.[0]?.reason).toBe('标题或别名相似')
      await f.put('sources/a.md', '# 来源一\n\n完全相同的来源正文。')
      await f.put('sources/b.md', '# 来源二\n\n完全相同的来源正文。')
      expect((await checkWiki(f.store, f.library.id)).duplicates?.filter(pair => pair.left.startsWith('sources/'))).toHaveLength(1)
      await f.policy({ lintDedupIncludeSources: false })
      expect((await checkWiki(f.store, f.library.id)).duplicates?.some(pair => pair.left.startsWith('sources/') || pair.right.startsWith('sources/'))).toBe(false)
    } finally { await f.cleanup() }
  })
  it('智能检查只修正实际 Wiki 链接，保留代码、别名显示和人工正文，报告可读', async () => {
    const f = await fixture()
    try {
      await f.put('concepts/a.md', '# 研究\n\n人工说明 [[错别字|显示名称]]。\n\n`[[错别字]]`\n')
      await f.put('concepts/target.md', '# 方法\n\n正确知识。')
      const model = runtime(() => JSON.stringify({ links: [{ path: 'concepts/a.md', ref: '错别字', target: 'concepts/target.md', reason: '指向现有方法页' }], duplicates: [] }))
      const report = await checkWiki(f.store, f.library.id, undefined, model)
      await recordMaintenance(f.store, f.library.id, report)
      expect((await maintenanceHistory(f.store, f.library.id))[0]?.smart?.links).toHaveLength(1)
      const batch = await prepareMaintenance(f.store, f.library.id, report.revision, 'smart-repair')
      const changes = new ChangeStore(f.store)
      await changes.commit(f.library.id, batch.id, batch.digest)
      const text = await readFile(path.join(f.root, 'concepts/a.md'), 'utf8')
      expect(text).toContain('人工说明 [[concepts/target|显示名称]]。')
      expect(text).toContain('`[[错别字]]`')
      expect((await checkWiki(f.store, f.library.id)).issues.some(issue => issue.kind === 'broken-link')).toBe(false)
    } finally { await f.cleanup() }
  })
  it('拒绝模型编造的目标，Wiki 改动后旧智能修复报告失效', async () => {
    const f = await fixture()
    try {
      await f.put('concepts/a.md', '# 研究\n\n[[坏链接]]')
      const invalid = runtime(() => JSON.stringify({ links: [{ path: 'concepts/a.md', ref: '坏链接', target: '../outside.md', reason: '模型编造' }], duplicates: [] }))
      await expect(checkWiki(f.store, f.library.id, undefined, invalid)).rejects.toThrow('以外')
      const report = await checkWiki(f.store, f.library.id, undefined, runtime(() => '{"links":[],"duplicates":[]}'))
      await recordMaintenance(f.store, f.library.id, report)
      await f.put('concepts/a.md', '# 研究\n\n人工改动 [[坏链接]]')
      await expect(prepareMaintenance(f.store, f.library.id, report.revision, 'smart-repair')).rejects.toThrow('已变化')
      expect(await new ChangeStore(f.store).list(f.library.id)).toEqual([])
    } finally { await f.cleanup() }
  })
  it('问答按关联轮数、自定义指令和输出语言执行，引用可回到本次证据', async () => {
    const f = await fixture()
    try {
      await f.put('concepts/a.md', '# 测试方法\n\n方法的适用条件是虚构场景。')
      await f.policy({ maxConversationHistory: 2, queryInstructions: '先给简短结论', wikiLanguage: 'zh-CN' })
      let input = '', system = ''
      const model = runtime(options => { input = JSON.stringify(options.messages); system = String(options.system); return '{"answer":"适用于虚构场景 [1]","citations":[1]}' })
      const result = await askWiki(f.store, f.library.id, '测试方法', [{ question: '旧问题', answer: '旧答案' }, { question: '新问题', answer: '新答案' }], model)
      expect(result.historyUsed).toBe(1); expect(input).not.toContain('旧问题'); expect(input).toContain('新问题')
      expect(system).toContain('先给简短结论'); expect(system).toContain('zh-CN')
      expect(result.citations[0]).toMatchObject({ number: 1, path: 'concepts/a.md' })
      expect(result.citations[0]?.excerpt).toContain('虚构场景')
      await f.policy({ maxConversationHistory: 1 })
      expect((await askWiki(f.store, f.library.id, '测试方法', [{ question: '新问题', answer: '新答案' }], model)).historyUsed).toBe(0)
    } finally { await f.cleanup() }
  })
  it('问答没有证据时不调模型，非法引用重试后仍拒绝，生成期间变更不发布旧回答', async () => {
    const f = await fixture()
    try {
      let calls = 0
      const model = runtime(() => { calls++; return '{"answer":"编造 [9]","citations":[9]}' })
      expect((await askWiki(f.store, f.library.id, '没有证据', [], model)).citations).toEqual([]); expect(calls).toBe(0)
      await f.put('concepts/a.md', '# 测试方法\n\n测试依据。')
      await expect(askWiki(f.store, f.library.id, '测试方法', [], model)).rejects.toThrow(); expect(calls).toBe(2)
      const changed = runtime(async () => { await f.put('concepts/a.md', '# 测试方法\n\n已变更。'); return '{"answer":"测试 [1]","citations":[1]}' })
      await expect(askWiki(f.store, f.library.id, '测试方法', [], changed)).rejects.toThrow('已变化')
    } finally { await f.cleanup() }
  })
})
