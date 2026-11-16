// 通用历史复算：沿用调用方冻结的评分模块；每批最多五条，只读输入，结果输出到标准输出。
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'

const [root, questionsFile, scorerFile] = process.argv.slice(2)
if (!root || !questionsFile || !scorerFile) throw new Error('用法：node test/query-quality-history.mjs <单库评测目录> <v2题集.jsonl> <冻结评分模块.mjs>')
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const hash = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const { scoreRecord, aggregate } = await import(pathToFileURL(path.resolve(scorerFile)).href)
const questions = fs.readFileSync(questionsFile, 'utf8').trim().split(/\r?\n/).map(JSON.parse)
const summary = read(path.join(root, 'summary.json')), identities = read(path.join(root, 'raw/page-identities.json'))
const coverage = read(path.join(root, 'raw/coverage-scored-rows.json')), rows = {}, output = {}
for (const mode of ['A', 'B']) {
  const files = fs.readdirSync(path.join(root, 'raw')).filter(name => new RegExp(`^questions-180-${mode}-\\d{3}\\.json$`).test(name)).sort()
  const records = files.flatMap(name => {
    const batch = read(path.join(root, 'raw', name))
    if (batch.results.length > 5) throw new Error('历史批次超过五条。')
    return batch.results
  })
  if (records.length !== questions.length || new Set(records.map(r => r.id)).size !== questions.length) throw new Error('历史题集不完整或重复。')
  rows[mode] = []
  for (let offset = 0; offset < records.length; offset += 5) for (const record of records.slice(offset, offset + 5)) {
    const q = questions.find(q => q.id === record.id)
    if (!q || q.query !== record.query || record.mode !== mode) throw new Error('历史题号、题干或模式不一致。')
    rows[mode].push(scoreRecord(q, record, identities))
  }
  const metrics = aggregate(rows[mode]), expected = summary.questions180[mode]
  if (metrics.complete !== expected.complete || metrics.sourceRecall10 !== expected.sourceRecall10) throw new Error('冻结评分复算与历史成绩不一致。')
  const reviewed = coverage[mode]
  if (reviewed.length !== 40 || new Set(reviewed.map(r => r.id)).size !== 40 || reviewed.some(r => !r.review?.reviewed)) throw new Error('覆盖题历史人工标注不完整。')
  const coverageHits = reviewed.filter(r => r.review.hit).length
  if (coverageHits !== summary.coverage40[mode].evidenceHitCount) throw new Error('覆盖题计数与历史成绩不一致。')
  output[mode] = { retrieval: metrics, coverageHits,
    bySplit: Object.fromEntries([...new Set(questions.map(q => q.split))].map(split => [split, aggregate(rows[mode].filter(r => r.split === split))])),
    answerUnsupported: null, refusalRate: null, answerStatus: '待真实运行：历史记录只有检索响应，没有最终回答或拒答标注' }
}
console.log(JSON.stringify({ scope: '历史固定记录复算，不是新查询或新回答成绩',
  hashes: { questions: hash(questionsFile), scorer: hash(scorerFile), summary: hash(path.join(root, 'summary.json')), coverage: hash(path.join(root, 'raw/coverage-scored-rows.json')) },
  output, rows }, null, 2))
