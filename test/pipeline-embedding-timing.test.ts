import { setImmediate } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { layeredSettings } from '../src/domain/config.js'
import { embedInputs } from '../src/layered/embedding.js'
import { costReport, meteredOptions } from '../src/layered/costs.js'
import type { PendingBuild } from '../src/layered/schema.js'
import { cleanupLayeredFixtures, layeredFixture } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => { vi.useRealTimers(); cleanupLayeredFixtures() })

it('预嵌入共享闸门的等待单独计入排队，执行时间不包含等待', async () => {
  const f = await layeredFixture(), pending = { started_at: new Date().toISOString(), costs: costReport() } as PendingBuild
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(0)
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>()
  const measured = meteredOptions(f.root, pending, { ...f.options, embeddingClient: {
    identity: async () => '计时模型', embed: async texts => {
      if (texts[0] === '第一条') { entered.resolve(); await release.promise }
      else vi.setSystemTime(30)
      return texts.map(() => [1, 0])
    },
  } })
  const settings = layeredSettings()
  const first = embedInputs(f.root, ['第一条'], settings, measured.embeddingClient!, undefined, 1)
  await entered.promise
  const second = embedInputs(f.root, ['第二条'], settings, measured.embeddingClient!, undefined, 1)
  await setImmediate()
  vi.setSystemTime(20); release.resolve()
  await Promise.all([first, second])
  expect(pending.costs!.stages['嵌入']).toMatchObject({ actual_calls: 2, queue_ms: 20, execution_ms: 30, duration_ms: 50 })
})
