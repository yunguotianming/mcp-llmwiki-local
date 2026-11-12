import { createHash } from 'node:crypto'
import { hash } from './files.js'
import { normalized } from './embedding.js'
import { putVector } from './vectors.js'
import type { EmbeddingIdentity, Point, PointLabels, TopicState } from './schema.js'

export const lexicalModel = 'lexical-bigram-tfidf-v1'
export const lexicalDimensions = 2048
const stopwords = new Set('a an and are as at be been being but by can could did do does for from had has have he her here him his how i if in into is it its may more most no not of on or our she should so some than that the their them then there these they this those to too was we were what when where which who will with would you your'.split(' '))
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0

export function lexicalTerms(text: string): string[] {
  const terms: string[] = []
  for (const match of text.normalize('NFKC').toLowerCase().matchAll(/\p{Script=Han}+|[a-z0-9]+(?:'[a-z]+)?/gu)) {
    const word = match[0]
    if (/\p{Script=Han}/u.test(word)) {
      const chars = [...word]
      for (let i = 1; i < chars.length; i++) terms.push(chars[i - 1]! + chars[i]!)
    } else if (!stopwords.has(word)) terms.push(word)
  }
  return terms
}

type LexicalPoint = Pick<Point, 'point_id' | 'text'>
type Labels = Record<string, Pick<PointLabels, 'labels' | 'keywords'>>

function termFrequencies(point: LexicalPoint, labels: Labels): [string, number][] {
  const counts = new Map<string, number>()
  const add = (text: string, weight: number) => {
    for (const term of lexicalTerms(text)) counts.set(term, (counts.get(term) ?? 0) + weight)
  }
  add(point.text, 1)
  for (const label of labels[point.point_id]?.labels ?? []) add(label, 3)
  for (const keyword of labels[point.point_id]?.keywords ?? []) add(keyword, 2)
  // 全停用词、单汉字或符号要点以规范化全文作独立词项，避免零向量。
  if (!counts.size) counts.set('empty:' + point.text.normalize('NFKC').toLowerCase(), 1)
  return [...counts].sort(([a], [b]) => order(a, b))
}

export const lexicalInputHash = (point: LexicalPoint, labels: Labels = {}) => hash(JSON.stringify([point.text, termFrequencies(point, labels)]))

// 词频用整数累加，词项、文档和坐标均按固定顺序处理；补标返回顺序不影响字节。
export function lexicalCorpus(points: LexicalPoint[], labels: Labels = {}) {
  const documents = [...points].sort((a, b) => order(a.point_id, b.point_id)).map(point => ({ point, terms: termFrequencies(point, labels) }))
  const frequencies = new Map<string, number>()
  for (const { terms } of documents) for (const [term] of terms) frequencies.set(term, (frequencies.get(term) ?? 0) + 1)
  // IDF 与补标都是向量身份的一部分；语料变化必须使全库词项对象和质心失效。
  const identity: EmbeddingIdentity = { provider: 'lexical', model: lexicalModel,
    revision: hash(JSON.stringify(documents.map(({ point, terms }) => [point.point_id, terms]))),
    dimensions: lexicalDimensions, precision: 'float32', document_preprocessing: lexicalModel, query_preprocessing: 'disabled-v1' }
  const vectors: TopicState['vectors'] = {}
  for (const { point, terms } of documents) {
    const vector = Array<number>(lexicalDimensions).fill(0)
    for (const [term, frequency] of terms) {
      const digest = createHash('sha256').update(term, 'utf8').digest()
      const coordinate = digest.readUInt32LE(0) % lexicalDimensions
      vector[coordinate]! += (1 + Math.log(frequency)) * (1 + Math.log((1 + documents.length) / (1 + frequencies.get(term)!)))
    }
    // 本地计算先作 L2 归一化；对象持久化按固定 float32 编码。
    vectors[point.point_id] = { input_hash: hash(JSON.stringify([point.text, terms])), vector: normalized(vector) }
  }
  return { identity, vectors }
}

export async function persistLexicalVectors(root: string, corpus: ReturnType<typeof lexicalCorpus>, signal?: AbortSignal): Promise<TopicState['vectors']> {
  const vectors: TopicState['vectors'] = {}
  for (const [id, reference] of Object.entries(corpus.vectors)) {
    signal?.throwIfAborted()
    const identity = corpus.identity
    const stored = await putVector(root, { provider: identity.provider, model: identity.model, revision: identity.revision,
      dimensions: identity.dimensions, preprocessing: identity.document_preprocessing, query_preprocessing: identity.query_preprocessing,
      input_hash: reference.input_hash }, reference.vector, identity.precision)
    vectors[id] = { ...stored, vector: normalized(stored.vector) }
  }
  return vectors
}
