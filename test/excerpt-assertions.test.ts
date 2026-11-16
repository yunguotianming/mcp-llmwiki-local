import { expect, it } from 'vitest'
import { expectExcerptInPage } from './excerpt-assertions.js'

const a = 'S-0001@sha256:abc#L7-L7', b = 'S-0001@sha256:abc#L13-L13'
const page = `- 登记需要原件和签字。 [证据](#^pa)\n\n## 证据原文\n\n- [${a}] 登记需要原件。 ^pa\n- [${b}] 还需要签字。 ^pb`
const link = (citation: string, anchor: string) => `[${citation}](../sources/S-0001.md#^${anchor})`

it('单引用与复合要点的完整多引用均核对真实锚点', () => {
  expectExcerptInPage(page, '- 登记需要原件和签字。 ' + link(a, 'pa'))
  expectExcerptInPage(page, '- 登记需要原件和签字。 ' + link(a, 'pa') + '；' + link(b, 'pb'))
})

it('多引用中任一版本或定位不符都拒绝', () => {
  expect(() => expectExcerptInPage(page, '- 登记需要原件和签字。 ' + link(a, 'pa') + '；' + link(b.replace('L13', 'L99'), 'pb'))).toThrow()
})

it('正文必须连续存在，不能借正确锚点拼接原页没有的句子', () => {
  expect(() => expectExcerptInPage(page, '- 登记需要签字。 ' + link(a, 'pa') + '；' + link(b, 'pb'))).toThrow()
})
