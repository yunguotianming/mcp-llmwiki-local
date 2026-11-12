// 部分改编自 obsidian-llm-wiki（Apache-2.0），已修改。来源及版权见 THIRD_PARTY_NOTICES.md。
import type { Extraction } from './schema.js'
import { coveragePurpose } from './longdoc.js'

export function sourceOverview(extraction: Extraction, anchors: Map<string, string[]>): string {
  const limits = extraction.overview_limits ?? { chinese: 240, english: 120 }
  const selected: string[] = [], used = new Map<string, number>()
  let chinese = 0, english = 0
  const candidates = extraction.segments.flatMap((segment, index) => segment.points.filter(point => point.verification?.status !== 'unverified'
    && coveragePurpose(extraction.chapters?.find(chapter => chapter.paragraph_ids.includes(index))?.title ?? '', point.text) === '研究内容')
    .map(point => ({ point, chapter: extraction.chapters?.find(chapter => chapter.paragraph_ids.includes(index))?.id ?? '正文' })))
  const rank = (section: string) => section === '主要发现' ? 0 : section === '方法' ? 1 : section === '限制' ? 2 : 3
  let changed = true
  while (candidates.length) {
    const usage = (chapter: string, section: string) => used.get(rank(section) + ':' + chapter) ?? 0
    // 预算拒收不会改变章节计数，余项已按同一比较器稳定有序；只有入选后才需重排。
    if (changed) candidates.sort((a, b) => rank(a.point.section) - rank(b.point.section) || usage(a.chapter, a.point.section) - usage(b.chapter, b.point.section))
    changed = false
    const { point, chapter } = candidates.shift()!
    const chars = (point.text.match(/\p{Script=Han}/gu) ?? []).length
    const words = (point.text.replace(/\p{Script=Han}/gu, ' ').match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu) ?? []).length
    if (chinese + chars > limits.chinese || english + words > limits.english) continue
    chinese += chars; english += words; used.set(rank(point.section) + ':' + chapter, usage(chapter, point.section) + 1)
    changed = true
    selected.push(`- ${point.text} [证据](#^${anchors.get(point.point_id)![0]})`)
  }
  return selected.join('\n') || '暂无适合概览的已核实要点。'
}
