import * as filesystem from 'node:fs/promises'
import { readFile, rename, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { putPage, pageObjectPath, readPageObject } from '../src/layered/objects.js'
import { hydrateVectors, putVector, readVector, vectorPath } from '../src/layered/vectors.js'
import { hash } from '../src/layered/files.js'
import { cleanupLayeredFixtures, layeredFixture } from './layered-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('已校验页面复用正文，文件删除后仍拒绝缓存', async () => {
  const f = await layeredFixture(), id = await putPage(f.knowledgeRoot, '页面正文')
  const file = path.join(f.knowledgeRoot, pageObjectPath(id)), original = filesystem.readFile
  const reads = vi.spyOn(filesystem, 'readFile').mockImplementation(original)
  expect(await readPageObject(f.knowledgeRoot, id)).toBe('页面正文')
  expect(await readPageObject(f.knowledgeRoot, id)).toBe('页面正文')
  expect(reads.mock.calls.filter(([target]) => target === file)).toHaveLength(1)
  await unlink(file)
  await expect(readPageObject(f.knowledgeRoot, id)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('同长度损坏且恢复 mtime 的页面仍重新校验，修复后可读取', async () => {
  const f = await layeredFixture(), id = await putPage(f.knowledgeRoot, '原始正文')
  const file = path.join(f.knowledgeRoot, pageObjectPath(id)), metadata = await stat(file)
  expect(await readPageObject(f.knowledgeRoot, id)).toBe('原始正文')
  await writeFile(file, '损坏正文'); await utimes(file, metadata.atime, metadata.mtime)
  await expect(readPageObject(f.knowledgeRoot, id)).rejects.toThrow('页面对象校验失败')
  await writeFile(file, '原始正文')
  expect(await readPageObject(f.knowledgeRoot, id)).toBe('原始正文')
})

it('同路径替换对象时不能复用旧正文，读取期间改写不进入缓存', async () => {
  const f = await layeredFixture(), id = await putPage(f.knowledgeRoot, '原始正文')
  const file = path.join(f.knowledgeRoot, pageObjectPath(id))
  expect(await readPageObject(f.knowledgeRoot, id)).toBe('原始正文')
  await writeFile(file + '.replacement', '替换正文'); await rename(file + '.replacement', file)
  await expect(readPageObject(f.knowledgeRoot, id)).rejects.toThrow('页面对象校验失败')
  await writeFile(file, '原始正文')
  const original = filesystem.readFile
  const reads = vi.spyOn(filesystem, 'readFile').mockImplementation(async (...args) => {
    const bytes = await original(...args)
    if (args[0] === file) await writeFile(file, '读取改写')
    return bytes
  })
  expect(await readPageObject(f.knowledgeRoot, id)).toBe('原始正文')
  reads.mockRestore()
  await expect(readPageObject(f.knowledgeRoot, id)).rejects.toThrow('页面对象校验失败')
})

it('向量缓存隔离调用方修改，两精度同长度损坏与缺件仍被发现', async () => {
  const f = await layeredFixture()
  for (const precision of ['float32', 'float16'] as const) {
    const { vector_id: id } = await putVector(f.knowledgeRoot, { provider: '测试', model: '模型', revision: '权重', preprocessing: 'v1', dimensions: 2, input_hash: hash('输入') }, [1, 0], precision)
    const file = path.join(f.knowledgeRoot, vectorPath(id)), metadata = await stat(file)
    const vector = await readVector(f.knowledgeRoot, id); vector[0] = 99
    expect(await readVector(f.knowledgeRoot, id)).toEqual([1, 0])
    const bytes = await readFile(file); bytes[bytes.length - 1] ^= 1
    await writeFile(file, bytes); await utimes(file, metadata.atime, metadata.mtime)
    await expect(readVector(f.knowledgeRoot, id)).rejects.toThrow('校验和')
    await unlink(file)
    await expect(readVector(f.knowledgeRoot, id)).rejects.toMatchObject({ code: 'ENOENT' })
  }
})

it('批量恢复按对象去重且有界并行，保留原成员顺序和归一化结果', async () => {
  const f = await layeredFixture(), ids: string[] = []
  for (let i = 0; i < 10; i++) {
    ids.push((await putVector(f.knowledgeRoot, { provider: '测试', model: '模型', revision: '权重', preprocessing: 'v1', dimensions: 2, input_hash: hash(String(i)) }, [3, 4], 'float32')).vector_id)
  }
  const original = filesystem.readFile
  let active = 0, peak = 0, reads = 0
  vi.spyOn(filesystem, 'readFile').mockImplementation(async (...args) => {
    if (!String(args[0]).endsWith('.bin')) return original(...args)
    reads++; active++; peak = Math.max(peak, active)
    try { await setImmediate(); return await original(...args) } finally { active-- }
  })
  const records = [...ids, ...ids.toReversed()].map(vector_id => ({ vector_id, vector: [] as number[] }))
  await hydrateVectors(f.knowledgeRoot, records)
  expect(reads).toBe(10); expect(peak).toBe(8); expect(active).toBe(0)
  expect(records.map(item => item.vector_id)).toEqual([...ids, ...ids.toReversed()])
  expect(records.map(item => item.vector)).toEqual(Array.from({ length: 20 }, () => [0.6, 0.8]))
})

it('数百页检索引用恢复不展开向量，翻倍页数不增加解码或克隆载荷', async () => {
  const f = await layeredFixture()
  const { vector_id, input_hash } = await putVector(f.knowledgeRoot, { provider: '测试', model: '模型', revision: '权重',
    preprocessing: 'v1', dimensions: 4096, input_hash: hash('共享输入') }, Array.from({ length: 4096 }, () => 1), 'float32')
  const original = filesystem.readFile
  const reads = vi.spyOn(filesystem, 'readFile').mockImplementation(original)
  for (const pages of [200, 400]) {
    const value = { manifest: { vector_state: { page_vectors: Object.fromEntries(Array.from({ length: pages }, (_, page) =>
      [`topics/${page}.md`, { vectors: Array.from({ length: 64 }, () => ({ vector_id, input_hash })) }])) } } }
    const before = JSON.stringify(value)
    await hydrateVectors(f.knowledgeRoot, value)
    expect(reads.mock.calls.filter(([file]) => String(file).endsWith('.bin'))).toHaveLength(0)
    expect(JSON.stringify(structuredClone(value))).toBe(before)
    expect(Object.values(value.manifest.vector_state.page_vectors).every(page => page.vectors.every(ref => !('vector' in ref)))).toBe(true)
  }
  // 聚类真正使用的向量仍读取并归一化；同一对象在运行态按身份共享。
  const records = Array.from({ length: 2 }, () => ({ vector_id, input_hash, vector: [] as number[] }))
  await hydrateVectors(f.knowledgeRoot, records)
  expect(reads.mock.calls.filter(([file]) => String(file).endsWith('.bin'))).toHaveLength(1)
  expect(records[0]!.vector).toBe(records[1]!.vector)
  expect(records[0]!.vector).toHaveLength(4096)
  expect(records[0]!.vector[0]).toBe(1 / 64)
})
