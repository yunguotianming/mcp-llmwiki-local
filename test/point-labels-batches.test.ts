import { afterEach, expect, it, vi } from 'vitest'
import { writeJson } from '../src/layered/files.js'
import { preparePointLabels, pointLabelsPrompt } from '../src/layered/point-labels.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'
import { pointLabelFixture, pointLabelInputBytes, pointLabelResponse, type PointLabelInput } from './point-labels-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('空数组批次只重试一次，第二次成功后正常提交全部要点', async () => {
  const fixture = await pointLabelFixture(2)
  fixture.call.mockResolvedValueOnce(JSON.stringify({ items: [] }))
  expect(await preparePointLabels(fixture.root, fixture.pending, fixture.options)).toEqual({ changed: true, modelCalls: 2 })
  expect(fixture.call).toHaveBeenCalledTimes(2)
  expect(fixture.call.mock.calls[0]![2]).toBe(fixture.call.mock.calls[1]![2])
  expect(Object.keys(fixture.pending.manifest.point_labels!)).toEqual(fixture.points.map(point => point.point_id))
  expect(fixture.pending.manifest.point_label_gaps).toEqual([])
})

it('空文本后仍返回空数组时不进行第三次调用，并保存整批缺口', async () => {
  const fixture = await pointLabelFixture(2)
  fixture.call.mockResolvedValueOnce(' \n ').mockResolvedValueOnce(JSON.stringify({ items: [] }))
  expect(await preparePointLabels(fixture.root, fixture.pending, fixture.options)).toEqual({ changed: true, modelCalls: 2 })
  expect(fixture.call).toHaveBeenCalledTimes(2)
  expect(fixture.pending.manifest.point_labels).toEqual({})
  expect(fixture.pending.manifest.point_label_gaps).toEqual([{
    source_id: fixture.source.source_id, point_ids: fixture.points.map(point => point.point_id),
    message: '要点补标连续两次返回空结果，已保留缺口供后续重试。',
  }])
})

it('模型异常和批协议错误不作为空结果重试，其他批次仍可提交', async () => {
  const fixture = await pointLabelFixture(201)
  vi.spyOn(fixture.client, 'concurrency').mockReturnValue(3)
  vi.spyOn(fixture.client, 'inputBudget').mockResolvedValue(1000000)
  fixture.options.topics = { extractMaxInputBytes: 1000000 }
  fixture.call.mockImplementation(async (_task, _system, raw) => {
    const input = JSON.parse(raw) as PointLabelInput
    if (input.points[0]!.text === fixture.points[0]!.text) throw new Error('合成模型故障')
    if (input.points[0]!.text === fixture.points[100]!.text) return JSON.stringify({ items: '无效批协议' })
    return pointLabelResponse(input)
  })
  expect(await preparePointLabels(fixture.root, fixture.pending, fixture.options)).toEqual({ changed: true, modelCalls: 3 })
  expect(fixture.call).toHaveBeenCalledTimes(3)
  expect(Object.keys(fixture.pending.manifest.point_labels!)).toEqual([fixture.points[200]!.point_id])
  expect(fixture.pending.manifest.point_label_gaps).toHaveLength(2)
  expect(fixture.pending.manifest.point_label_gaps!.flatMap(gap => gap.point_ids)).toEqual(fixture.points.slice(0, 200).map(point => point.point_id))
})

it('单个大来源按一百条拆批，批间共用并发上限且短编号逐批重置', async () => {
  const fixture = await pointLabelFixture(251)
  vi.spyOn(fixture.client, 'concurrency').mockReturnValue(3)
  vi.spyOn(fixture.client, 'inputBudget').mockResolvedValue(1000000)
  fixture.options.topics = { extractMaxInputBytes: 1000000 }
  let active = 0, peak = 0
  fixture.call.mockImplementation(async (_task, _system, raw) => {
    active++; peak = Math.max(peak, active)
    try {
      await new Promise<void>(resolve => setImmediate(resolve))
      return pointLabelResponse(JSON.parse(raw) as PointLabelInput)
    } finally { active-- }
  })
  expect(await preparePointLabels(fixture.root, fixture.pending, fixture.options)).toEqual({ changed: true, modelCalls: 3 })
  const inputs = fixture.call.mock.calls.map(args => JSON.parse(args[2]) as PointLabelInput)
  expect(inputs.map(input => input.points.length)).toEqual([100, 100, 51])
  expect(inputs.map(input => input.points[0]!.point_id)).toEqual(['P1', 'P1', 'P1'])
  expect(inputs.every(input => input.points.every(point => /^P\d+$/.test(point.point_id)))).toBe(true)
  expect(peak).toBe(3)
  expect(Object.keys(fixture.pending.manifest.point_labels!)).toEqual(fixture.points.map(point => point.point_id))
  expect(fixture.pending.manifest.point_label_gaps).toEqual([])
})

it('条数未超限仍遵守调用、设置和客户端三种字节预算，单项超限只留该项缺口', async () => {
  const fixture = await pointLabelFixture(5)
  const limit = pointLabelInputBytes(fixture.source.source_id, fixture.points.slice(0, 2))
  fixture.points[2]!.text = '超长要点'.repeat(limit)
  await writeJson(fixture.root, fixture.source.extract.path, fixture.extraction)
  const budget = vi.spyOn(fixture.client, 'inputBudget')
  for (const winner of ['option', 'settings', 'client'] as const) {
    fixture.pending.manifest.point_labels = {}
    fixture.pending.manifest.point_label_gaps = []
    fixture.call.mockClear()
    fixture.options.maxInputBytes = winner === 'option' ? limit : limit + 1000
    fixture.options.topics = { extractMaxInputBytes: winner === 'settings' ? limit : limit + 1000 }
    budget.mockResolvedValue(winner === 'client' ? limit : limit + 1000)
    expect(await preparePointLabels(fixture.root, fixture.pending, fixture.options)).toEqual({ changed: true, modelCalls: 2 })
    const inputs = fixture.call.mock.calls.map(args => JSON.parse(args[2]) as PointLabelInput)
    expect(inputs.map(input => input.points.length)).toEqual([2, 2])
    expect(fixture.call.mock.calls.every(args => Buffer.byteLength(pointLabelsPrompt + args[2]) <= limit)).toBe(true)
    expect(Object.keys(fixture.pending.manifest.point_labels!)).toEqual(fixture.points.filter((_, index) => index !== 2).map(point => point.point_id))
    expect(fixture.pending.manifest.point_label_gaps!.flatMap(gap => gap.point_ids)).toEqual([fixture.points[2]!.point_id])
    expect(fixture.pending.manifest.point_label_gaps![0]!.message).toContain('超过预算')
  }
})
