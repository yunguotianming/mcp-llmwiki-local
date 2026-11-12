import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ordinaryPointLimit, packPointLimit } from '../src/domain/granularity.js'
import { layeredSettings } from '../src/domain/config.js'
import { packVocabulary, planExtraction } from '../src/layered/extraction.js'
import { sourceQuotas } from '../src/layered/longdoc.js'
import { readLocalSource } from '../src/layered/snapshot.js'
import { cleanupLayeredFixtures, layeredFixture } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
const fine = { tier: 100 as const, granularity: 'fine' as const, prompt_version: '审查', model: 'mock/extractor' }

async function longPaper() {
  const f = await layeredFixture(), file = path.join(f.knowledgeRoot, 'paper.md')
  // 约 3.6 万字、整篇不超输入上限的普通论文（不是书籍路径）：扩额后篇级上限 200，单包仍按档位上限 100 分配。
  const section = (title: string) => '## ' + title + '\n\n' + Array.from({ length: 30 }, (_, index) => title + ' paragraph ' + index + ': Clinical Research Nurse coordinated the study. ' + 'word '.repeat(50)).join('\n\n')
  await writeFile(file, '# 论文\n\n' + ['背景', '方法', '结果', '讨论'].map(section).join('\n\n'))
  return { ...f, source: await readLocalSource(file, '审查资料') }
}

it('术语词表只带本包正文出现的名称或别名，标签全带，空术语原样返回', () => {
  const parts = [{ paragraph_id: 0, locator: 'L1-L1', text_hash: 'h', text: 'The ＣＲＮ coordinated the trial with Registered Nurses.' }]
  const vocabulary = { tags: ['临床研究护士', '定性研究'], terms: [
    { name: 'Clinical Research Nurse', aliases: ['CRN'] },
    { name: 'Registered Nurses (RNs)', aliases: ['registered nurses'] },
    { name: 'continuous professional development', aliases: ['CPD'] },
  ] }
  const filtered = packVocabulary(parts, vocabulary)
  // 全角 ＣＲＮ 经 NFKC 归一后命中别名；大小写不敏感；未出现的 CPD 不进输入。
  expect(filtered.terms.map(term => term.name)).toEqual(['Clinical Research Nurse', 'Registered Nurses (RNs)'])
  expect(filtered.tags).toEqual(vocabulary.tags)
  const empty = { tags: ['甲'], terms: [] }
  expect(packVocabulary(parts, empty)).toBe(empty)
})

it('整库大词表不再压缩每包正文：切包结果与无词表一致', async () => {
  const f = await longPaper(), settings = layeredSettings({}, 100)
  const vocabulary = { tags: [], terms: Array.from({ length: 400 }, (_, index) => ({ name: 'unrelated term number ' + index, aliases: ['UT' + index + 'X'] })) }
  const bare = planExtraction('S-0001', f.source, fine, 98304, settings)
  const loaded = planExtraction('S-0001', f.source, fine, 98304, settings, vocabulary)
  expect(loaded.map(parts => parts.map(part => part.paragraph_id))).toEqual(bare.map(parts => parts.map(part => part.paragraph_id)))
})

it('篇幅扩额只放宽篇级截断：单包配额之和仍是扩额前上限，分包不随扩额增加', async () => {
  const f = await longPaper(), settings = layeredSettings({}, 100)
  const chars = Array.from(f.source.text).length
  expect(ordinaryPointLimit(chars, 100, 'fine', settings)).toBeGreaterThan(100)
  expect(packPointLimit(chars, 100, 'fine')).toBe(100)
  const plan = planExtraction('S-0001', f.source, fine, 98304, settings)
  const quotas = sourceQuotas(f.source, plan, 100, settings, packPointLimit(chars, 100, 'fine')).quotas
  expect(quotas.reduce((sum, quota) => sum + quota, 0)).toBe(100)
  // 扩额前规则下的包数：同一输入用未扩额倍数（1）切包应得到同样结果。
  const unexpanded = planExtraction('S-0001', f.source, fine, 98304, layeredSettings({ sourcePointMaxMultiplier: 1 }, 100))
  expect(plan.length).toBe(unexpanded.length)
})
