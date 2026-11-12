import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { layeredSettings, newLibrary } from '../src/domain/config.js'
import { createEmbeddingClient } from '../src/layered/cloud-embedding.js'
import { embeddingReadiness, EmbeddingReadiness } from '../src/layered/embedding-readiness.js'
import { libraryVectorState } from '../src/layered/vector-identity.js'
import { findLayeredLibrary } from '../src/wiki/query.js'
import type { EmbeddingClient, LibraryVectorState } from '../src/layered/schema.js'

vi.mock('../src/layered/cloud-embedding.js', async original => ({ ...await original<typeof import('../src/layered/cloud-embedding.js')>(), createEmbeddingClient: vi.fn() }))
vi.mock('../src/wiki/query.js', async original => ({ ...await original<typeof import('../src/wiki/query.js')>(), findLayeredLibrary: vi.fn() }))
vi.mock('../src/layered/objects.js', async original => ({ ...await original<typeof import('../src/layered/objects.js')>(), readCurrent: vi.fn(async () => ({})), readManifest: vi.fn(async () => ({})) }))
vi.mock('../src/layered/vector-identity.js', async original => ({ ...await original<typeof import('../src/layered/vector-identity.js')>(), libraryVectorState: vi.fn() }))

const settings = layeredSettings({ embeddingMode: 'ollama' })
const vector: LibraryVectorState = { mode: 'ollama', generation: 1, selection: { mode: 'ollama', model: settings.localEmbeddingModel, precision: 'float32' },
  identity: { provider: 'ollama', model: settings.localEmbeddingModel, revision: 'weights', dimensions: 2, precision: 'float32', document_preprocessing: 'utf8-normalized-v1', query_preprocessing: 'raw-v1' },
  coverage: { embedded: [], missing: [] }, pending_points: [] }
const embed = vi.fn<EmbeddingClient['embed']>(), readiness = new EmbeddingReadiness()
beforeEach(() => {
  vi.clearAllMocks(); vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] })
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('测试禁止真实网络') }))
  embed.mockImplementation(() => new Promise(() => {}))
  vi.mocked(createEmbeddingClient).mockReturnValue({ embed })
  vi.mocked(findLayeredLibrary).mockImplementation(async root => ({ root, card: {} as never }))
  vi.mocked(libraryVectorState).mockResolvedValue(vector)
})
afterEach(() => { readiness.cancel(); embeddingReadiness.cancel(); vi.useRealTimers(); vi.unstubAllGlobals() })
const library = (id: string) => ({ ...newLibrary(id), wikiPath: 'C:/' + id, mode: 'readonly' as const })

it('云端、纯全文、未登记与无法确认身份的库不发预热请求', async () => {
  vi.mocked(libraryVectorState).mockImplementation(async root => root.endsWith('cloud') ? { ...vector, mode: 'cloud', identity: { ...vector.identity!, provider: 'cloud', service_url: 'https://cloud.invalid/v1' } }
    : root.endsWith('none') ? { ...vector, mode: 'none', identity: undefined } as never : undefined)
  await readiness.warmRegistered([library('cloud'), library('none'), library('unknown')], new AbortController().signal)
  await readiness.warm(layeredSettings({ embeddingMode: 'cloud' })); await readiness.warm(layeredSettings({ embeddingMode: 'none' }))
  await vi.advanceTimersByTimeAsync(0)
  expect(createEmbeddingClient).not.toHaveBeenCalled(); expect(embed).not.toHaveBeenCalled()
})

it('后台九十秒超时只记录失败、不重试不刷屏，卸载后晚返回不能重新标为就绪', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  let complete!: (vectors: number[][]) => void
  embed.mockImplementation(() => new Promise(resolve => { complete = resolve }))
  const pending = readiness.warm(settings); await vi.advanceTimersByTimeAsync(0)
  expect(readiness.state(settings).status).toBe('warming')
  await vi.advanceTimersByTimeAsync(89999); expect(readiness.state(settings).status).toBe('warming')
  await vi.advanceTimersByTimeAsync(1)
  expect(await pending).toMatchObject({ status: 'failed', cause: expect.objectContaining({ name: 'TimeoutError' }) })
  expect(embed.mock.calls[0]![1]!.aborted).toBe(true)
  await readiness.warm(settings); expect(embed).toHaveBeenCalledTimes(1); expect(warn).not.toHaveBeenCalled()
  readiness.cancel(); complete([[1, 0]]); await Promise.resolve()
  expect(readiness.state(settings).status).toBe('unknown'); warn.mockRestore()
})

it('预热失败记录原始原因，停用能拦住尚未完成的登记读取', async () => {
  embed.mockRejectedValue(new TypeError('ECONNREFUSED'))
  const failed = readiness.warm(settings); await vi.advanceTimersByTimeAsync(0)
  expect(await failed).toMatchObject({ status: 'failed', cause: expect.objectContaining({ message: 'ECONNREFUSED' }) })
  await readiness.warm(settings); expect(embed).toHaveBeenCalledTimes(1)
  const abort = new AbortController()
  vi.mocked(findLayeredLibrary).mockImplementation(async root => { abort.abort(); return { root, card: {} as never } })
  await readiness.warmRegistered([library('late')], abort.signal)
  expect(embed).toHaveBeenCalledTimes(1)
})

it('并发查询先成功时，共享预热等待者也收到就绪状态', async () => {
  const pending = readiness.warm(settings); await vi.advanceTimersByTimeAsync(0)
  readiness.ready(settings)
  expect(await pending).toMatchObject({ status: 'ready' })
  expect(embed.mock.calls[0]![1]!.aborted).toBe(true)
  expect(readiness.state(settings).status).toBe('ready')
})
