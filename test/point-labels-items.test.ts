import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as files from '../src/layered/files.js'
import { preparePointLabels } from '../src/layered/point-labels.js'
import type { PendingBuild } from '../src/layered/schema.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'
import { pointLabelFixture, pointLabelResponse, type PointLabelInput } from './point-labels-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('补标只接受调用内短编号，未知短编号和持久化长编号均不得回退映射', async () => {
  const fixture = await pointLabelFixture(3)
  fixture.call.mockImplementation(async (_task, _system, raw) => {
    const input = JSON.parse(raw) as PointLabelInput
    expect(input.points.map(point => point.point_id)).toEqual(['P1', 'P2', 'P3'])
    expect(raw).not.toContain(fixture.points[0]!.point_id)
    return JSON.stringify({ items: [
      { point_id: fixture.points[0]!.point_id, labels: ['拒绝长编号'], keywords: ['拒绝映射'] },
      { point_id: 'P999', labels: ['拒绝未知编号'], keywords: ['拒绝映射'] },
      ...JSON.parse(pointLabelResponse(input)).items.slice(1),
    ] })
  })
  expect(await preparePointLabels(fixture.root, fixture.pending, fixture.options)).toEqual({ changed: true, modelCalls: 1 })
  expect(Object.keys(fixture.pending.manifest.point_labels!)).toEqual(fixture.points.slice(1).map(point => point.point_id))
  expect(fixture.pending.manifest.point_label_gaps!.flatMap(gap => gap.point_ids)).toEqual([fixture.points[0]!.point_id])
  expect(fixture.pending.manifest.point_label_gaps!.some(gap => gap.message.includes('未知或缺失短编号'))).toBe(true)
  expect(fixture.call).toHaveBeenCalledTimes(1)
})

it('M18 单项坏记录只留下该项缺口，后续合法项逐项持久化且模型只调用一次', async () => {
  const fixture = await pointLabelFixture(), checkpointCounts: number[] = []
  const originalWrite = files.writeJson
  vi.spyOn(files, 'writeJson').mockImplementation(async (...args) => {
    await originalWrite(...args)
    if (args[1] === 'work/pending.json') checkpointCounts.push(Object.keys((args[2] as PendingBuild).manifest.point_labels ?? {}).length)
  })
  fixture.call.mockImplementation(async (_task, _system, raw) => {
    const input = JSON.parse(raw) as PointLabelInput
    return JSON.stringify({ items: input.points.map((point, index) => ({
      point_id: point.point_id, labels: index === 0 ? [] : ['合法主题'], keywords: ['研究结果'],
    })) })
  })
  await preparePointLabels(fixture.root, fixture.pending, fixture.options)
  expect(Object.keys(fixture.pending.manifest.point_labels!)).toEqual(fixture.points.slice(1).map(point => point.point_id))
  expect(fixture.pending.manifest.point_label_gaps!.flatMap(gap => gap.point_ids)).toEqual([fixture.points[0]!.point_id])
  expect(checkpointCounts).toEqual([0, 1, 2, 3, 3])
  const saved = JSON.parse(await readFile(path.join(fixture.root, 'work/pending.json'), 'utf8')) as PendingBuild
  expect(saved.manifest.point_labels).toEqual(fixture.pending.manifest.point_labels)
  expect(saved.manifest.point_label_gaps).toEqual(fixture.pending.manifest.point_label_gaps)
  expect(fixture.call).toHaveBeenCalledTimes(1)
})

it('重复、遗漏及额外字段分别拒绝，不连带拒绝同批合法要点', async () => {
  const fixture = await pointLabelFixture(5)
  fixture.call.mockImplementation(async (_task, _system, raw) => {
    const input = JSON.parse(raw) as PointLabelInput
    const items = JSON.parse(pointLabelResponse(input)).items
    return JSON.stringify({ items: [items[0], items[0], { ...items[2], extra: '不允许的字段' }, items[4], items[3]] })
  })
  await preparePointLabels(fixture.root, fixture.pending, fixture.options)
  expect(Object.keys(fixture.pending.manifest.point_labels!)).toEqual(fixture.points.slice(3).map(point => point.point_id))
  expect(fixture.pending.manifest.point_label_gaps!.flatMap(gap => gap.point_ids)).toEqual(fixture.points.slice(0, 3).map(point => point.point_id))
  expect(fixture.call).toHaveBeenCalledTimes(1)
})

it('关键词超限保留原返回顺序的前十二项，留痕跨缓存复用保留且不修改提取事实', async () => {
  const fixture = await pointLabelFixture(2)
  const originalExtraction = await readFile(path.join(fixture.root, fixture.source.extract.path), 'utf8')
  const keywords = Array.from({ length: 15 }, (_, index) => `关键词${String(15 - index).padStart(2, '0')}`)
  fixture.call.mockImplementation(async (_task, _system, raw) => {
    const input = JSON.parse(raw) as PointLabelInput
    return JSON.stringify({ items: input.points.map((point, index) => ({
      point_id: point.point_id, labels: ['合法主题'], keywords: index === 0 ? keywords : ['研究结果'],
    })) })
  })
  expect(await preparePointLabels(fixture.root, fixture.pending, fixture.options)).toEqual({ changed: true, modelCalls: 1 })
  const saved = fixture.pending.manifest.point_labels![fixture.points[0]!.point_id]!
  expect(saved.keywords).toEqual(keywords.slice(0, 12).sort())
  expect(saved.keyword_truncation).toEqual({ received: 15, retained: 12 })
  expect(fixture.pending.manifest.point_label_gaps).toEqual([{
    source_id: fixture.source.source_id, point_ids: [fixture.points[0]!.point_id],
    message: '要点补标返回 15 个关键词，已保留前 12 个；未修改提取事实。',
  }])
  const prior = structuredClone(fixture.pending.manifest)
  fixture.call.mockClear()
  expect(await preparePointLabels(fixture.root, fixture.pending, fixture.options)).toEqual({ changed: false, modelCalls: 0 })
  expect(fixture.pending.manifest).toEqual(prior)
  expect(fixture.call).not.toHaveBeenCalled()
  expect(await readFile(path.join(fixture.root, fixture.source.extract.path), 'utf8')).toBe(originalExtraction)
})

it('单项失败后仅补该项，单项新调用从 P1 重新映射且保留已提交结果', async () => {
  const fixture = await pointLabelFixture()
  fixture.call.mockImplementation(async (_task, _system, raw) => {
    const input = JSON.parse(raw) as PointLabelInput
    return JSON.stringify({ items: input.points.map((point, index) => ({
      point_id: point.point_id, labels: index === 2 ? [] : ['合法主题'], keywords: ['研究结果'],
    })) })
  })
  await preparePointLabels(fixture.root, fixture.pending, fixture.options)
  const prior = structuredClone(fixture.pending.manifest.point_labels)
  fixture.call.mockClear()
  fixture.call.mockImplementation(async (_task, _system, raw) => pointLabelResponse(JSON.parse(raw) as PointLabelInput))
  // 普通生成保留已登记缺口、零调用；显式重试缺口才只补该项。
  expect(await preparePointLabels(fixture.root, fixture.pending, fixture.options)).toEqual({ changed: false, modelCalls: 0 })
  expect(fixture.pending.manifest.point_label_gaps).toHaveLength(1)
  expect(await preparePointLabels(fixture.root, fixture.pending, { ...fixture.options, retryGaps: true })).toEqual({ changed: true, modelCalls: 1 })
  const input = JSON.parse(fixture.call.mock.calls[0]![2]) as PointLabelInput
  expect(input.points).toEqual([{ point_id: 'P1', text: fixture.points[2]!.text, section: fixture.points[2]!.section }])
  expect(Object.keys(fixture.pending.manifest.point_labels!)).toEqual(fixture.points.map(point => point.point_id))
  expect(fixture.pending.manifest.point_label_gaps).toEqual([])
  for (const [pointId, value] of Object.entries(prior!)) expect(fixture.pending.manifest.point_labels![pointId]).toEqual(value)
})
