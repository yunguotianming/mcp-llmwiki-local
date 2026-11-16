import { expect, it, vi } from 'vitest'
import { askWiki } from '../src/wiki/chat.js'
import { fixture } from './query-pages-audit-fixture.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))

async function answerWith(output: string, layered = true) {
  const f = await fixture(layered), library = layered ? f.library : await f.addLegacy()
  library.models.unified = { provider: 'fake', model: 'fake' }
  f.runtime.resolveModelInfo.mockResolvedValue({ provider: 'fake', id: 'fake', name: 'fake', context: { contextWindow: 32768 } } as never)
  f.runtime.stream.mockImplementation(async function* () {
    yield { type: 'text-delta', text: output }
    yield { type: 'finish', reason: { kind: 'stop' } }
  })
  try {
    const result = await askWiki(f.store, library.id, '公开证据', [], f.runtime)
    return { result, calls: f.runtime.stream.mock.calls.length }
  } finally { vi.restoreAllMocks(); cleanupLayeredFixtures(); f.cleanup() }
}

it.each([true, false])('分层=%s：空引用拒答正常返回固定提示，零结构重试', async layered => {
  const { result, calls } = await answerWith('{"units":[],"gap":true}', layered)
  expect(result.answer).toBe('本次提供的证据不足，无法可靠回答这个问题。')
  expect(result.citations).toEqual([])
  expect(calls).toBe(1)
})

it('旧协议的任意无引用正文被拒绝，不作为回答返回', async () => {
  await expect(answerWith('{"answer":"每天服用虚构药物九十九片一定安全。","citations":[]}')).rejects.toMatchObject({ name: 'ModelOutputValidationError' })
})

it('有引用的部分回答保留事实及局部缺口，不转成整题拒答', async () => {
  const { result, calls } = await answerWith('{"units":[{"block":"paragraph","text":"当前资料包含公开证据。","citationIds":[1]}],"gap":true}')
  expect(result.answer).toBe('当前资料包含公开证据。 [1]\n\n其余问题本次提供的证据不足，无法确认。')
  expect(result.citations).toHaveLength(1)
  expect(calls).toBe(1)
})

it('事实单元的引用数组为空时仍有界拒绝', async () => {
  await expect(answerWith('{"units":[{"block":"paragraph","text":"公开证据。","citationIds":[]}]}')).rejects.toMatchObject({ name: 'ModelOutputValidationError' })
})
