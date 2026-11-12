import { afterEach, expect, it, vi } from 'vitest'
import { defaultProviderProfile, emptyRegistry, layeredSettings, newLibrary, parseRegistry } from '../src/domain/config.js'
import { routesSchema } from '../src/domain/route-schema.js'
import { modelGate, providerGate } from '../src/llm/scheduler.js'
import { embedInputs } from '../src/layered/embedding.js'
import { cleanupLayeredFixtures, layeredFixture } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('供应商上限接受1000并拒绝1001，默认仍为50', () => {
  expect(defaultProviderProfile.concurrency).toBe(50)
  const library = newLibrary('concurrency-test'), registry = emptyRegistry()
  library.sourceRoots = ['C:\\资料']; library.wikiPath = 'C:\\资料\\.llmwiki'
  registry.libraries = [library]
  library.models.providerProfiles = { mock: { ...defaultProviderProfile, concurrency: 1000 } }
  expect(routesSchema.safeParse(library.models).success).toBe(true)
  expect(() => parseRegistry(registry)).not.toThrow()
  library.models.providerProfiles.mock!.concurrency = 1001
  expect(routesSchema.safeParse(library.models).success).toBe(false)
  expect(() => parseRegistry(registry)).toThrow()
})

it('模型闸门从默认3升到1000后实际开启1000槽位，供应商限制仍生效', async () => {
  const runtime = {}, gate = modelGate(runtime)
  expect(modelGate(runtime, 1000)).toBe(gate)
  let active = 0, peak = 0
  const release = Promise.withResolvers<void>()
  const run = () => gate.run(async () => { peak = Math.max(peak, ++active); await release.promise; active-- })
  const pending = Array.from({ length: 1001 }, run)
  expect(active).toBe(1000); release.resolve(); await Promise.all(pending)
  expect(peak).toBe(1000); expect(active).toBe(0)
  const supplier = providerGate(runtime, 'mock', 1000, { concurrency: 70 }), finish = Promise.withResolvers<void>()
  peak = 0
  const limited = Array.from({ length: 80 }, () => supplier.run(async () => { peak = Math.max(peak, ++active); await finish.promise; active-- }))
  expect(active).toBe(70); finish.resolve(); await Promise.all(limited)
  expect(peak).toBe(70)
})

it('LLM设为1000时嵌入闸门实际峰值仍为50', async () => {
  const f = await layeredFixture(), release = Promise.withResolvers<void>()
  let active = 0, peak = 0
  const client = { identity: async () => '并发回归权重', embed: async (texts: string[]) => {
    peak = Math.max(peak, ++active); await release.promise; active--
    return texts.map(() => [1, 0])
  } }
  const pending = embedInputs(f.root, Array.from({ length: 55 }, (_, index) => `并发要点${index}`), layeredSettings({ embeddingBatchSize: 1 }), client, undefined, 1000)
  try { await vi.waitFor(() => expect(active).toBe(50)) } finally { release.resolve() }
  expect(await pending).toHaveLength(55); expect(peak).toBe(50); expect(active).toBe(0)
})
