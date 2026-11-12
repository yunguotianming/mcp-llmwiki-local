import { cp, lstat, mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { emptyRegistry, newLibrary } from '../domain/config.js'
import type { LibraryRegistration, ModelRef } from '../domain/config.js'
import type { LibraryPolicy } from '../domain/policy.js'
import { LibraryStore } from '../storage/libraries.js'
import { ChangeStore } from '../storage/changes.js'
import { directory, safePath } from '../storage/paths.js'
import { resolveLibraryRoot } from '../storage/library-root.js'
import { scanLibrary } from '../ingest/scanner.js'
import { generateWiki } from '../wiki/generation.js'
import { ModelClient } from '../llm/client.js'
import type { ModelAttempt, ModelRuntime } from '../llm/client.js'
import { buildLayeredLibrary, layeredInputBudget } from './index.js'
import { atomicWrite, hash } from './files.js'
import { addAttempts, costMarkdown, costReport, emptyStage } from './costs.js'
import type { BuildLayeredOptions, CostReport } from './schema.js'

export interface CompareWikiOptions {
  knowledgeRoot: string; runtime: ModelRuntime; model: ModelRef; policy?: Partial<LibraryPolicy>; signal?: AbortSignal
  layered?: Omit<BuildLayeredOptions, 'knowledgeRoot' | 'client' | 'signal'>
  createClient?: (runtime: ModelRuntime, library: LibraryRegistration, policy: LibraryPolicy, flow: 'legacy' | 'layered') => ModelClient
}
// 固定一份资料副本供两个真实入口读取；所有成果和报告留在系统临时目录，调用方按需保留或清理。
export async function compareWikiFlows(options: CompareWikiOptions): Promise<{ directory: string; reportPath: string; legacy: CostReport; layered: CostReport }> {
  const source = await directory(options.knowledgeRoot), temporary = await mkdtemp(path.join(tmpdir(), 'dsh-wiki-comparison-'))
  const input = path.join(temporary, 'input'), legacyRoot = path.join(temporary, 'legacy')
  await cp(source, input, { recursive: true, preserveTimestamps: true, filter: async file => {
    options.signal?.throwIfAborted()
    return !/^\.llmwiki(?:\.bak-|$)/i.test(path.basename(file)) && path.basename(file) !== '.git' && !(await lstat(file)).isSymbolicLink()
  } })
  const library = newLibrary('comparison')
  library.wikiPath = legacyRoot; library.sourceRoots = [input]; library.models.unified = options.model; library.models.fallbacks = []
  const registry = emptyRegistry(); registry.libraries = [library]
  const store = new LibraryStore(() => registry), initialized = await store.initialize(library.id)
  const policy = { ...initialized.policy, ...options.policy }
  await store.savePolicy(library.id, policy, initialized.revision)
  const legacy = costReport(), runtime: ModelRuntime = {
    resolveModelInfo: options.runtime.resolveModelInfo.bind(options.runtime),
    async *stream(request) {
      const text = request.messages.flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
      const data = JSON.parse(text), name = typeof data.text === 'string' ? '提取' : '综合'
      const stage = legacy.stages[name] ??= emptyStage(), key = name + ':' + hash((request.system ?? '') + text)
      if (!legacy.tasks.includes(key)) { legacy.tasks.push(key); stage.logical_tasks++ }
      const attempt: ModelAttempt = { route: { provider: request.provider, model: request.model }, startedAt: new Date().toISOString(), durationMs: 0, finish: 'pending' }
      const start = Date.now()
      try {
        for await (const event of options.runtime.stream(request)) {
          if (event.type === 'usage') attempt.usage = event.usage
          if (event.type === 'finish') attempt.finish = event.reason.kind
          yield event
        }
      } finally { addAttempts(stage, [attempt], Date.now() - start) }
    },
  }
  const started = Date.now(), scan = await scanLibrary(store, library.id, options.signal)
  if (scan.errors.length) throw new Error('对照资料扫描失败：' + scan.errors.map(error => error.message).join('；'))
  const createClient = options.createClient ?? ((runtime: ModelRuntime, library: LibraryRegistration, policy: LibraryPolicy) => new ModelClient(runtime, library, policy))
  const client = createClient(options.runtime, library, policy, 'layered')
  await layeredInputBudget({ ...options.layered, client, ...(options.signal ? { signal: options.signal } : {}) })
  const job = await generateWiki(store, library.id, runtime, options.signal ?? new AbortController().signal, undefined, undefined, false, undefined, createClient(runtime, library, policy, 'legacy'))
  if (job.status !== 'preview' || !job.batchId || job.partial) throw new Error('旧流程没有生成完整可发布成果：' + (job.error ?? job.status))
  const changes = new ChangeStore(store), preview = await changes.preview(library.id, job.batchId)
  await changes.commit(library.id, job.batchId, preview.batch.digest, options.signal)
  const legacyElapsed = Date.now() - started, layeredStarted = Date.now()
  await buildLayeredLibrary({ ...options.layered, knowledgeRoot: input, client, ...(options.signal ? { signal: options.signal } : {}) })
  const output = await resolveLibraryRoot(input, options.layered?.wikiPath, options.layered?.topics || {})
  const reports = JSON.parse(await readFile(await safePath(output, 'logs/costs.json'), 'utf8')) as Record<string, CostReport>
  const layered = Object.values(reports)[0]!
  const report = `# Wiki 流程成本对照\n\n资料目录：${source}\n\n模型：${options.model.provider}/${options.model.model}\n\n来源数：${scan.files.length}\n\n旧流程耗时：${legacyElapsed} ms；分层流程耗时：${Date.now() - layeredStarted} ms。\n\n`
    + `旧流程成果：${legacyRoot}\n\n分层流程成果：${output}\n\n参数：\`${JSON.stringify({ policy, layered: { tier: options.layered?.tier ?? 50, promptVersion: options.layered?.promptVersion ?? 'layered-extract-v5', maxInputBytes: options.layered?.maxInputBytes } })}\`\n\n`
    + `## 旧流程\n\n${costMarkdown(legacy)}\n## 分层流程\n\n${costMarkdown(layered)}\n未报告的用量不计入 Token 总数；实际调用含失败与重试。这里只比较建库成本，页面质量及查询成本须另行评估。\n`
  await atomicWrite(temporary, 'comparison.md', report)
  return { directory: temporary, reportPath: path.join(temporary, 'comparison.md'), legacy, layered }
}
