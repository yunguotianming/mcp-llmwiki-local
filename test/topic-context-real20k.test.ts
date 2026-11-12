import { readFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { topicEvidenceContext } from '../src/layered/topic-metadata.js'

it('T-0053-01 现场 L227 的 them 保留前句 families，原引文与逐字校验不变', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/real20k/topic-evidence-context.json', import.meta.url), 'utf8'))
  const original = fixture.member.evidence.find((evidence: { locator: string }) => evidence.locator === 'L227-L227')
  const evidence = { ...original, source_version: fixture.source.source_version }
  const context = topicEvidenceContext(evidence, fixture.source)!
  expect(context).toContain('fictional families in both activities')
  expect(context).toContain('them feel welcomed in the fictional activity')
  expect(fixture.source.text).toContain(context)
  expect(evidence.quote).toBe(original.quote)
  expect(context).not.toContain('For fictional participants who held a local')
  expect(() => topicEvidenceContext({ ...evidence, quote: evidence.quote.replace('them', 'patients') }, fixture.source)).toThrow('不逐字匹配')
})
