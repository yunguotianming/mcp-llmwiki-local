import { readFile } from 'node:fs/promises'
import { vi } from 'vitest'
import { atomicWrite, hash } from '../src/layered/files.js'
import { safePath } from '../src/storage/paths.js'
import { canonicalJson, identityDigest, taskIdFor } from '../src/layered/accepted.js'
import type { AcceptanceSnapshot, RecoveryBindings, TaskIdentity } from '../src/layered/accepted.js'
import type { BuildLayeredOptions } from '../src/layered/schema.js'

// 确定性契约桩：只在测试临时库写准备快照，不包含 B3/B4 的生产实现。
export function recoveryFixture(root: string, client: BuildLayeredOptions['client']) {
  let window = 32000, sequence = 0, failPrepare = false, failBind = false
  const identities: TaskIdentity[] = [], validations: unknown[] = []
  const read = async (taskId: string) => {
    const text = await readFile(await safePath(root, 'logs/model-accepts/' + taskId.slice(2) + '.json'), 'utf8')
      .catch(error => { if (error.code === 'ENOENT') return undefined; throw error })
    return text === undefined ? { status: 'missing' as const } : JSON.parse(text) as AcceptanceSnapshot
  }
  const save = async (value: AcceptanceSnapshot) => atomicWrite(root, 'logs/model-accepts/' + value.taskId.slice(2) + '.json', canonicalJson(value) + '\n')
  const bindings: RecoveryBindings = {
    libraryId: 'fixture-library',
    validateAcceptedRecord(record) {
      if (record.taskId !== taskIdFor(record.identity) || record.schema !== 'llmwiki-accepted-v1'
        || record.validation.status !== 'accepted' || record.validation.validatorVersion !== record.identity.validatorVersion
        || record.validation.schemaDigest !== record.identity.schemaDigest || !Object.keys(record.productions).length) throw new Error('准备记录无效')
      for (const [id, production] of Object.entries(record.productions)) if (identityDigest(production) !== id
        || production.parentProductionIds.some(parent => !record.productions[parent])) throw new Error('生产链不闭合')
    },
    productionId: identityDigest,
    hooks: {
      readAcceptance: read,
      async prepareAccepted(request) {
        bindings.validateAcceptedRecord(request.record)
        const output = await readFile(await safePath(root, request.record.output.path))
        if (hash(output) !== request.record.output.digest) throw new Error('输出尚未落盘')
        const prepareId = identityDigest({ taskId: request.taskId, outputDigest: request.record.output.digest })
        const old = await read(request.taskId)
        if (old.status !== 'missing' && canonicalJson(old.record) !== canonicalJson(request.record)) throw Object.assign(new Error('准备冲突'), { code: 'ACCEPT_CONFLICT' })
        if (old.status === 'missing') await save({ ...request, prepareId, status: 'prepared', acceptedDigest: null })
        if (failPrepare) throw new Error('准备后中断')
        return { prepareId, status: old.status === 'bound' ? 'bound' : 'prepared' }
      },
      async onAccepted(binding) {
        if (failBind) throw new Error('提交后绑定中断')
        const saved = await read(binding.taskId)
        if (saved.status === 'missing') throw new Error('准备缺失')
        const committed = JSON.parse(await readFile(await safePath(root, 'work/accepted/tasks/' + binding.taskId.slice(2) + '.json'), 'utf8'))
        if (committed.acceptedDigest !== binding.acceptedDigest || identityDigest(saved.record) !== binding.acceptedDigest) throw new Error('绑定冲突')
        await save({ ...saved, status: 'bound', acceptedDigest: binding.acceptedDigest })
        return { status: 'bound', acceptedDigest: binding.acceptedDigest }
      },
      async onValidation(value) { validations.push(value) },
    },
    resolveExecution: vi.fn(async (identity, runId, retryScopeId) => {
      identities.push(identity)
      return { taskId: taskIdFor(identity), runId, retryScopeId, stagePlan: { stage: identity.stage }, hooks: bindings.hooks }
    }),
    stageInputBudgets: vi.fn(async () => [{ inputLimitBytes: window }]),
    callDetailed: vi.fn(async (task, system, input, signal, images, options) => ({
      text: await client.call(task, system, input, signal, images, options), responseAttemptId: 'a:' + options.execution.runId + ':' + ++sequence,
      attempts: [], actual: { lineId: 'fixture-line', provider: 'mock', requestedModel: 'accepted-model', reportedModel: null,
        parameters: {}, bindingRevision: hash('fixture-binding'), capabilityRevision: hash('fixture-capability') },
    })),
  }
  return { bindings, identities, validations, setWindow(value: number) { window = value },
    failPrepare(value: boolean) { failPrepare = value }, failBind(value: boolean) { failBind = value } }
}
