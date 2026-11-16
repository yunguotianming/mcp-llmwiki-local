import { readFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { ChangeStore } from '../src/storage/changes.js'
import { safePath } from '../src/storage/paths.js'
import { buildPolicyKey } from '../src/domain/build-identity.js'
import { temporaryWorkspace } from './temp.js'
import { cleanupLayeredFixtures, mockFixtureSync } from './layered-fixture.js'
import { stagePolicy } from './stage-policy-fixture.js'
vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('buildModels 沿用策略文件、修订冲突及预览失效检查，旧读不改字节', async () => {
  const temp = await temporaryWorkspace(); mockFixtureSync(temp.root)
  try {
    const library = newLibrary('stage'); library.wikiPath = temp.root
    const registry = emptyRegistry(); registry.libraries = [library]
    const store = new LibraryStore(() => registry), old = await store.initialize(library.id), changes = new ChangeStore(store)
    const file = await safePath(temp.root, '.llmwiki/policy.json'), original = await readFile(file)
    expect((await store.policy(library.id)).policy.buildModels).toBeUndefined()
    expect(await readFile(file)).toEqual(original)
    const preview = await changes.prepare(library.id, '阶段策略预览', [{ path: 'index.md', content: '预览内容', expectedBefore: null }])
    const next = await store.savePolicy(library.id, { ...old.policy, buildModels: stagePolicy() }, old.revision)
    expect(JSON.parse(await readFile(file, 'utf8')).buildModels).toEqual(stagePolicy())
    expect(next.revision).not.toBe(old.revision)
    expect(buildPolicyKey(next.policy)).toBe(buildPolicyKey(old.policy))
    await expect(store.savePolicy(library.id, old.policy, old.revision)).rejects.toMatchObject({ httpStatus: 409 })
    await expect(changes.commit(library.id, preview.id, preview.digest)).rejects.toThrow('配置或库版本已变化')
    expect((await store.policy(library.id)).revision).toBe(next.revision)
  } finally { await temp.cleanup() }
})
