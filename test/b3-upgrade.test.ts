import { readFile, readdir, unlink } from 'node:fs/promises'
import { expect, it, vi } from 'vitest'
import { safePath } from '../src/storage/paths.js'
import { readVersion, versionPage } from '../src/layered/objects.js'
import { initializeLibrary } from '../src/layered/publication.js'
import { readProvenance, protocolDigest, writeProtocol } from '../src/layered/models.js'
import { upgradeLibrary, readUpgradeStatus, restoreUpgradeBackup, verifyUpgradeBackup } from '../src/layered/upgrade.js'
import type { UpgradeStep } from '../src/layered/upgrade.js'
import { hash } from '../src/layered/files.js'
import { storageJson } from '../src/layered/vectors.js'
import { identity, legacyFixture, prepare } from './b3-fixture.js'

const step: UpgradeStep = { id: '必需元数据', kind: 'metadata', stage: 'extract', unitIds: ['库'], inputDigest: hash('库标题'), estimatedInputTokens: 100, maxOutputTokens: 20 }
it('0.2.0 只读不升级，首次初始化写入前备份，原清单和旧成果原字节复用', async () => {
  const f = await legacyFixture('0.2.0'), before = await readdir(f.root, { recursive: true })
  const text = await versionPage(f.root, await readVersion(f.root, 'v000001'), 'sources/S-0001.md')
  expect(await readdir(f.root, { recursive: true })).toEqual(before)
  expect(await readUpgradeStatus(f.root)).toBeUndefined()
  await initializeLibrary(f.parent, f.manifest.card!, undefined, undefined, f.root)
  const state = (await readUpgradeStatus(f.root))!
  expect(state).toMatchObject({ status: 'complete', actual: { calls: 0 }, estimate: { calls: 0 }, reuseRates: { extraction: 1, page: 1 } })
  expect((await verifyUpgradeBackup(state.backupPath)).complete).toBe(true)
  expect(await readFile(await safePath(f.root, 'versions/v000001.json'))).toEqual(f.original)
  expect(await versionPage(f.root, await readVersion(f.root, 'v000001'), 'sources/S-0001.md')).toBe(text)
  const provenance = await readProvenance(f.root, 'v000001', hash(storageJson(f.manifest)))
  expect(Object.values(provenance.artifacts).find(a => a.kind === 'extraction')).toMatchObject({ status: 'unknown', reason: 'legacy-library', productionIds: [] })
  expect(await readFile(await safePath(f.root, 'logs/build.md'), 'utf8')).toContain(state.backupPath)
}, 20000)

it('0.2.1 分区布局可选上限预检暂停，补齐只处理清单且新生产归属完整', async () => {
  const f = await legacyFixture('0.2.1', true), snapshots: string[] = []
  const runStep = vi.fn(async (planned, context) => {
    const accepted = await prepare(context.root, { identity: { ...identity(planned.id), inputDigest: planned.inputDigest }, hooks: context.hooks, run: context.runId })
    return accepted.commit()
  })
  const paused = await upgradeLibrary(f.root, { steps: [step], upgrade: { maxCalls: 0 }, runStep, onStatus: status => { snapshots.push(status.status) } })
  expect(paused).toMatchObject({ status: 'paused', estimate: { calls: 1, inputTokens: 100, outputTokens: 20 } })
  expect(runStep).not.toHaveBeenCalled()
  expect((await upgradeLibrary(f.root, { runStep }))?.limits).toEqual({ maxCalls: 0 })
  expect(runStep).not.toHaveBeenCalled()
  expect(JSON.parse(await readFile(await safePath(f.root, '.llmwiki/policy.json'), 'utf8')).libraryFormat).toBeUndefined()
  const done = await upgradeLibrary(f.root, { upgrade: { maxCalls: 1, maxTokens: 120 }, runStep })
  expect(done).toMatchObject({ status: 'complete', actual: { calls: 1, tokens: 17 } })
  expect(runStep).toHaveBeenCalledTimes(1)
  const provenance = await readProvenance(f.root, 'v000001', hash(storageJson(f.manifest)))
  expect(Object.values(provenance.artifacts).find(a => a.kind === 'metadata')).toMatchObject({ status: 'recorded' })
  expect(Object.values(provenance.records)[0]).toMatchObject({ requestedModel: '备用模型' })
  expect(await readFile(await safePath(f.root, 'versions/v000001.json'))).toEqual(f.original)
}, 20000)

it('备份后与接受后中断可重入，同一升级保留预算和备份且接受结果不重复调用', async () => {
  const f = await legacyFixture('0.2.1'), options = { steps: [step], upgrade: { maxCalls: 1 }, onStatus: (status: any) => { if (status.backupPath) throw new Error('备份后中断') } }
  await expect(upgradeLibrary(f.root, options)).rejects.toThrow('备份后中断')
  const first = (await readUpgradeStatus(f.root))!
  // 模拟备份完成但检查点丢失，重入必须从备份元数据找回同一升级。
  await unlink(await safePath(f.root, 'work/upgrade-0.3.0.json'))
  const runStep = vi.fn(async (planned, context) => {
    const id = { ...identity(planned.id), inputDigest: planned.inputDigest }, taskId = 't:' + protocolDigest(id).slice(7)
    const saved = await context.hooks.readAcceptance(taskId)
    if (saved.status === 'bound') return { taskId, path: `work/accepted/tasks/${taskId.slice(2)}.json`, digest: saved.acceptedDigest! }
    const accepted = await prepare(context.root, { identity: id, hooks: context.hooks, run: context.runId })
    const ref = await accepted.commit()
    throw Object.assign(new Error('接受后中断'), { ref })
  })
  await expect(upgradeLibrary(f.root, { steps: [step], upgrade: { maxCalls: 1 }, runStep })).rejects.toThrow('接受后中断')
  const middle = (await readUpgradeStatus(f.root))!
  expect(middle.backupPath).toBe(first.backupPath)
  // 恢复已接受任务不应按尚未完成的预计调用再次预占额度。
  const done = await upgradeLibrary(f.root, { upgrade: { maxCalls: 1 }, runStep })
  expect(done?.status).toBe('complete')
  expect(done?.actual.calls).toBe(1)
  expect((await readdir(f.parent)).filter(name => name.includes('.backup-before-'))).toHaveLength(1)
}, 20000)

it('格式提交后附属缺失明确拒绝，备份校验与整体恢复保留失败现场', async () => {
  const f = await legacyFixture('0.2.0'), done = (await upgradeLibrary(f.root))!
  await unlink(await safePath(f.root, 'versions/v000001.provenance.json'))
  await expect(readVersion(f.root, 'v000001')).rejects.toMatchObject({ code: 'PROVENANCE_INCOMPLETE' })
  const failed = await restoreUpgradeBackup(f.root, done.backupPath)
  expect(await readFile(await safePath(f.root, 'versions/v000001.json'))).toEqual(f.original)
  expect(JSON.parse(await readFile(await safePath(f.root, '.llmwiki/policy.json'), 'utf8')).libraryFormat).toBeUndefined()
  expect((await readdir(failed)).length).toBeGreaterThan(0)
  expect((await verifyUpgradeBackup(done.backupPath)).complete).toBe(true)
})

it('准备快照提交前中断在耗尽预算下离线绑定，禁止恢复回调重新派发', async () => {
  const f = await legacyFixture()
  const runStep = vi.fn(async (planned, context) => {
    const id = { ...identity(planned.id), inputDigest: planned.inputDigest }, taskId = 't:' + protocolDigest(id).slice(7)
    if (context.replayOnly) {
      expect((await context.hooks.beforeAttempt({} as any)).status).toBe('paused')
      const saved = await context.hooks.readAcceptance(taskId)
      if (saved.status !== 'prepared') throw new Error('缺少准备快照')
      const digest = protocolDigest(saved.record), file = `work/accepted/tasks/${taskId.slice(2)}.json`
      await writeProtocol(context.root, file, { ...saved.record, acceptedDigest: digest })
      await context.hooks.onAccepted({ taskId, prepareId: saved.prepareId, acceptedDigest: digest })
      return { taskId, path: file, digest }
    }
    await prepare(context.root, { identity: id, hooks: context.hooks, run: context.runId })
    throw new Error('准备后中断')
  })
  await expect(upgradeLibrary(f.root, { steps: [step], upgrade: { maxCalls: 1 }, runStep })).rejects.toThrow('准备后中断')
  expect((await upgradeLibrary(f.root, { upgrade: { maxCalls: 1 }, runStep }))?.status).toBe('complete')
  expect(runStep).toHaveBeenCalledTimes(2)
  expect((await readUpgradeStatus(f.root))?.actual.calls).toBe(1)
})
