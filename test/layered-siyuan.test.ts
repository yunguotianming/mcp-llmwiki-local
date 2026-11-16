import { mockSupportReview } from './layered-fixture.js'
import { OllamaEmbeddingClient } from '../src/layered/embedding.js'
import { storageJson } from '../src/layered/vectors.js'
import * as filesystem from 'node:fs/promises'
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, expect, it, vi } from 'vitest'
import { emptyRegistry, parseRegistry, siyuanSettings } from '../src/domain/config.js'
import { exportConfig, importConfig } from '../src/domain/config-io.js'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { canonical, SiyuanAdapter, validateSiyuanRoot, WikiExportClient } from '../src/layered/siyuan.js'
import { hash } from '../src/layered/files.js'
import { safePath } from '../src/storage/paths.js'
import { readCurrent, readManifest, validatePublication } from '../src/layered/publication.js'
import { withLayeredRead } from '../src/layered/revocations.js'
import { LibraryStore } from '../src/storage/libraries.js'
import { WikiQuery } from '../src/wiki/query.js'
import { WikiOperations } from '../src/host/wiki-operations.js'
import { cleanupLayeredFixtures, layeredIncrementalFixture, shareLayeredFixture, snapshotFixture } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); cleanupLayeredFixtures() })
const A = '20261108000001-aaaaaaa', B = '20261108000002-bbbbbbb', C = '20261108000003-ccccccc'
const ROW = '20261108000004-ddddddd', AV = '20261108000005-eeeeeee', NB = '20261108000000-nnnnnnn'
const credential = 'test-b7-token-never-log', epoch = '00000000-0000-4000-8000-000000000001'
const prefix = '/local/v1/wiki-export'
function server() {
  const docs = [A, B, C].map((document_id, index) => ({ document_id, notebook_id: NB, parent_id: null, path: '/' + document_id + '.sy',
    title: '笔记' + index, updated: '20261108000000', text: index ? '乙组安全结论。' : '甲组数据库研究。', attributes: {} as Record<string, string> }))
  const states = new Map(docs.map(doc => [doc.document_id, 'allowed']))
  const events: { document_id: string; state: string; reason: string; generation: number; event_id: string; observed_at: string }[] = []
  const requests: { route: string; body: Record<string, any>; headers: Headers }[] = []
  let revision = 1, sequence = 3, fail = '', disconnect = false, corrupt = false, blocked: (() => void) | undefined
  const stateFor = (document_id: string) => ({ document_id, state: states.get(document_id) ?? 'missing', reason: null, state_generation: sequence })
  const asset = Buffer.from('二进制附件\u0000，不作为正文'), assetHash = hash(asset)
  const object = (object_id: string, kind: string, value: string) => ({ descriptor: { object_id, kind, media_type: kind === 'kramdown' ? 'text/plain; charset=utf-8' : kind === 'database_table' ? 'text/markdown; charset=utf-8' : 'application/json', byte_length: Buffer.byteLength(value), raw_hash: hash(value) }, text: value })
  const exportData = (documentId: string) => {
    const doc = docs.find(doc => doc.document_id === documentId)!, body = doc.text + '\n{: id="' + documentId + '" updated="' + doc.updated + '"}\n'
    const projection = canonical({ version: 'siyuan-content-v1', body: [{ type: 'text', text: doc.text }], attributes: {}, databases: documentId === A ? [{ rows: [{ value: '甲组行证据。', block_id: ROW }] }] : [] })
    const locators: Record<string, unknown>[] = [{ locator: 'block:' + documentId, object_id: 'body', start_bytes: 0, end_bytes: Buffer.byteLength(doc.text), source_document_id: documentId, block_id: documentId }]
    const objects = [object('body', 'kramdown', body)]
    if (documentId === A) {
      const table = '| 结论 |\n| --- |\n| {"content":"甲组行证据。"} |\n', start = Buffer.byteLength('| 结论 |\n| --- |\n')
      objects.push(object(AV + '-raw', 'database_raw', canonical({ id: AV, keyValues: [{ key: { name: '结论', type: 'block' }, values: [{ block: { id: ROW, content: '甲组行证据。' } }] }] })))
      objects.push(object(AV + '-map', 'database_map', canonical({ mapping_status: 'verified', rows: [{ block_id: ROW, source_document_id: A }], columns: [{ name: '结论', native_type: 'block' }] })))
      objects.push(object(AV + '-table', 'database_table', table))
      locators.push({ locator: 'block:' + ROW, object_id: AV + '-table', start_bytes: start, end_bytes: Buffer.byteLength(table), source_document_id: A, block_id: ROW })
    }
    objects.push(object('content-projection', 'content_projection', projection), object('attributes', 'attributes', canonical(doc.attributes)),
      object('metadata', 'metadata', canonical(doc)), object('locators', 'locators', canonical(locators)), object('references', 'references', '[]'))
    const document = { document_id: doc.document_id, notebook_id: NB, parent_id: null, path: doc.path, title: doc.title, updated: doc.updated, attributes: doc.attributes,
      metadata: { source_type: '思源笔记', source_date: null }, content_hash: hash(projection), source_version: doc.updated + '~' + hash(projection), content_projection_version: 'siyuan-content-v1', hash_algorithm: 'sha256',
      target: { backend: 'siyuan', workspace_id: 'workspace', document_id: documentId }, keeper_revision: { document_revision: hash(body), content_hash: hash(body).slice(7), observed_at: '2026-11-08T00:00:00Z' }, resource_version: documentId === A ? [assetHash] : [] }
    return { document, objects }
  }
  const request = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input)), route = url.pathname, headers = new Headers(init?.headers)
    const body = init?.method === 'POST' ? JSON.parse(String(init.body)) : Object.fromEntries(url.searchParams)
    expect(headers.get('authorization')).toBe('Bearer ' + credential)
    expect(JSON.stringify(body)).not.toContain(credential); expect(route.startsWith(prefix)).toBe(true)
    requests.push({ route, body, headers })
    const base = { protocol_version: 1, status: 'ok', request_id: body.request_id, epoch, generation: sequence, scope_revision: revision, config_hash: body.config_hash, checked_at: '2026-11-08T00:00:00Z' }
    const ok = (value: unknown) => Response.json({ ...base, ...value as object })
    const error = (code: string, status = 403) => Response.json({ protocol_version: 1, error_code: code, message: credential, reason: credential }, { status })
    if (fail === 'offline') throw new Error(credential)
    if (route.endsWith('/admissions/check') && fail === 'timeout') { blocked?.(); return new Promise<Response>(() => {}) }
    if (fail && fail !== 'timeout') return error(fail)
    const paginate = (items: unknown[], snapshot_id: string) => {
      const offset = Number(body.cursor ?? 0), next = offset + 1 < items.length ? String(offset + 1) : null
      return { items: items.slice(offset, offset + 1), snapshot_id, next_cursor: next, complete: next === null }
    }
    if (route.endsWith('/notebooks')) return ok(paginate([{ notebook_id: NB, name: '笔记本', state: 'allowed' }], 'notebooks'))
    if (route.endsWith('/documents/list')) return ok(paginate(docs.filter(doc => states.get(doc.document_id) === 'allowed').map(({ text, ...doc }) => doc), 'documents'))
    if (route.endsWith('/admissions/check')) {
      const items = (body.document_ids ?? [...states.keys()]).map(stateFor)
      return ok({ ...(body.document_ids ? { items, complete: true, next_cursor: null } : paginate(items, 'admissions')), changes_required: true })
    }
    if (route.endsWith('/changes/read')) {
      if (disconnect && body.cursor) { disconnect = false; throw new Error(credential) }
      const items = events.filter(event => event.generation > body.after_generation), page = paginate(items, 'changes-' + body.after_generation)
      return ok({ ...page, high_watermark: sequence, next_generation: (page.items.at(-1) as typeof events[number])?.generation ?? body.after_generation })
    }
    const documentId = route.split('/')[5]!
    if (documentId === C) return error('source_format_unsupported', 422)
    if (states.get(documentId) !== 'allowed') return error('scope_revoked')
    if (route.endsWith('/export')) {
      const { document, objects } = exportData(documentId)
      // 第一对象故意在中文之后分片，验证 UTF-8 字节偏移与多对象分页。
      const fragments = objects.flatMap(object => {
        const pieces = object.descriptor.object_id === 'body' ? [object.text.slice(0, 3), object.text.slice(3)] : [object.text]
        return pieces.map((text, index) => ({ object, text, offset_bytes: index ? Buffer.byteLength(pieces[0]!) : 0, last: index === pieces.length - 1 }))
      })
      const index = Number(body.cursor ?? 0), item = fragments[index]!, complete = index + 1 === fragments.length
      return ok({ snapshot_id: 'export-' + documentId, export_id: 'export-' + documentId, document, objects: [item.object.descriptor],
        parts: [{ object_id: item.object.descriptor.object_id, text: corrupt ? item.text + '损坏' : item.text, offset_bytes: item.offset_bytes, last: item.last }],
        complete, next_cursor: complete ? null : String(index + 1), ...(complete ? { object_count: objects.length, objects_digest: hash(canonical(objects.map(o => o.descriptor).sort((a, b) => a.object_id < b.object_id ? -1 : 1))) } : {}) })
    }
    if (route.endsWith('/attachments')) return ok({ ...paginate(documentId === A ? [{ attachment_id: 'asset', original_path: 'assets/p.png', name: 'p.png', content_hash: assetHash, size_bytes: asset.length, media_type: 'image/png', block_ids: [A], state: 'allowed' }] : [], 'attachments-' + documentId), export_id: 'export-' + documentId, resource_version: documentId === A ? [assetHash] : [] })
    if (route.endsWith('/attachments/asset')) return new Response(asset, { status: 206, headers: { etag: '"' + assetHash + '"', 'x-request-id': body.request_id, 'x-admission-epoch': epoch, 'x-admission-generation': String(sequence), 'content-range': `bytes 0-${asset.length - 1}/${asset.length}` } })
    throw new Error('未知 mock 路由')
  })
  return { request, requests, docs, asset, states, exportData,
    get sequence() { return sequence }, set fail(value: string) { fail = value }, set corrupt(value: boolean) { corrupt = value },
    set disconnect(value: boolean) { disconnect = value }, set onBlocked(value: () => void) { blocked = value },
    change(document_id: string, state: string, reason: string) { states.set(document_id, state); if (reason === 'notebook_removed') revision++;
      events.push({ document_id, state, reason, generation: ++sequence, event_id: randomUUID(), observed_at: '2026-11-08T00:00:01Z' }) },
  }
}
let template: Awaited<ReturnType<typeof shareLayeredFixture>>
let reuseRoot: string
async function fixture(copy = true, reuse = true) {
  const f = await layeredIncrementalFixture(copy ? template : undefined, copy && reuse ? reuseRoot : undefined), mock = server()
  const settings = { whalefallUrl: 'http://mock.invalid', credentialRef: 'WIKI_B7_TEST_CREDENTIAL', workspaceId: 'workspace', workspacePath: path.join(f.knowledgeRoot, 'siyuan-workspace'), notebookIds: [NB] }
  const root = path.join(f.knowledgeRoot, 'wiki'); await mkdir(root, { recursive: true })
  vi.stubEnv(settings.credentialRef, credential); vi.stubGlobal('fetch', mock.request)
  f.library.siyuan = settings; f.library.wikiPath = root; f.library.name = '思源测试库'
  const adapter = new SiyuanAdapter(new WikiExportClient(f.library.id, settings, mock.request))
  const registry = emptyRegistry(); registry.libraries = [f.library]
  const store = new LibraryStore(() => registry), query = new WikiQuery(store, { embed: f.embed })
  const original = f.call.getMockImplementation()!
  f.call.mockImplementation(async (...args) => {
    // 既有场景的新增核对阶段返回完整支撑，原提取与纠正夹具保持。
    const support = mockSupportReview(JSON.parse(args[2]))
    if (support) return support
    const input = JSON.parse(args[2])
    if (input.term_id) return JSON.stringify({ definition: [{ text: '资料共同定义。', keys: input.contributions.map((item: { key: string }) => item.key) }], usage: [], findings: [], differences: [] })
    const raw = await original(...args)
    if (input.topic_id || input.new_tags) return raw
    const output = JSON.parse(raw), part = input.paragraphs[0]
    output.terms = [{ paragraph_id: part.paragraph_id, locator: part.locator, name: '研究术语', category: '概念', aliases: [], note: '共同使用的研究概念。' }]
    return JSON.stringify(output)
  })
  const options = { ...f.options, knowledgeRoot: root, siyuan: adapter, topics: { topicMergeMinSources: 1, termThreshold50: 2 } }
  return { ...f, root, mock, adapter, settings, options, registry, query, store }
}
const manifest = async (root: string) => readManifest(root, await readCurrent(root))
// 直接观察本地撤权过滤；公开查询的在线准入由独立场景覆盖。
const page = async (root: string, relative: string, version?: string) => withLayeredRead(root, view => view.document(relative), { ...(version ? { version } : {}), checkAdmission: async () => {} })
beforeAll(async () => { const f = await fixture(false); await buildLayeredLibrary(f.options); template = await shareLayeredFixture(f); reuseRoot = f.knowledgeRoot })

it('分页全量建库保留 Kramdown、数据库 JSON、行块定位和附件；unsupported 记缺口并发布其他来源', async () => {
  const f = await fixture(), saved = await manifest(f.root), source = saved.sources.find(source => source.source_id === A)!
  expect(saved.sources.map(source => source.source_id)).toEqual([A, B]); expect(saved.gaps).toEqual([{ source_id: C, status: 'unsupported', message: expect.stringContaining('缺口') }])
  expect(source.source_version).toBe(f.mock.exportData(A).document.source_version)
  expect(await readFile(await safePath(f.root, source.files.source), 'utf8')).toContain('{: id="' + A)
  expect(await readFile(await safePath(f.root, source.files.assets[0]!.path))).toEqual(f.mock.asset)
  const raw = source.siyuan!.objects.find(object => object.path.endsWith(AV + '-raw.json'))!
  expect(await readFile(await safePath(f.root, raw.path), 'utf8')).toContain('keyValues')
  const content = (await f.query.read('sources/' + A + '.md', f.library.name)).content
  expect(content).toContain('block:' + ROW); expect(content).toContain('甲组行证据'); expect(content).not.toContain('二进制附件')
  expect(await f.query.sourceRead(A, 'block:' + ROW, f.library.name)).toMatchObject({ status: 'external', content: '请走 keeper_notes 回源' })
  expect((await f.query.catalog()).libraries[0]).toMatchObject({ originType: 'siyuan', sourceCount: 2 })
  expect((await f.query.search('甲组', f.library.name)).results.some(item => item.path === 'sources/' + A + '.md')).toBe(true)
  expect((await f.adapter.client.notebooks()).items).toHaveLength(1)
  await validatePublication(f.root, saved.version!)
  f.call.mockClear(); f.embed.mockClear()
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ unchanged: true, modelCalls: 0 })
  expect(f.mock.requests.filter(request => request.route.endsWith('/documents/list')).map(request => request.body.cursor)).toEqual([null, '1', '2'])
  expect(f.mock.requests.filter(request => request.route.endsWith('/export')).length).toBeGreaterThan(10)
  expect(f.call).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled()
})

it('更新时间变哈希不变只补来源和主题核对、零提取嵌入；同时间哈希变化才重提；文档 ID 不变改名只改路径', async () => {
  const f = await fixture(), before = await manifest(f.root), old = (await page(f.root, 'sources/' + A + '.md')).content
  f.mock.docs[0]!.updated = '20261108010000'; f.call.mockClear(); f.embed.mockClear()
  // 思源版本包含更新时间；同内容复用提取，证据绑定当前版本后补来源和主题核对。
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ modelCalls: 2 })
  expect(f.call).toHaveBeenCalledTimes(2); expect(f.embed).not.toHaveBeenCalled()
  const version = '20261108010000~' + before.sources[0]!.content_hash
  const reviews = f.call.mock.calls.map(call => JSON.parse(call[2]))
  expect(reviews.map(review => review.review_stage)).toEqual(['extraction', 'topic'])
  const review = reviews.find(review => review.review_stage === 'topic')!
  expect(review).toMatchObject({ review_stage: 'topic', source_versions: expect.arrayContaining([{ source_id: A, source_version: version }]) })
  expect(f.requests).toEqual([])
  expect((await manifest(f.root)).sources[0]!.source_version).toBe(version)
  f.mock.docs[0]!.text = '甲组修改后的发现。'
  await buildLayeredLibrary(f.options)
  expect(f.requests.flatMap(request => request.input.paragraphs).map(part => part.text)).toEqual(['甲组修改后的发现。'])
  const changed = await manifest(f.root), content = (await page(f.root, 'sources/' + A + '.md')).content
  expect(changed.sources[0]!.content_hash).not.toBe(before.sources[0]!.content_hash); expect(content).not.toBe(old)
  f.call.mockClear(); f.embed.mockClear(); f.mock.docs[0]!.path = '/改名/' + A + '.sy'
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ modelCalls: 0 })
  expect((await manifest(f.root)).sources[0]).toMatchObject({ source_id: A, current_path: f.mock.docs[0]!.path, previous_paths: [before.sources[0]!.current_path] })
  // 路径展示随改名更新，知识正文仍逐字节一致。
  expect((await page(f.root, 'sources/' + A + '.md')).content).toBe(content.replaceAll(changed.sources[0]!.current_path, f.mock.docs[0]!.path))
  expect(f.call).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled()
})

it('排除和笔记本移出范围通过长轮询立即屏蔽；分页断线持久代次续读；重建及重新准入不放行旧版本', async () => {
  const f = await fixture(), saved = await manifest(f.root)
  f.mock.docs[0]!.attributes['custom-llmwiki'] = 'exclude'; f.mock.change(A, 'revoked', 'excluded'); f.mock.change(B, 'revoked', 'notebook_removed'); f.mock.disconnect = true
  await expect(f.adapter.pollOnce(f.root)).rejects.toMatchObject({ status: 'unavailable' })
  expect(await page(f.root, 'sources/' + A + '.md')).toMatchObject({ status: 'updating', content: '更新中' })
  expect(await page(f.root, 'topics/T-0001.md')).toMatchObject({ status: 'updating', content: '更新中' })
  expect(JSON.parse(await readFile(await safePath(f.root, 'state/siyuan-admission.json'), 'utf8')).generation).toBe(4)
  const restarted = new SiyuanAdapter(new WikiExportClient(f.library.id, f.settings, f.mock.request))
  await restarted.pollOnce(f.root)
  expect(f.mock.requests.filter(request => request.route.endsWith('/changes/read')).map(request => request.body.after_generation)).toEqual([3, 3, 4])
  expect(await page(f.root, 'sources/' + B + '.md', saved.version!)).toMatchObject({ status: 'updating' })
  await buildLayeredLibrary(f.options)
  expect((await manifest(f.root)).sources).toEqual([])
  delete f.mock.docs[0]!.attributes['custom-llmwiki']; f.mock.change(A, 'allowed', 'restored')
  await buildLayeredLibrary(f.options)
  expect(await page(f.root, 'sources/' + A + '.md')).toMatchObject({ status: 'ok' })
  await expect(page(f.root, 'sources/' + A + '.md', saved.version!)).rejects.toThrow('保留版本')
})

it('查询前准入不可达与三秒超时拒绝旧缓存；HTTP 和凭据异常不进入错误、日志及失败留痕', async () => {
  const f = await fixture(); await f.query.search('甲组', f.library.name)
  f.mock.fail = 'offline'
  await expect(f.query.search('甲组', f.library.name)).rejects.toMatchObject({ status: 'unavailable' })
  const error = await f.query.read('sources/' + A + '.md', f.library.name).catch(error => error)
  expect(String(error)).toContain('拒绝读取'); expect(String(error)).not.toContain(credential); expect(error.cause).toBeUndefined()
  f.mock.fail = 'timeout'; vi.useFakeTimers()
  let started!: () => void; const entered = new Promise<void>(resolve => { started = resolve }); f.mock.onBlocked = started
  const timed = f.query.read('sources/' + A + '.md', f.library.name).catch(error => error)
  await entered; await vi.advanceTimersByTimeAsync(3000)
  expect(await timed).toMatchObject({ status: 'unavailable', code: 'upstream_timeout' })
  vi.useRealTimers(); f.mock.fail = 'client_unauthorized'
  await expect(buildLayeredLibrary(f.options)).rejects.toMatchObject({ status: 'unauthorized' })
  const names = await readdir(f.root, { recursive: true })
  for (const name of names.filter(name => /\.(md|json|yaml)$/.test(name))) expect(await readFile(path.join(f.root, name), 'utf8')).not.toContain(credential)
})

it('登记校验真实目录边界、设置往返与未确认名单提示；损坏分片拒收且不调用管理端点', async () => {
  const f = await fixture(true, false)
  expect(siyuanSettings(f.settings)).toMatchObject({ excludeAttribute: 'llmwiki', admissionTimeoutMs: 3000, pollWaitMs: 25000, pollIntervalMs: 1000 })
  expect(importConfig(exportConfig(f.registry), emptyRegistry(), 'replace').libraries[0]!.siyuan).toEqual(f.settings)
  const invalid = structuredClone(f.registry); invalid.libraries[0]!.wikiPath = path.join(f.settings.workspacePath, 'wiki')
  expect(() => parseRegistry(invalid)).toThrow('工作空间之外')
  vi.spyOn(filesystem, 'realpath').mockImplementation((await vi.importActual<typeof filesystem>('node:fs/promises')).realpath)
  await mkdir(f.settings.workspacePath); const link = path.join(f.knowledgeRoot, 'outside-link'); await symlink(f.settings.workspacePath, link, 'junction')
  await expect(validateSiyuanRoot(path.join(link, 'wiki'), f.settings)).rejects.toThrow('工作空间之外')
  f.mock.fail = 'config_mismatch'
  await expect(f.adapter.client.documents()).rejects.toThrow('whalefall 管理页')
  f.mock.fail = 'scope_forbidden'
  await expect(f.adapter.client.documents()).rejects.toThrow('管理页')
  f.mock.fail = ''; f.mock.corrupt = true
  await expect(f.adapter.freeze(A)).rejects.toMatchObject({ status: 'unavailable' })
  expect(f.mock.requests.every(request => !request.route.startsWith('/ui/'))).toBe(true)
})

it('协议：HTTP 错误映射、游标重复和对象目录损坏均拒绝继续', async () => {
  const f = await fixture()
  for (const [code, status] of [['source_missing', 'missing'], ['attachment_missing', 'missing'], ['private_access_required', 'private'], ['scope_revoked', 'revoked'], ['source_format_unsupported', 'unsupported'],
    ['siyuan_unavailable', 'unavailable'], ['source_changed', 'conflict'], ['cursor_expired', 'expired'], ['resource_changed', 'conflict'], ['range_invalid', 'invalid'], ['capability_forbidden', 'forbidden']]) {
    f.mock.fail = code!
    await expect(f.adapter.client.documents()).rejects.toMatchObject({ code, status })
  }
  f.mock.fail = ''
  const fetchLoop: typeof fetch = async (input, init) => {
    const response = await f.mock.request(input, init), value = await response.json()
    if (String(input).includes('/export')) { value.complete = false; value.next_cursor = '1' }
    return Response.json(value)
  }
  await expect(new SiyuanAdapter(new WikiExportClient(f.library.id, f.settings, fetchLoop)).freeze(A)).rejects.toMatchObject({ status: 'unavailable' })
  const badDigest: typeof fetch = async (input, init) => {
    const response = await f.mock.request(input, init), value = await response.json()
    if (value.objects_digest) value.objects_digest = hash('错误目录')
    return Response.json(value)
  }
  await expect(new SiyuanAdapter(new WikiExportClient(f.library.id, f.settings, badDigest)).freeze(A)).rejects.toMatchObject({ status: 'unavailable' })
})

it('协议：准入拒绝项同步屏蔽跨文档依赖；准入丢项不能退回缓存', async () => {
  const f = await fixture(), saved = await manifest(f.root)
  // 模拟来源中的数据库行来自另一文档，撤掉行所属文档时也应屏蔽使用该行的来源。
  saved.sources[0]!.siyuan!.dependencies.push(B)
  await writeFile(await safePath(f.root, `versions/${saved.version}.json`), storageJson({ checksum: hash(storageJson(saved)), manifest: saved }))
  f.mock.change(B, 'private', 'privacy_changed')
  expect(await f.query.read('sources/' + A + '.md', f.library.name)).toMatchObject({ status: 'updating', content: '更新中' })
  expect((await f.query.search('甲组', f.library.name)).results).toEqual([])
  const missing: typeof fetch = async (input, init) => {
    const response = await f.mock.request(input, init), value = await response.json()
    if (String(input).includes('/admissions/check')) value.items = []
    return Response.json(value)
  }
  vi.stubGlobal('fetch', missing)
  await expect(f.query.read('index.md', f.library.name)).rejects.toMatchObject({ status: 'unavailable' })
})

it('协议：后台轮询按间隔重连、取消终止；虚拟时钟无真实等待', async () => {
  const f = await fixture(), abort = new AbortController()
  vi.useFakeTimers()
  const poll = vi.spyOn(f.adapter, 'pollOnce').mockRejectedValueOnce(new Error('断线')).mockResolvedValue(undefined)
  const watched = f.adapter.watch(f.root, abort.signal)
  await vi.advanceTimersByTimeAsync(999); expect(poll).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(1); expect(poll).toHaveBeenCalledTimes(2)
  abort.abort(); await watched
  await vi.advanceTimersByTimeAsync(10000); expect(poll).toHaveBeenCalledTimes(2)
})

it('协议：同一语义内容恢复到旧哈希但更新时间变化，缓存引文绑定当前来源版本', async () => {
  const f = await fixture(), original = f.mock.docs[0]!.text
  f.mock.docs[0]!.text = '甲组修改稿。'; await buildLayeredLibrary(f.options)
  f.mock.docs[0]!.text = original; f.mock.docs[0]!.updated = '20261108020000'
  await buildLayeredLibrary(f.options)
  const saved = await manifest(f.root), entry = saved.sources.find(source => source.source_id === A)!
  expect(entry.source_version).toMatch(/^20261108020000~/)
  await validatePublication(f.root, saved.version!)
  expect((await f.query.read(A, f.library.name)).content).toContain(entry.source_version)
})

it('协议：宿主登记与生成入口读取思源配置，直接发布且拒绝旧维护流程', async () => {
  const f = await fixture()
  f.library.layered = { termThreshold50: 2 }
  vi.spyOn(OllamaEmbeddingClient.prototype, 'identity').mockResolvedValue('fixture-weights-v1')
  const fetchSource = f.mock.request
  vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => String(input).includes('127.0.0.1:11434')
    ? Promise.resolve(Response.json(String(input).endsWith('/api/tags') ? { models: [{ name: 'qwen3-embedding:0.6b', digest: 'fixture-weights-v1', capabilities: ['embedding'] }] } : { capabilities: ['embedding'] }))
    : fetchSource(input, init))
  const operations = new WikiOperations(f.store, () => f.runtime, new Map())
  expect(await operations.generate(f.library.id, 'generate', new AbortController().signal)).toMatchObject({ status: 'published', modelCalls: 0 })
  await expect(operations.changes(f.library.id, 'list', new AbortController().signal)).rejects.toThrow('不使用旧版差异批次')
  let registered = emptyRegistry()
  const store = new LibraryStore(() => registered), create = new WikiOperations(store, () => f.runtime, new Map(), async next => { registered = next })
  const outside = path.join(f.knowledgeRoot, 'registered-wiki')
  const input = { name: '新思源库', wikiPath: outside, sourceRoots: [], provider: 'mock', model: 'extractor', siyuan: f.settings }
  await create.create(input, new AbortController().signal)
  expect(registered.libraries[0]!.siyuan).toEqual(f.settings)
  expect(registered.libraries[0]!.kind).toBe('siyuan')
  await expect(create.create({ ...input, wikiPath: path.join(f.settings.workspacePath, 'wiki') }, new AbortController().signal)).rejects.toThrow('工作空间之外')
})


it('旧 local 思源登记迁移保留设置快照与发布字节，接续零重建', async () => {
  const f = await fixture()
  f.library.layered = { termThreshold50: 2 }
  expect(f.library.kind).toBe('local')
  const before = await snapshotFixture(f.root), old = structuredClone(f.library)
  const migrated = f.store.registration(f.library.id)
  expect(migrated).toEqual({ ...old, kind: 'siyuan' })
  expect(f.store.snapshot().libraries[0]).toEqual(migrated)
  expect((await snapshotFixture(f.root)).files).toEqual(before.files)
  f.library.kind = 'siyuan'; f.call.mockClear(); f.embed.mockClear()
  expect(await buildLayeredLibrary(f.options)).toMatchObject({ modelCalls: 0, unchanged: true })
  expect(f.call).not.toHaveBeenCalled(); expect(f.embed).not.toHaveBeenCalled()
  const after = await snapshotFixture(f.root)
  for (const [file, bytes] of before.files) if (file.startsWith('objects') || file.startsWith('versions') || file.endsWith('policy.json')) expect(after.files.get(file), file).toEqual(bytes)
})
