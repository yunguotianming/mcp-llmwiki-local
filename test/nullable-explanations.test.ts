import { afterEach, expect, it, vi } from 'vitest'
import { outputSchema, wireOutput, renderSource, reusableExtraction } from '../src/layered/extraction.js'
import { parseModelJson } from '../src/llm/json.js'
import { runtimeSchemaRegistry, schemaJSON, strictSchema } from '../src/llm/protocol.js'
import { checkedVerdicts, reviewOutput } from '../src/layered/review.js'
import { topicCorrectionOutput } from '../src/layered/topic-review.js'
import { extractionFixture, output } from './quality-fix2-audit-fixture.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
const term = { paragraph_id: 0, name: '方法', category: '概念', aliases: [], locator: 'L1-L1', note: null }
const value = (reason: unknown) => ({ tags: ['方法'], credibility: 'unknown', credibility_reason: reason, points: [], terms: [{ ...term, note: reason }] })

it('说明字段的 null、空串、空白与正常值分别归一，必填键不能缺失', () => {
  for (const [input, expected] of [[null, null], ['', null], [' \t\n ', null], ['  原文说明  ', '原文说明']]) {
    const parsed = outputSchema.parse(parseModelJson(JSON.stringify(value(input)), schemaJSON(wireOutput)))
    expect(parsed.credibility_reason).toBe(expected); expect(parsed.terms[0]!.note).toBe(expected)
    expect(reviewOutput.parse({ items: [{ id: 'P', support: '完整支撑', missing: input }] }).items[0]!.missing).toBe(expected)
    expect(topicCorrectionOutput.parse({ sentences: [{ id: 'S', text: '', point_ids: [], support: '不支撑', missing: input }] }).sentences[0]!.missing).toBe(expected)
  }
  const missing = value(null); delete (missing as any).credibility_reason
  expect(outputSchema.safeParse(missing).success).toBe(false)
})

it('运行时严格版保留 required 和 null，完整版仍有非空字符串约束', () => {
  const full = schemaJSON(wireOutput) as any, strict = strictSchema(full)
  expect(strict.required).toContain('credibility_reason')
  expect(strict.properties.credibility_reason.anyOf).toContainEqual({ type: 'null' })
  expect(full.properties.credibility_reason.anyOf).toContainEqual({ type: 'string', minLength: 1 })
  expect(strict.properties.terms.items.required).toContain('note')
  const entry = runtimeSchemaRegistry().find(item => item.names.includes('layered_extraction'))!
  expect(entry.validate!(value(null))).toBe(true)
  const parsed = parseModelJson(JSON.stringify({ ...value(null), terms: [{ ...term, referent: null }] }) + '}', full)
  expect(parsed.credibility_reason).toBeNull(); expect(parsed.terms[0]).not.toHaveProperty('referent')
})

it('主张、引文、证据 ID 与术语名称空值仍被拒绝，支撑不足必须说明缺失', () => {
  for (const empty of [null, '', ' \t ']) {
    expect(outputSchema.shape.points.element.shape.text.safeParse(empty).success).toBe(false)
    expect(outputSchema.shape.points.element.shape.evidence.element.shape.quote.safeParse(empty).success).toBe(false)
    expect(outputSchema.shape.terms.element.shape.name.safeParse(empty).success).toBe(false)
  }
  for (const empty of [null, '']) expect(wireOutput.shape.points.element.safeParse({ paragraph_id: 0, text: '主张', section: '主要发现', evidence: [{ evidence_ref: empty }] }).success).toBe(false)
  expect(() => checkedVerdicts(JSON.stringify({ items: [{ id: 'P', support: '不支撑', missing: null }] }), ['P'])).toThrow('必须一致')
  expect(checkedVerdicts(JSON.stringify({ items: [{ id: 'P', support: '完整支撑', missing: null }] }), ['P'])[0]!.missing).toBe('')
})

it('实际提取、缓存和来源页保留缺依据状态，四种说明值不生成空说明行', async () => {
  for (const reason of [null, '', ' \t ', '原文说明']) {
    const f = await extractionFixture('方法是原文术语。', { extractionReview: 'off' })
    f.call.mockImplementation(async (_task, system, raw) => {
      expect(system).toContain('无依据时填 null，不要编造')
      return JSON.stringify({ ...output(JSON.parse(raw)), credibility_reason: reason, terms: [{ ...term, note: reason }] })
    })
    const result = await f.run()
    expect(result.metadata.credibility_reason).toBe(reason === '原文说明' ? reason : '未提供依据')
    expect(result.segments[0]!.terms[0]!.note).toBe(reason === '原文说明' ? reason : null)
    expect(reusableExtraction(result)).toBe(true)
    const page = renderSource({ source_id: 'S-0001', source_version: 'v1', current_path: 'a.md', files: { assets: [] }, metadata: result.metadata } as any, result)
    expect(page).toContain('可信度依据：' + (reason === '原文说明' ? reason : '未提供依据'))
    expect(page).not.toMatch(/：\s*[。\n]|：null|：undefined/)
  }
})
