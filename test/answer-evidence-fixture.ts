import { signature } from '../src/storage/files.js'
import type { AnswerEvidenceHit, AnswerEvidencePage } from '../src/wiki/answer-evidence.js'

export function evidenceHit(path: string, texts: string[], sourceVersions: AnswerEvidenceHit['sourceVersions'] = [], title = path): AnswerEvidenceHit {
  const excerpts = texts.map((content, index) => ({ library: '夹具库', path, title, content, quote_hash: signature(content), tokens: Buffer.byteLength(content),
    anchor: `^p${index}`, locator: `L${index + 1}-L${index + 1}`, segments: [{ start: 0, end: content.length, anchor: `^p${index}`, locator: `L${index + 1}-L${index + 1}`,
      contextLocator: `L${index + 1}-L${index + 1}`, truncated: false, unverified: false }] }))
  return { path, title, version: 'v000001', sourceVersions, snippet: texts[0] ?? '', snippetSegments: excerpts[0]?.segments ?? [], anchor: '^p0', excerpts }
}
export function sourcePage(sourceId: string, content: string, title = '甲研究'): AnswerEvidencePage {
  return { path: `sources/${sourceId}.md`, title, content, status: 'ok', currentVersion: 'v000001', sourceVersions: [{ sourceId, sourceVersion: 'sha256:test' }], truncated: false }
}
