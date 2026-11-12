import { evidenceBlockIds } from '../../src/layered/anchors.js'
import { hash } from '../../src/layered/files.js'
import type { TopicEvidenceSource } from '../../src/layered/topic-metadata.js'
import type { Point } from '../../src/layered/schema.js'

// 按任务给出的句号与行号构造合成反例，不将未提供的现场日志冒充为实测夹具。
function member(sourceId: string, text: string, locator = 'L1-L1', quote = text): Point {
  return { point_id: sourceId + ':synthetic', text, section: '主要发现', text_hash: hash(text),
    locator, source_version: 'v1', evidence: [{ source_id: sourceId, source_version: 'v1', locator, quote }] }
}

function evidenceLink(point: Point): string {
  const anchor = evidenceBlockIds([point]).get(point.point_id)![0]!
  return `[${point.evidence[0]!.source_id}](../sources/${point.evidence[0]!.source_id}.md#^${anchor})`
}

export function referentialTopicFixture() {
  const members = [
    member('S-0001', '研究甲（2023）报告随访设计，未证明治疗具有普遍因果效果。'),
    member('S-0002', '研究乙（2024）报告访谈设计，未报告随访疗效。'),
  ]
  const firstLink = evidenceLink(members[0]!), secondLink = evidenceLink(members[1]!)
  const priorText = `- 研究乙（2024）报告访谈设计；研究甲（2023）报告随访设计。 ${secondLink}；${firstLink}`
  const dependentText = `- 该研究的随访结果适用于全部家庭。 ${firstLink}`
  const content = [
    '---', 'id: T-0003-02-01', 'title: 合成研究比较', 'aliases: []', 'sources: [S-0001, S-0002]', '---',
    '# 合成研究比较', '范围：比较研究设计。', '## 适用条件', priorText,
    ...[3, 4, 5, 6].map(number => `- 应删除的过度推断${number}。 ${firstLink}`),
    `- 研究甲（2023）已证明治疗具有普遍因果效果。 ${firstLink}`,
    dependentText, '## 来源导航',
    '- [研究甲](../sources/S-0001.md)', '- [研究乙](../sources/S-0002.md)', '',
  ].join('\n')
  return { content, members, priorText, dependentText, rejectedIds: new Set(['S3', 'S4', 'S5', 'S6', 'S7']) }
}

export function fullSentenceTopicFixture() {
  const fullSentence = [
    'In the synthetic family-interview study,',
    'after the first interviews and the follow-up discussions,',
    'and with participants describing their daily circumstances,',
    'while comparing the support available at home,',
    'and considering the practical demands of recovery,',
    'families said that regular visits mattered to them',
    'during recovery.',
  ].join('\r\n')
  const paragraph = fullSentence + ' Another study reported a different outcome.'
  const prefix = '\r\n'.repeat(221), text = prefix + paragraph
  const quote = 'regular visits mattered to them'
  const point = member('S-0012', '合成家庭访谈（2024）的受访家庭表示，常规探访在康复期间对他们很重要。', 'L227-L227', quote)
  const source: TopicEvidenceSource = {
    title: '合成家庭访谈（2024）', source_version: 'v1', text,
    segments: [{ start: prefix.length, end: text.length, locator: 'L222-L228', text_hash: hash(paragraph) }],
  }
  return { fullSentence, quote, point, source, sources: new Map([['S-0012', source]]), link: evidenceLink(point) }
}
