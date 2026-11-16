import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// 离线语义结论来自逐句人工标注；摘要锁定正文，未知回答不能按零未支撑句计分。
export interface QualityQuestion { id: string; split: string; facts: string[]; sources: string[]; coverage: boolean }
export interface AnswerRecord { id: string; answer: string | null; refused: boolean | null; retrievedSources: string[] }
export interface SentenceReview { text: string; supported: boolean; facts: string[]; sources: string[]; basis: string }
export interface AnswerReview { id: string; answerHash: string; sentences: SentenceReview[] }
export const answerHash = (text: string) => createHash('sha256').update(text).digest('hex')

export function scoreAnswers(questions: QualityQuestion[], records: AnswerRecord[], reviews: AnswerReview[]) {
  if (!questions.length || new Set(questions.map(q => q.id)).size !== questions.length) throw new Error('题集为空或题号重复。')
  if (records.length !== questions.length || new Set(records.map(r => r.id)).size !== questions.length
    || records.some(r => !questions.some(q => q.id === r.id))) throw new Error('回答记录必须完整覆盖同一题集，不能漏题或重复。')
  if (new Set(reviews.map(r => r.id + ':' + r.answerHash)).size !== reviews.length) throw new Error('逐句标注重复。')
  const rows = questions.map(q => {
    const record = records.find(r => r.id === q.id)!
    const review = record.answer === null ? undefined : reviews.find(r => r.id === q.id && r.answerHash === answerHash(record.answer!))
    if (review && (!review.sentences.length || review.sentences.map(s => s.text).join('\n') !== record.answer
      || review.sentences.some(s => !s.text.trim() || !s.basis.trim() || s.facts.some(f => !q.facts.includes(f))
        || s.supported && s.facts.length > 0 && !s.sources.length))) throw new Error('逐句标注必须覆盖完整正文，并为事实提供依据与来源。')
    if (record.answer !== null && !record.answer.trim() || record.answer === null && record.refused !== null
      || record.answer !== null && record.refused === null) throw new Error('缺失回答不能冒充拒答，空正文不能冒充回答。')
    const supported = review?.sentences.filter(s => s.supported) ?? []
    const facts = new Set(supported.flatMap(s => s.facts))
    if (record.refused && facts.size) throw new Error('整题拒答与有据事实回答不可同时标记。')
    return { id: q.id, split: q.split, coverage: q.coverage, answerable: q.facts.length > 0,
      unsupported: review ? review.sentences.filter(s => !s.supported).length : null,
      complete: review ? q.facts.every(f => facts.has(f)) : null,
      // 覆盖事实须在同一标注单元中成立，不用相邻单元的引用拼出完整命中。
      coverageHit: review ? supported.some(s => q.facts.every(f => s.facts.includes(f))) : null,
      sourceRecall: q.sources.length ? q.sources.filter(s => record.retrievedSources.includes(s)).length / q.sources.length : null,
      refused: record.refused }
  })
  const aggregate = (items: typeof rows) => {
    const answerable = items.filter(r => r.answerable), coverage = items.filter(r => r.coverage)
    const reviewed = items.every(r => r.unsupported !== null), answered = items.every(r => r.refused !== null)
    const recalls = items.map(r => r.sourceRecall).filter((r): r is number => r !== null)
    return { total: items.length, reviewed: items.filter(r => r.unsupported !== null).length,
      unsupported: reviewed ? items.reduce((sum, r) => sum + r.unsupported!, 0) : null,
      complete: reviewed ? answerable.filter(r => r.complete).length : null,
      sourceRecall: recalls.length ? recalls.reduce((a, b) => a + b, 0) / recalls.length : null,
      coverageHits: reviewed ? coverage.filter(r => r.coverageHit).length : null,
      refusalRate: answered && items.length ? items.filter(r => r.refused).length / items.length : null }
  }
  return { questionSet: answerHash(JSON.stringify(questions)), rows, overall: aggregate(rows),
    bySplit: Object.fromEntries([...new Set(questions.map(q => q.split))].map(split => [split, aggregate(rows.filter(r => r.split === split))])) }
}

export function compareAnswers(before: ReturnType<typeof scoreAnswers>, after: ReturnType<typeof scoreAnswers>) {
  if (before.questionSet !== after.questionSet) throw new Error('比较必须使用同一题集、划分、事实和来源。')
  const failures: string[] = []
  for (const [split, baseline, candidate] of [['全部', before.overall, after.overall],
    ...Object.keys(before.bySplit).map(split => [split, before.bySplit[split]!, after.bySplit[split]!] as const)] as const) {
    if (candidate.unsupported === null || candidate.refusalRate === null || baseline.refusalRate === null || baseline.complete === null) {
      failures.push(`${split}：最终回答或逐句标注缺失，待真实运行`); continue
    }
    if (candidate.unsupported !== 0) failures.push(`${split}：未支撑句不为零`)
    for (const metric of ['complete', 'sourceRecall', 'coverageHits'] as const) {
      const a = baseline[metric], b = candidate[metric]
      if (a !== null && (b === null || b < a)) failures.push(`${split}：${metric} 下降`)
    }
    if (candidate.refusalRate > baseline.refusalRate) failures.push(`${split}：拒答率上升`)
  }
  return { passed: !failures.length, failures,
    changes: before.rows.map(row => ({ id: row.id, before: row, after: after.rows.find(r => r.id === row.id)! })) }
}

// 通用离线入口：只读取调用方指定的固定记录，结果输出到标准输出，不访问库或模型。
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  if (!process.argv[2]) throw new Error('用法：node --experimental-strip-types test/query-quality-replay.ts <记录.json>')
  const input = JSON.parse(readFileSync(process.argv[2], 'utf8')) as {
    questions: QualityQuestion[]; before: AnswerRecord[]; after: AnswerRecord[]; beforeReviews: AnswerReview[]; afterReviews: AnswerReview[]
  }
  const before = scoreAnswers(input.questions, input.before, input.beforeReviews)
  const after = scoreAnswers(input.questions, input.after, input.afterReviews)
  const comparison = compareAnswers(before, after)
  console.log(JSON.stringify({ before, after, comparison }, null, 2))
  process.exitCode = comparison.passed ? 0 : 1
}
