import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import * as files from '../src/layered/files.js'
import { preparePointLabels } from '../src/layered/point-labels.js'
import type { PendingBuild } from '../src/layered/schema.js'
import { cleanupLayeredFixtures } from './layered-fixture.js'
import { pointLabelFixture, pointLabelInputBytes, pointLabelResponse, type PointLabelInput } from './point-labels-fixture.js'

vi.mock('node:fs/promises', async original => ({ ...await original<typeof import('node:fs/promises')>() }))
afterEach(cleanupLayeredFixtures)

it('三十、三和一并发下补标产物确定，缓存复用不调用模型且不改变提取成果', async () => {
  const fixture = await pointLabelFixture(9)
  const concurrency = vi.spyOn(fixture.client, 'concurrency')
  // 三个完整批次验证并发确定性；百项边界由 batches 专项覆盖，避免重复大文件压力。
  const budget = pointLabelInputBytes(fixture.source.source_id, fixture.points.slice(0, 3))
  vi.spyOn(fixture.client, 'inputBudget').mockResolvedValue(budget)
  fixture.options.topics = { extractMaxInputBytes: budget }
  fixture.call.mockImplementation(async (_task, _system, raw) => {
    await new Promise<void>(resolve => setImmediate(resolve))
    const response = JSON.parse(pointLabelResponse(JSON.parse(raw) as PointLabelInput))
    return JSON.stringify({ items: response.items.reverse() })
  })
  const originalExtraction = await readFile(path.join(fixture.root, fixture.source.extract.path), 'utf8')
  let baseline: unknown
  for (const limit of [30, 3, 1]) {
    concurrency.mockReturnValue(limit)
    fixture.pending.manifest.point_labels = {}
    fixture.pending.manifest.point_label_gaps = []
    fixture.call.mockClear()
    expect(await preparePointLabels(fixture.root, fixture.pending, fixture.options)).toEqual({ changed: true, modelCalls: 3 })
    expect(fixture.call).toHaveBeenCalledTimes(3)
    const products = structuredClone({ labels: fixture.pending.manifest.point_labels, gaps: fixture.pending.manifest.point_label_gaps })
    if (baseline === undefined) baseline = products
    else expect(products).toEqual(baseline)
    fixture.call.mockClear()
    expect(await preparePointLabels(fixture.root, fixture.pending, fixture.options)).toEqual({ changed: false, modelCalls: 0 })
    expect(fixture.call).not.toHaveBeenCalled()
    expect(await readFile(path.join(fixture.root, fixture.source.extract.path), 'utf8')).toBe(originalExtraction)
  }
})

it('逐项提交中的存储失败向上传播，不吞成模型缺口且已提交记录仍在磁盘', async () => {
  const fixture = await pointLabelFixture(3)
  const originalWrite = files.writeJson
  const storageError = Object.assign(new Error('合成检查点写入故障'), { storageFailure: true })
  let checkpoints = 0
  vi.spyOn(files, 'writeJson').mockImplementation(async (...args) => {
    if (args[1] === 'work/pending.json' && ++checkpoints === 2) throw storageError
    await originalWrite(...args)
  })
  await expect(preparePointLabels(fixture.root, fixture.pending, fixture.options)).rejects.toBe(storageError)
  const saved = JSON.parse(await readFile(path.join(fixture.root, 'work/pending.json'), 'utf8')) as PendingBuild
  expect(Object.keys(saved.manifest.point_labels!)).toEqual([fixture.points[0]!.point_id])
  expect(saved.manifest.point_label_gaps).toEqual([])
  expect(fixture.call).toHaveBeenCalledTimes(1)
})

it('取消信号不作为普通补标失败吞掉，也不重试或伪造缺口', async () => {
  const fixture = await pointLabelFixture()
  const controller = new AbortController(), reason = new Error('合成取消')
  fixture.options.signal = controller.signal
  fixture.call.mockImplementation(async () => {
    controller.abort(reason)
    throw reason
  })
  await expect(preparePointLabels(fixture.root, fixture.pending, fixture.options)).rejects.toBe(reason)
  expect(fixture.call).toHaveBeenCalledTimes(1)
  expect(fixture.pending.manifest.point_labels).toEqual({})
  expect(fixture.pending.manifest.point_label_gaps).toEqual([])
})

it('补标只记录成功备用的实际作者，缺少回执时保留未知而不查询当前主模型', async () => {
  const fixture = await pointLabelFixture(1), info = vi.spyOn(fixture.client, 'info')
  vi.spyOn(fixture.client, 'inputBudget').mockResolvedValue(100000)
  fixture.call.mockImplementation(async (_task, _system, input, _signal, _images, options) => {
    options?.onAttempt?.({ finish: 'stop', error: '被拒绝', route: { provider: '主线', model: '错误模型' } } as any)
    options?.onAttempt?.({ finish: 'stop', route: { provider: '备用', model: '实际模型' } } as any)
    return pointLabelResponse(JSON.parse(input))
  })
  await preparePointLabels(fixture.root, fixture.pending, fixture.options)
  expect(Object.values(fixture.pending.manifest.point_labels!)[0]?.model).toBe('备用/实际模型')
  fixture.pending.manifest.point_labels = {}
  fixture.call.mockImplementation(async (_task, _system, input) => pointLabelResponse(JSON.parse(input)))
  info.mockClear()
  await preparePointLabels(fixture.root, fixture.pending, fixture.options)
  expect(Object.values(fixture.pending.manifest.point_labels!)[0]?.model).toBe('')
  expect(info).not.toHaveBeenCalled()
})
