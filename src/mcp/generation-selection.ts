import { z } from 'zod'
import path from 'node:path'
import { granularityTier, granularityTiers } from '../domain/granularity.js'
import type { LibraryStore } from '../storage/libraries.js'
import { sourceRetryRequest } from '../layered/source-recovery.js'
import type { GenerateInput } from '../local/jobs.js'
import { readCurrent } from '../layered/objects.js'
import { readOptional } from '../storage/files.js'
import { safePath } from '../storage/paths.js'
import type { PendingBuild } from '../layered/schema.js'
import { withBuildLock } from '../layered/files.js'
import { effectiveSourceRoots } from '../domain/config.js'

export const generationChoiceShape = {
  extractionGranularity: z.enum(['minimal', 'coarse', 'balanced', 'standard', 'detailed', 'fine', 'custom']).optional()
    .describe('用户明确选择的首次建库颗粒度；收到 selection_required 后先向用户解释全部档位并询问，不可代选。已有库沿用原策略。'),
  customPointLimit: z.number().int().min(1).max(500).optional().describe('仅 custom 必填：每篇要点上限 1～500，固定上限不随篇幅扩额。'),
}
export const generationSelectionInstructions = '新库首次生成前须向用户解释六档及自定义的覆盖深度、要点上限和核对强度，并询问选择。wiki_generate 返回 selection_required 时不代表作业已启动；把 choices 展示给用户，收到明确选择后再传 extractionGranularity，custom 同时传 customPointLimit。不得自行选择标准档。已有库默认沿用已有颗粒度。'
export const generationSelectionDescription = '首次尚无建库成果或恢复任务且未明确选择颗粒度时返回 selection_required 和全部档位说明，不启动作业；客户端须向用户解释并询问后，携 extractionGranularity 再调用（custom 必带 customPointLimit=1～500 整数，其他档不得带）。上限并非保证产出数量，预设按篇幅扩额且核对强度不同；已有成果或恢复任务的库沿用原策略，此参数不能换档。'
type Choice = z.infer<z.ZodObject<typeof generationChoiceShape>>
const reservations = new Set<string>()
function selectionRequired(libraryId: string) {
  return {
    libraryId, status: 'selection_required' as const,
    message: '请先向用户解释以下全部档位并询问选择，再调用 wiki_generate；尚未启动生成作业。',
    explanation: '颗粒度控制每篇资料的覆盖深度与要点上限。上限不是产出配额；六个预设按篇幅扩额，短文请求可能进一步收缩，自定义固定上限不扩额。越细通常耗时与模型消耗越高。核对配置可由库的显式设置覆盖。',
    choices: granularityTiers.map(tier => ({ extractionGranularity: tier.name, label: tier.label,
      description: tier.description, selectivity: tier.selectivity || '按用户指定上限提取',
      ...(tier.name === 'custom' ? { customPointLimit: { minimum: 1, maximum: 500, integer: true }, review: '沿用不超过自定义上限的最高预设档位核对强度。' }
        : { basePointLimit: tier.value, review: tier.defaults.extractionReview === 'all' ? '全量提取核对、主题核对和矛盾核对。'
          : tier.defaults.extractionReview === 'key' ? '关键提取核对和主题核对；默认不做矛盾核对。' : '默认不做提取、主题和矛盾核对。' }) })),
  }
}

/** 占用覆盖保存与原入口派发之间的窗口；原作业启动后继续由宿主运行表保护。 */
export async function withMcpGenerationSelection<T>(store: LibraryStore, input: GenerateInput & Choice,
  running: ReadonlyMap<string, AbortController>, generate: () => Promise<T>) {
  await store.root(input.libraryId, true)
  const key = path.resolve(effectiveSourceRoots(store.registration(input.libraryId))[0]!).toLowerCase()
  if (reservations.has(key) || running.has(input.libraryId)) throw new Error('数据库正在被占用：请先等待当前任务结束或暂停，再生成。')
  reservations.add(key)
  try { return await prepareMcpGeneration(store, input) ?? await generate() }
  finally { reservations.delete(key) }
}

/** 两个 MCP 入口共用首次选择门禁；领域默认值和其他宿主的生成流程保持原样。 */
export async function prepareMcpGeneration(store: LibraryStore, input: GenerateInput & Choice, locked = false): Promise<ReturnType<typeof selectionRequired> | undefined> {
  const choice = z.strictObject(generationChoiceShape).parse({
    ...(input.extractionGranularity !== undefined ? { extractionGranularity: input.extractionGranularity } : {}),
    ...(input.customPointLimit !== undefined ? { customPointLimit: input.customPointLimit } : {}),
  })
  if (choice.extractionGranularity === 'custom' ? choice.customPointLimit === undefined : choice.customPointLimit !== undefined)
    throw new Error('自定义颗粒度须同时提供 customPointLimit（1～500 的整数）；其他档位不得提供 customPointLimit。')
  sourceRetryRequest({ ...(input.retrySources !== undefined ? { retrySources: input.retrySources } : {}),
    ...(input.reextract === 'gaps' ? { retryGaps: true } : { reextract: input.reextract }), ...(input.legacyLibraryAction ? { legacyLibraryAction: input.legacyLibraryAction } : {}) })
  if (input.action === 'scan') {
    if (input.retrySources) throw new Error('来源定向补缺只适用于本地 Markdown 分层库生成。')
    if (choice.extractionGranularity) throw new Error('扫描不设置颗粒度，请在生成时提供首次选择。')
    return
  }
  // 先核对只读与路径边界；缺少选择时只读策略，不创建库、锁或作业。
  const root = await store.root(input.libraryId, true)
  const view = await store.policy(input.libraryId)
  // 空状态区不表示用户已完成选择：初始化后保存失败时，下次仍须询问。
  const established = view.initialized && (await readCurrent(root)
    || await readOptional<PendingBuild>(await safePath(root, 'work/pending.json'))
    || await readOptional<PendingBuild>(await safePath(root, 'work/preview.json')))
  if (established) {
    if (choice.extractionGranularity && (choice.extractionGranularity !== view.policy.extractionGranularity
      || choice.extractionGranularity === 'custom' && choice.customPointLimit !== granularityTier(view.policy).value))
      throw new Error('该库已初始化，将保留原颗粒度。此参数仅用于首次建库，不能修改已有库档位。')
    return
  }
  if (!choice.extractionGranularity) return selectionRequired(input.libraryId)
  // 显式首次选择才取原建库锁，拒绝另一进程正在生成时改策略；锁内重读以免沿用过期判断。
  if (!locked && store.registration(input.libraryId).kind === 'local')
    return withBuildLock(effectiveSourceRoots(store.registration(input.libraryId))[0]!, () => prepareMcpGeneration(store, input, true))
  const initialized = view.initialized ? view : await store.initialize(input.libraryId)
  await store.savePolicy(input.libraryId, { ...initialized.policy, extractionGranularity: choice.extractionGranularity,
    ...(choice.extractionGranularity === 'custom' ? { customPointLimit: choice.customPointLimit } : {}) }, initialized.revision)
}
