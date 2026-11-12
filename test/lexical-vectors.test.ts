import { afterEach, expect, it, vi } from 'vitest'
import { lexicalCorpus, lexicalDimensions, lexicalTerms, persistLexicalVectors } from '../src/layered/lexical-vectors.js'
import { similarity } from '../src/layered/embedding.js'
import { encodeVector, hydrateVectors, readVectorRecord } from '../src/layered/vectors.js'
import { clusterPoints } from '../src/layered/clustering.js'
import { mapConcurrent } from '../src/llm/scheduler.js'
import { defaultLayeredSettings, emptyRegistry, layeredSettings } from '../src/domain/config.js'
import { exportConfig, importConfig } from '../src/domain/config-io.js'
import { cleanupLayeredFixtures, layeredFixture } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('规范化全角大小写，中文只取连续二字组，英文去停用词且不跨标点拼接', () => {
  expect(lexicalTerms('ＡＩ and THE 临床研究，护士。Ｃａｒｅ with Data!')).toEqual(['ai', '临床', '床研', '研究', '护士', 'care', 'data'])
  expect(lexicalTerms('甲；乙 the AND')).toEqual([])
  const corpus = lexicalCorpus([{ point_id: 'S-1:a', text: '甲；乙 the AND' }])
  expect(Math.hypot(...corpus.vectors['S-1:a']!.vector)).toBeCloseTo(1, 12)
})

it('同输入、乱序及30/3/1路完成的词项字节与主题成员完全一致', async () => {
  const points = Array.from({ length: 30 }, (_, i) => ({ point_id: `S-${String(i).padStart(2, '0')}:p`, text: i % 2 ? 'database transaction recovery logging' : '护理临床研究随机分组' }))
  const expected = lexicalCorpus(points), bytes = (corpus: ReturnType<typeof lexicalCorpus>) => Object.entries(corpus.vectors).map(([id, value]) => [id, encodeVector(value.vector, 'float32').toString('hex')])
  const settings = layeredSettings({ topicSimilarityThreshold: .11 }), groups = clusterPoints(Object.keys(expected.vectors), expected.vectors, settings).groups
  expect(groups).toHaveLength(2)
  for (const concurrency of [30, 3, 1]) {
    const completed: typeof points = []
    await mapConcurrent([...points].reverse(), concurrency, new AbortController().signal, async point => {
      for (let delay = 0; delay < Number(point.point_id.slice(2, 4)) % 3; delay++) await Promise.resolve()
      completed.push(point)
    })
    const current = lexicalCorpus(completed)
    expect(current.identity).toEqual(expected.identity)
    expect(bytes(current)).toEqual(bytes(expected))
    expect(clusterPoints(Object.keys(current.vectors).reverse(), current.vectors, settings).groups).toEqual(groups)
  }
})

it('labels和keywords分别加权，全库IDF与补标变化使身份和输入缓存失效', () => {
  const points = [{ point_id: 'S-1:a', text: 'alpha beta' }, { point_id: 'S-2:a', text: 'alpha' }, { point_id: 'S-3:a', text: 'beta' }]
  const plain = lexicalCorpus(points), labeled = lexicalCorpus(points, { 'S-1:a': { labels: ['alpha'], keywords: [] } }), keyed = lexicalCorpus(points, { 'S-1:a': { labels: [], keywords: ['alpha'] } })
  const score = (corpus: typeof plain) => similarity(corpus.vectors['S-1:a']!.vector, corpus.vectors['S-2:a']!.vector)
  expect(score(labeled)).toBeGreaterThan(score(keyed)); expect(score(keyed)).toBeGreaterThan(score(plain))
  expect(labeled.vectors['S-1:a']!.input_hash).not.toBe(plain.vectors['S-1:a']!.input_hash)
  expect(labeled.identity.revision).not.toBe(plain.identity.revision)
  // 补标仅大小写、全角或返回顺序变化时，身份及对象输入哈希都保持一致。
  expect(lexicalCorpus(points, { 'S-1:a': { labels: ['ＡＬＰＨＡ'], keywords: [] } })).toEqual(labeled)
  const expanded = lexicalCorpus([...points, { point_id: 'S-4:a', text: 'alpha' }])
  expect(expanded.identity.revision).not.toBe(plain.identity.revision)
  expect(expanded.vectors['S-1:a']!.vector).not.toEqual(plain.vectors['S-1:a']!.vector)
})

it('相同正文的不同补标不共用对象，持久化及恢复向量逐字节相同', async () => {
  const f = await layeredFixture(), corpus = lexicalCorpus([{ point_id: 'S-1:a', text: '研究方法' }, { point_id: 'S-2:a', text: '研究方法' }], {
    'S-1:a': { labels: ['随机分组'], keywords: ['盲法'] }, 'S-2:a': { labels: ['质性访谈'], keywords: ['编码'] },
  })
  const vectors = await persistLexicalVectors(f.root, corpus)
  expect(vectors['S-1:a']!.vector_id).not.toBe(vectors['S-2:a']!.vector_id)
  const restored = await hydrateVectors(f.root, structuredClone(vectors))
  expect(restored).toEqual(vectors)
  for (const value of Object.values(vectors)) {
    const record = await readVectorRecord(f.root, value.vector_id!)
    expect(record.identity.provider).toBe('lexical'); expect(record.vector).toHaveLength(lexicalDimensions)
    expect(Math.hypot(...value.vector)).toBeCloseTo(1, 12)
  }
})

it('词项阈值独立校验并可导入导出，语义默认值保持不变', async () => {
  const f = await layeredFixture(), registry = emptyRegistry()
  f.library.wikiPath = f.root
  f.library.layered = { lexicalTopicSimilarityThreshold: .13, lexicalTopicAttachThreshold: .24 }
  registry.libraries = [f.library]
  expect(importConfig(exportConfig(registry), emptyRegistry(), 'replace').libraries[0]!.layered).toEqual(f.library.layered)
  expect([defaultLayeredSettings.topicSimilarityThreshold, defaultLayeredSettings.topicAttachThreshold]).toEqual([.65, .60])
  expect([defaultLayeredSettings.lexicalTopicSimilarityThreshold, defaultLayeredSettings.lexicalTopicAttachThreshold]).toEqual([.11, .22])
  expect(() => layeredSettings({ lexicalTopicSimilarityThreshold: -1 })).toThrow('词项主题阈值')
  expect(() => layeredSettings({ lexicalTopicAttachThreshold: NaN })).toThrow('词项主题阈值')
})
