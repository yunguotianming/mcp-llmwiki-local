import { vi } from 'vitest'
import { emptyRegistry, newLibrary } from '../src/domain/config.js'
import type { LibraryRegistration, Registry } from '../src/domain/config.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { LibraryDiscovery, registryRevision } from '../src/wiki/library-discovery.js'
import type { LibraryMetadata } from '../src/wiki/library-discovery.js'
import { LibraryManagement } from '../src/wiki/library-management.js'
import { LibrarySummaries } from '../src/wiki/library-summaries.js'
export function discoveryFixture(size = 10) {
  let registry: Registry = { ...emptyRegistry(), discovery: { pinnedLimit: 3 }, libraries: Array.from({ length: size }, (_, i) => ({ ...newLibrary('library-' + i),
    name: i === size - 1 ? '护士库' : '资料库' + i, wikiPath: `C:/库${i}`, sourceRoots: [`C:/资料${i}`], description: i === size - 1 ? '护理研究和临床实践' : '', pinned: i < 6, order: i,
    ...(i < 6 ? { summary: { short: { text: '基础资料'.repeat(20), origin: 'manual' as const, locked: true, sourceVersion: null } } } : {}) })) }
  const store = new LibraryStore(() => registry), hidden = new Set<string>(), offline = new Set<string>()
  const metadata = new Map<string, LibraryMetadata>(registry.libraries.map(library => [library.id, {
    publishedVersion: 'v000001', generation: 0, topTopics: library.name === '护士库' ? ['静脉输液护理'] : ['其他领域'], titleSamples: ['样本标题'], byType: { sources: 1 }, sourceRefs: [],
  }]))
  const discovery = new LibraryDiscovery({ snapshot: () => store.snapshot(), visible: library => !hidden.has(library.id), metadata: async library => {
    if (offline.has(library.id)) throw Object.assign(new Error('离线'), { code: 'ENOENT' })
    return structuredClone(metadata.get(library.id)!)
  } })
  const write = vi.fn(async (next: Registry, expected: Registry) => {
    if (registryRevision(registry) !== registryRevision(expected)) throw Object.assign(new Error('冲突'), { httpStatus: 409 })
    registry = structuredClone(next)
  })
  const management = new LibraryManagement(store, { write, prepare: async input => ({ ...newLibrary('registered'), ...input as LibraryRegistration }), busy: id => id === 'busy' })
  const summaries = new LibrarySummaries(management, discovery, async () => { throw new Error('不得调用模型') })
  return { store, discovery, management, services: { discovery, management, summaries }, write, metadata, hidden, offline,
    mutate: (action: (registry: Registry) => void) => action(registry) }
}
