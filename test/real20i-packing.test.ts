import { expect, it } from 'vitest'
import { layeredSettings } from '../src/domain/config.js'
import { planExtraction } from '../src/layered/extraction.js'
import { sourceChapters, sourceQuotas } from '../src/layered/longdoc.js'
import { chapterBlockId } from '../src/layered/anchors.js'
import { makeSource } from './speed-fix-audit-fixture.js'

it('同名同内容章节获得不同块 ID，父级引用仍正确', () => {
  const source = makeSource('# 总题\n\n## 方法\n\n同样的内容。\n\n## 方法\n\n同样的内容。')
  const chapters = sourceChapters(source)
  expect(chapters).toHaveLength(3)
  expect(new Set(chapters.map(c => chapterBlockId(c.id))).size).toBe(3)
  expect(chapters.slice(1).map(c => c.parent_id)).toEqual([chapters[0]!.id, chapters[0]!.id])
})

it('精细长文大包按工作预算分包，全部段落字节顺序和篇级配额保留', () => {
  const source = makeSource(Array.from({ length: 16 }, (_, i) => `# 章节${i}\n\n` + `第${i}章研究结果与条件。`.repeat(400)).join('\n\n'))
  const settings = layeredSettings({}, 100), processing = { tier: 100, granularity: 'fine' as const, model: 'mock', prompt_version: '20i' }
  const plan = planExtraction('S-0001', source, processing, 98304, settings)
  expect(plan.length).toBeGreaterThan(4)
  for (const [index, segment] of source.segments.entries()) expect(plan.flat().filter(p => p.paragraph_id === index).map(p => p.text).join('')).toBe(source.text.slice(segment.start, segment.end))
  expect(plan.flat().map(p => p.paragraph_id)).toEqual([...plan.flat().map(p => p.paragraph_id)].sort((a, b) => a - b))
  const quota = sourceQuotas(source, plan, 100, settings)
  expect(quota.quotas.reduce((a, b) => a + b, 0)).toBe(quota.limit)
  expect(quota.limit).toBe(300)
})
