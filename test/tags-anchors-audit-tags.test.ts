import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { canonicalTags, normalizeTag } from '../src/layered/tags.js'
import { readLayeredPage } from '../src/layered/index.js'
import { cleanupLayeredFixtures, snapshotManifest } from './layered-fixture.js'
import { built, header } from './tags-anchors-audit-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)
const personalTags = (output: any) => { if (output.tags) output.tags = ['张三', 'alice@example.com', '138-0013-8000', '+86 138 0013 8000', '010 1234 5678'] }
let personalPrompt: string
beforeAll(async () => { const f = await built(false, undefined, personalTags); personalPrompt = f.call.mock.calls[0]![1] })

it('T01 全半角空白井号、非法字符、嵌套标签、词表开关与上限', () => {
  expect(normalizeTag(' ＃Ｃｌｉｎｉｃａｌ　Ｒｅｓｅａｒｃｈ ')).toBe('Clinical-Research')
  const terms = [{ name: '定性研究', aliases: ['qualitative research'] }]
  expect(canonicalTags(['QUALITATIVE RESEARCH', '定性研究', '定性研究方法'], terms)).toEqual(['定性研究', '定性研究方法'])
  const tags = canonicalTags(['123', '１２３', '3D', '研究,方法', '/父//子/', '两个 标签', '##'])
  expect(tags).toEqual(['3D', '研究方法', '父/子', '两个-标签'])
  for (const tag of tags) expect(tag).toMatch(/^[\p{L}\p{M}\p{N}_-]+(?:\/[\p{L}\p{M}\p{N}_-]+)*$/u)
  expect(canonicalTags(['qualitative research', '其他'], terms, ['定性研究'], true, 8)).toEqual(['定性研究'])
  expect(canonicalTags(['qualitative research', '其他'], terms, ['定性研究'], false, 1)).toEqual(['定性研究'])
  expect(canonicalTags(['qualitative research', '其他'], terms, ['定性研究'], false, 8)).toEqual(['定性研究', '其他'])
})

it('T02 模型标签规范化去重后不足三个，保留实际数量、记录不足并继续发布', async () => {
  const f = await built(false, '可核验的研究证据。', output => { if (output.tags) output.tags = ['研究', '#研究', ' 研究 '] })
  expect(f.extraction.tags).toEqual(['研究'])
  expect(f.extraction.tag_status).toEqual({ message: '标签不足', count: 1, minimum: 3, personal_information_removed: 0 })
  const tags = header(await readLayeredPage(f.knowledgeRoot, 'sources/S-0001.md')).tags
  expect(tags).toEqual(['研究'])
  expect((await snapshotManifest(f.root)).sources[0]!.tag_status).toEqual(f.extraction.tag_status)
})

it('T03 邮箱电话丢弃并计数，姓名只由提示词约束', async () => {
  const f = await built(false, undefined, personalTags)
  expect(personalPrompt).toMatch(/禁止姓名.*联系方式.*个人信息/)
  const page = await readLayeredPage(f.knowledgeRoot, 'sources/S-0001.md')
  expect(header(page).tags).toEqual(['张三'])
  expect(page).not.toMatch(/alice|138|1234/)
  expect((await snapshotManifest(f.root)).sources[0]!.tag_status).toMatchObject({ message: '标签不足', count: 1, personal_information_removed: 4 })
})

it('T04 一般标签忽略大小写，已登记大小写冲突术语保留原样', () => {
  const terms = [{ name: 'US', aliases: ['United States'] }, { name: 'us', aliases: ['第一人称复数'] }]
  expect(canonicalTags(['US', 'us', 'Us'], terms)).toEqual(['US', 'us', 'Us'])
  expect(canonicalTags(['United States', '第一人称复数'], terms)).toEqual(['US', 'us'])
  expect(canonicalTags(['Study', 'study', 'STUDY'])).toEqual(['Study'])
})

it('T05 标点删除造成 C++ 与 C 术语误合并', () => {
  expect(canonicalTags(['C++'], [{ name: 'C', aliases: [] }])).not.toContain('C')
})
