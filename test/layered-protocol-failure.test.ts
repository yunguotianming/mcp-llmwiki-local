import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { ModelCallError } from '../src/llm/client.js'
import { buildLayeredLibrary } from '../src/layered/index.js'
import { cleanupLayeredFixtures, layeredFixture } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(() => cleanupLayeredFixtures())

it('提取结构化协议全部被拒绝时中止且不生成预览', async () => {
  const fixture = await layeredFixture()
  await writeFile(path.join(fixture.knowledgeRoot, 'a.md'), '一段需要提取的资料。')
  fixture.runtime.stream = async function* () {
    throw new ModelCallError('Invalid schema for response_format：required 缺失', 'invalid_json_schema', 400)
  }
  await expect(buildLayeredLibrary({ ...fixture.options, publish: false })).rejects.toThrow('结构化输出协议或服务端拒绝')
  await expect(readFile(path.join(fixture.root, 'work/preview.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(readFile(path.join(fixture.root, 'state/current.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})

it('少量结构化协议拒绝仍生成带缺口的非空预览', async () => {
  const fixture = await layeredFixture()
  await writeFile(path.join(fixture.knowledgeRoot, 'a.md'), '失败来源的资料。')
  await writeFile(path.join(fixture.knowledgeRoot, 'b.md'), '成功来源的资料。')
  const original = fixture.runtime.stream.bind(fixture.runtime)
  fixture.runtime.stream = async function* (options) {
    const input = JSON.parse((options.messages[0]!.content[0] as { text: string }).text) as { source_id?: string }
    if (input.source_id === 'S-0001') throw new ModelCallError('Invalid schema for response_format：required 缺失', 'invalid_json_schema', 400)
    yield* original(options)
  }
  const result = await buildLayeredLibrary({ ...fixture.options, publish: false })
  const preview = JSON.parse(await readFile(path.join(fixture.root, 'work/preview.json'), 'utf8'))
  const pending = JSON.parse(await readFile(path.join(fixture.root, 'work/pending.json'), 'utf8'))
  const manifest = pending.manifest
  expect(result.version).toMatch(/^v\d{6,}$/)
  expect(preview.version).toBe(result.version)
  expect(manifest.sources).toHaveLength(2)
  expect(manifest.sources.some(source => source.source_id === 'S-0001')).toBe(true)
  const failed = manifest.sources.find((source: { source_id: string }) => source.source_id === 'S-0001')!
  const extraction = JSON.parse(await readFile(path.join(fixture.root, failed.extract.path), 'utf8'))
  expect(extraction.gaps?.some((gap: { reasons: { rule: string }[] }) => gap.reasons.some(reason => reason.rule === 'extract-group'))).toBe(true)
  expect(manifest.sources.some(source => source.source_id === 'S-0002')).toBe(true)
  const succeeded = manifest.sources.find((source: { source_id: string }) => source.source_id === 'S-0002')!
  const accepted = JSON.parse(await readFile(path.join(fixture.root, succeeded.extract.path), 'utf8'))
  expect(accepted.segments.flatMap((segment: { points: unknown[] }) => segment.points).length).toBeGreaterThan(0)
})

it('超过半数提取遭服务端拒绝时中止且错误隐藏凭据', async () => {
  const fixture = await layeredFixture()
  for (const name of ['a', 'b', 'c']) await writeFile(path.join(fixture.knowledgeRoot, name + '.md'), name + '资料中的主张。')
  const original = fixture.runtime.stream.bind(fixture.runtime)
  fixture.runtime.stream = async function* (options) {
    const input = JSON.parse((options.messages[0]!.content[0] as { text: string }).text)
    if (input.source_id && input.source_id !== 'S-0003') throw new ModelCallError('访问被拒绝 api_key=example-secret', 'forbidden', 403)
    yield* original(options)
  }
  const error = await buildLayeredLibrary({ ...fixture.options, publish: false }).catch(error => error)
  expect(error).toBeInstanceOf(Error)
  expect(error.message).toContain('首个服务端错误：访问被拒绝')
  expect(error.message).not.toContain('example-secret')
  await expect(readFile(path.join(fixture.root, 'work/preview.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
})
