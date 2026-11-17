import type { TopicState } from './schema.js'
import { hash, hashName, immutableWrite, readVerifiedObject } from './files.js'

export type VectorPrecision = 'float32' | 'float16'
export interface VectorIdentity { provider: string; service_url?: string; model: string; revision: string; preprocessing: string; query_preprocessing?: string; dimensions: number; input_hash: string }
export interface VectorReference { vector_id: string; input_hash: string; vector: readonly number[] }
const magic = Buffer.from('LWV1')

// IEEE 754 binary16，最近偶数舍入；只接收有限数值。
function half(value: number): number {
  const sign = value < 0 || Object.is(value, -0) ? 0x8000 : 0, n = Math.abs(value)
  const even = (x: number) => { const floor = Math.floor(x), rest = x - floor; return floor + (rest > 0.5 || rest === 0.5 && floor % 2 ? 1 : 0) }
  if (n < 2 ** -14) return sign | even(n / 2 ** -24)
  const exponent = Math.floor(Math.log2(n)), significand = even(n / 2 ** (exponent - 10))
  const bits = (exponent + 15) * 1024 + significand - 1024
  if (bits >= 0x7c00) throw new Error('向量超出 float16 有限数值范围。')
  return sign | bits
}
function unhalf(bits: number): number {
  const sign = bits & 0x8000 ? -1 : 1, exponent = bits >> 10 & 31, fraction = bits & 1023
  if (exponent === 31) throw new Error('向量含非有限数值。')
  return sign * (exponent ? (1 + fraction / 1024) * 2 ** (exponent - 15) : fraction * 2 ** -24)
}
export function encodeVector(vector: readonly number[], precision: VectorPrecision): Buffer {
  if (!vector.length || vector.some(value => !Number.isFinite(value))) throw new Error('向量为空或含非有限数值。')
  const bytes = Buffer.alloc(vector.length * (precision === 'float16' ? 2 : 4))
  vector.forEach((value, index) => precision === 'float16' ? bytes.writeUInt16LE(half(value), index * 2) : bytes.writeFloatLE(value, index * 4))
  decodeVector(bytes, precision)
  return bytes
}
export function decodeVector(bytes: Buffer, precision: VectorPrecision): number[] {
  const width = precision === 'float16' ? 2 : 4
  if (!bytes.length || bytes.length % width) throw new Error('向量二进制长度无效。')
  const vector = new Array<number>(bytes.length / width)
  for (let i = 0; i < vector.length; i++) {
    const value = precision === 'float16' ? unhalf(bytes.readUInt16LE(i * 2)) : bytes.readFloatLE(i * 4)
    if (!Number.isFinite(value)) throw new Error('向量含非有限数值。')
    vector[i] = value
  }
  return vector
}
export const vectorPath = (id: string): string => {
  if (!/^sha256:[a-f0-9]{64}$/.test(id)) throw new Error('向量 ID 无效。')
  return `objects/vectors/${hashName(id)}.bin`
}
export async function putVector(root: string, identity: VectorIdentity, vector: readonly number[], precision: VectorPrecision): Promise<VectorReference> {
  if (identity.dimensions !== vector.length || !identity.revision || !identity.provider || !identity.model || !identity.preprocessing) throw new Error('向量身份或维数无效。')
  identity = { provider: identity.provider, model: identity.model, revision: identity.revision, preprocessing: identity.preprocessing, ...(identity.query_preprocessing ? { query_preprocessing: identity.query_preprocessing } : {}), dimensions: identity.dimensions, input_hash: identity.input_hash,
    ...(identity.service_url ? { service_url: identity.service_url } : {}) }
  const payload = encodeVector(vector, precision)
  const header = { format_version: 1, identity, precision, checksum: hash(payload) }
  const metadata = Buffer.from(JSON.stringify(header)), prefix = Buffer.alloc(8)
  magic.copy(prefix); prefix.writeUInt32LE(metadata.length, 4)
  // 精度属于编码身份；同一精度下，point ID 和来源不参与去重。
  const id = hash(JSON.stringify([identity, precision]))
  await immutableWrite(root, vectorPath(id), Buffer.concat([prefix, metadata, payload]))
  return { vector_id: id, input_hash: identity.input_hash, vector: decodeVector(payload, precision) }
}
export async function readVector(root: string, id: string): Promise<number[]> {
  return [...(await readVectorRecord(root, id)).vector]
}
export async function readVectorRecord(root: string, id: string) {
  return readVerifiedObject(root, vectorPath(id), id, bytes => parseVector(bytes, id))
}
function parseVector(bytes: Buffer, id: string) {
  if (bytes.length < 8 || !bytes.subarray(0, 4).equals(magic)) throw new Error('向量格式版本无效。')
  const length = bytes.readUInt32LE(4)
  if (length > 16384 || 8 + length >= bytes.length) throw new Error('向量记录头无效。')
  const header = JSON.parse(bytes.subarray(8, 8 + length).toString('utf8')) as { format_version: number; identity: VectorIdentity; precision: VectorPrecision; checksum: string }
  const payload = bytes.subarray(8 + length)
  if (header.format_version !== 1 || !['float32', 'float16'].includes(header.precision) || hash(payload) !== header.checksum
    || hash(JSON.stringify([header.identity, header.precision])) !== id) throw new Error('向量身份或校验和不匹配。')
  const width = header.precision === 'float16' ? 2 : 4
  if (!payload.length || payload.length % width) throw new Error('向量二进制长度无效。')
  // 发布和保留校验只需身份、内容哈希、维数与有限值；按指数位核验，避免分配全部浮点数组。
  for (let offset = 0; offset < payload.length; offset += width) {
    const invalid = width === 2 ? (payload.readUInt16LE(offset) & 0x7c00) === 0x7c00
      : (payload.readUInt32LE(offset) & 0x7f800000) === 0x7f800000
    if (invalid) throw new Error('向量含非有限数值。')
  }
  if (payload.length / width !== header.identity.dimensions) throw new Error('向量维数不匹配。')
  let vector: number[] | undefined
  return { identity: header.identity, precision: header.precision, get vector() { return vector ??= decodeVector(payload, header.precision) } }
}

// 只复制可变主题元数据；向量和质心只读共享，修改数值必须整体替换数组。
export function cloneTopicState(state: TopicState): TopicState {
  const cloned: TopicState = structuredClone({ ...state, vectors: {}, topics: state.topics.map(topic => ({ ...topic, centroid: [] })) })
  cloned.vectors = Object.fromEntries(Object.entries(state.vectors).map(([id, reference]) => [id, { ...reference }]))
  cloned.topics.forEach((topic, index) => { topic.centroid = state.topics[index]!.centroid })
  return cloned
}

// 所有分层 JSON 共用一个持久化边界，禁止把运行时向量和衍生质心写入状态。
export function storageJson(value: unknown): string {
  return JSON.stringify(value, function (key, item) {
    if (key === 'centroid' && 'point_ids' in this && 'parent_id' in this) return undefined
    if (key === 'vector' && Array.isArray(item)) {
      if (item.length && !this.vector_id) throw new Error('向量尚未写入对象库。')
      return undefined
    }
    return item
  }) + '\n'
}
export async function hydrateVectors<T>(root: string, value: T, tolerateMissing = false): Promise<T> {
  const cache = new Map<string, Promise<number[]>>()
  const ids = new Set<string>()
  const collect = (item: unknown): void => {
    if (!item || typeof item !== 'object') return
    const record = item as Record<string, unknown>
    if (typeof record.vector_id === 'string') ids.add(record.vector_id)
    // 页面检索只保存对象引用，按需读取；在这里展开会使后续状态克隆复制整库浮点数组。
    for (const [key, child] of Object.entries(record)) if (key !== 'vector' && key !== 'centroid' && key !== 'page_vectors') collect(child)
  }
  collect(value)
  const unique = [...ids]
  // 先按对象身份去重并有界读取，再按原成员顺序恢复，质心顺序不受 IO 完成顺序影响。
  for (let offset = 0; offset < unique.length; offset += 8) {
    const reads = unique.slice(offset, offset + 8).map(id => {
      const read = readVector(root, id).then(vector => {
        const length = Math.hypot(...vector)
        if (!length) throw new Error('向量长度无效。')
        return vector.map(value => value / length)
      }).catch(error => { if (tolerateMissing && vectorUnavailable(error)) return []; throw error })
      cache.set(id, read)
      return read
    })
    const results = await Promise.allSettled(reads)
    for (const result of results) if (result.status === 'rejected') throw result.reason
  }
  const visit = async (item: unknown): Promise<void> => {
    if (!item || typeof item !== 'object') return
    const record = item as Record<string, unknown>
    if (typeof record.vector_id === 'string') {
      record.vector = await cache.get(record.vector_id)!
    }
    if (typeof record.content_id === 'string') {
      const { readPageObject } = await import('./objects.js')
      record.content = await readPageObject(root, record.content_id)
    }
    for (const [key, child] of Object.entries(record)) if (key !== 'vector' && key !== 'centroid' && key !== 'page_vectors') await visit(child)
    if (Array.isArray(record.topics) && record.vectors) {
      const { refreshTree } = await import('./hierarchy.js')
      refreshTree(record as unknown as import('./schema.js').TopicState)
    }
  }
  await visit(value)
  return value
}

// 仅向量对象缺失或校验失败可降级；权限、磁盘及页面错误继续上抛。
export function vectorUnavailable(error: unknown): boolean {
  return error instanceof SyntaxError || error instanceof Error && ('code' in error ? error.code === 'ENOENT' : /向量|校验和/.test(error.message))
}
