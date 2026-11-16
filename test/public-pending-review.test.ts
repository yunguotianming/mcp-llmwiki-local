import { expect, it } from 'vitest'
import { publicResult } from '../src/host/public-results.js'
import { pendingTopicReview } from './answer-evidence-fixture.js'

it.each(['wiki_search', 'wiki_read', 'wiki_answer'])('%s公开结果保留待核实控制字段，句子与原因仍脱敏', operation => {
  const pendingReview = pendingTopicReview()
  pendingReview.sentences[0]!.text = '历史主题unverified主张。'
  pendingReview.sentences[0]!.missing = 'semantic-rejection理由。'
  const page = { path: pendingReview.pagePath, type: 'topic', title: '旧页', status: 'ok', content: '旧正文保持。', currentVersion: 'v000001',
    version: 'v000001', sources: [], sourceVersions: [], excerpts: [], snippet: '', snippetSegments: [], pendingReview }
  const input = operation === 'wiki_search' ? { results: [page], groups: [{ results: [page] }], understanding: { status: 'disabled' } }
    : operation === 'wiki_answer' ? { citations: [{ ...page, excerpt: page.content }], createdAt: '' } : page
  const safe = publicResult(input, ['unverified', 'semantic-rejection', 'v000001', '原运行', 'S1'], operation) as any
  const actual = operation === 'wiki_search' ? safe.results[0].pendingReview : operation === 'wiki_answer' ? safe.citations[0].pendingReview : safe.pendingReview
  expect(actual).toMatchObject({ ...pendingReview, sentences: [{ id: 'S1', support: '不支撑', text: '历史主题[已脱敏]主张。', missing: '[已脱敏]理由。' }] })
  if (operation === 'wiki_search') expect(safe.groups[0].results[0].pendingReview).toEqual(actual)
})
