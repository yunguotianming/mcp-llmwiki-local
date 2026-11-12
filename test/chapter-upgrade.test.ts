import { expect, it } from 'vitest'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { extractSource, publishedExtractionUnchanged } from '../src/layered/extraction.js'
import { hash } from '../src/layered/files.js'
import { readLocalSource } from '../src/layered/snapshot.js'
import type { BuildLayeredOptions } from '../src/layered/schema.js'

it('升级：旧提示词哈希不触发重提，原文或用户设置变化仍需处理', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'b4-upgrade-')), file = path.join(root, 'source.md')
  await mkdir(path.join(root, '.llmwiki'))
  await writeFile(file, '# 方法\n\n完整原文事实。', 'utf8')
  const source = await readLocalSource(file, '测试'), processing = { tier: 50, prompt_version: 'v1' }
  const options: BuildLayeredOptions = { knowledgeRoot: root, topics: false, client: {
    info: async () => ({ provider: 'mock', id: 'mock', name: '假模型' }), call: async () => JSON.stringify({
      tags: ['方法', '研究', '样本'], credibility: 'unknown', credibility_reason: null, points: [], terms: [],
    }),
  } }
  const previous = await extractSource(root, 'S-0001', source, processing, options, 98304)
  previous.processing.prompt_hash = '旧提示词哈希'
  expect(publishedExtractionUnchanged(previous, 'S-0001', source, processing, options)).toBe(true)
  expect(publishedExtractionUnchanged(previous, 'S-0001', { ...source, contentHash: hash('变化') }, processing, options)).toBe(false)
  expect(publishedExtractionUnchanged(previous, 'S-0001', source, { ...processing, tier: 100 }, options)).toBe(false)
  expect(publishedExtractionUnchanged(previous, 'S-0001', source, processing, { ...options, topics: { sourceChapterMinPoints: 2 } })).toBe(false)
  expect(publishedExtractionUnchanged({ ...previous, in_progress: true }, 'S-0001', source, processing, options)).toBe(false)
})
