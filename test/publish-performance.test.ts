import { createTermSearch } from '../src/layered/terms.js'
import { normalized, similarity } from '../src/layered/embedding.js'
import { afterEach, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { references, validateCompleteVersion } from '../src/layered/retention.js'
import { putVector, readVectorRecord, vectorPath } from '../src/layered/vectors.js'
import { recordIdentity } from '../src/layered/vector-identity.js'
import { hash } from '../src/layered/files.js'
import type { SnapshotManifest } from '../src/layered/schema.js'

const roots: string[] = []
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }) })
it('引用收集按向量身份保留对象且不读取向量元素', () => {
  const id = hash('向量'), files = new Set<string>(), vectors = new Set<string>()
  const vector = new Proxy([1, 0], { get(target, key, receiver) { if (/^\d+$/.test(String(key))) throw new Error('不应读取向量元素'); return Reflect.get(target, key, receiver) } })
  references({ vector_id: id, vector, nested: { content_id: hash('页面') } }, files, vectors)
  expect(vectors).toEqual(new Set([id])); expect(files.has(vectorPath(id))).toBe(true)
  expect(files.size).toBe(2)
})

it('严格发布校验仍拒绝缺件、载荷哈希不符及向量身份不符', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wiki-perf-retention-')); roots.push(root)
  const reference = await putVector(root, { provider: 'ollama', model: '测试', revision: '权重', dimensions: 2, preprocessing: 'utf8-normalized-v1', query_preprocessing: 'raw-v1', input_hash: hash('输入') }, [1, 0], 'float32')
  const manifest: SnapshotManifest = { format_version: 2, version: 'v000001', next_source_number: 1, revocation_generation: 0, sources: [], pages: {},
    vector_state: { mode: 'ollama', generation: 1, identity: recordIdentity(await readVectorRecord(root, reference.vector_id)),
      selection: { mode: 'ollama', model: '测试', precision: 'float32' }, coverage: { embedded: [], missing: [] }, pending_points: [],
      page_vectors: { 'index.md': { vectors: [reference] } } } }
  await validateCompleteVersion(root, manifest, true)
  const file = path.join(root, vectorPath(reference.vector_id)), bytes = await readFile(file)
  const damaged = Buffer.from(bytes); damaged[damaged.length - 1]! ^= 1
  await writeFile(file, damaged)
  await expect(validateCompleteVersion(root, manifest, true)).rejects.toThrow('校验和')
  await writeFile(file, bytes)
  manifest.vector_state!.identity!.revision = '另一个权重'
  await expect(validateCompleteVersion(root, manifest, true)).rejects.toThrow('身份不符')
  await unlink(file)
  await expect(validateCompleteVersion(root, manifest, true)).rejects.toMatchObject({ code: 'ENOENT' })
})

it('无需解码向量也拒绝哈希正确的非有限载荷和错误维数', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wiki-perf-vector-')); roots.push(root)
  for (const precision of ['float16', 'float32'] as const) {
    const reference = await putVector(root, { provider: 'ollama', model: '测试', revision: '权重', dimensions: 2,
      preprocessing: 'utf8-normalized-v1', query_preprocessing: 'raw-v1', input_hash: hash('输入') }, [1, 0], precision)
    const file = path.join(root, vectorPath(reference.vector_id)), bytes = await readFile(file)
    const headerSize = bytes.readUInt32LE(4), header = JSON.parse(bytes.subarray(8, 8 + headerSize).toString('utf8'))
    const payload = Buffer.from(bytes.subarray(8 + headerSize))
    if (precision === 'float16') payload.writeUInt16LE(0x7c00, 0)
    else payload.writeUInt32LE(0x7f800000, 0)
    header.checksum = hash(payload)
    const metadata = Buffer.from(JSON.stringify(header)), prefix = Buffer.from(bytes.subarray(0, 8))
    prefix.writeUInt32LE(metadata.length, 4)
    await writeFile(file, Buffer.concat([prefix, metadata, payload]))
    await expect(readVectorRecord(root, reference.vector_id)).rejects.toThrow('非有限')
    const shortened = bytes.subarray(8 + headerSize, bytes.length - (precision === 'float16' ? 2 : 4))
    header.checksum = hash(shortened)
    await writeFile(file, Buffer.concat([prefix, Buffer.from(JSON.stringify(header)), shortened]))
    await expect(readVectorRecord(root, reference.vector_id)).rejects.toThrow('维数')
  }
})

type Record = { id: string; vector: number[]; eligible: boolean }
const oldNearest = (records: Record[], vector: number[], threshold: number) => {
  const best = records.map(record => ({ record, score: record.vector.reduce((sum, value, index) => sum + value * vector[index]!, 0) }))
    .sort((a, b) => b.score - a.score || a.record.id.localeCompare(b.record.id))[0]
  return best && best.score > threshold && best.record.eligible ? best.record : undefined
}

it('随机4096维向量的归并选择与旧全局排序逐项一致', () => {
  let seed = 61821
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32 }
  const search = createTermSearch<Record>()
  for (let round = 0; round < 30; round++) {
    const vector = normalized(Array.from({ length: 4096 }, () => random() - 0.5))
    const records = Array.from({ length: 32 }, (_, i) => ({ id: 'TM-' + String(i).padStart(4, '0'), eligible: random() > 0.5,
      vector: normalized(vector.map(value => value * (i % 3 === 0 ? 50 : 1) + random() - 0.5)) }))
    const threshold = [0, 0.2, 0.8][round % 3]!
    for (const record of records) expect(similarity(record.vector, vector)).toBe(record.vector.reduce((sum, value, index) => sum + value * vector[index]!, 0))
    expect(search(records, records.filter(record => record.eligible), vector, record => record.vector, threshold))
      .toBe(oldNearest(records, vector, threshold))
  }
})

it('阈值邻域、相等分数和跨类别更近者均保留旧判定', () => {
  const search = createTermSearch<Record>(), vector = [1, 0], threshold = 0.8
  for (const offset of [-1e-6, -1e-9, 0, 1e-9, 1e-6]) {
    const value = threshold + offset
    const candidate = { id: 'TM-0002', eligible: true, vector: [value, Math.sqrt(1 - value * value)] }
    for (const records of [[candidate], [{ ...candidate, id: 'TM-0001', eligible: false }, candidate],
      [candidate, { ...candidate, id: 'TM-0003', vector: [value + 1e-10, Math.sqrt(1 - (value + 1e-10) ** 2)], eligible: false }]]) {
      expect(search(records, records.filter(record => record.eligible), vector, record => record.vector, threshold))
        .toBe(oldNearest(records, vector, threshold))
    }
  }
})
