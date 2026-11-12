import { expect, it, vi } from 'vitest'
import { z } from 'zod'
import { EventEmitter } from 'node:events'
import { PassThrough, Writable } from 'node:stream'
import { readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { auditFixture, envelope, point } from './speed-fix-audit-fixture.js'
import { ModelClient } from '../src/llm/client.js'
import type { ModelRuntime } from '../src/llm/client.js'
import { createCodexCliRuntime } from '../src/llm/codex-cli.js'
import { newLibrary } from '../src/domain/config.js'
import { defaultPolicy } from '../src/domain/policy.js'
import { wireOutput } from '../src/layered/extraction.js'
import { reviewExtraction } from '../src/layered/review.js'
import { reviewTopicContent } from '../src/layered/topic-review.js'
import { understandQuery } from '../src/wiki/query-understanding.js'
import { strictSchema } from '../src/llm/protocol.js'
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

const library = () => {
  const lib = newLibrary('协议审查'); lib.models.unified = { provider: 'codex-cli', model: 'audit' }; lib.models.fallbacks = []; lib.models.layeredRoutes = {}
  lib.queryUnderstanding = { model: { provider: 'codex-cli', model: 'audit' } }
  return lib
}
function fakeCli() {
  const requests: { args: string[]; schema: any; prompt: string }[] = []
  vi.mocked(spawn).mockImplementation((_exe: any, args: any): any => {
    let prompt = ''
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), stderr: new PassThrough(), stdin: new Writable({ write(chunk, _enc, done) { prompt += chunk; done() } }) })
    child.stdin.on('finish', () => {
      const schema = args.includes('--output-schema') ? JSON.parse(readFileSync(args[args.indexOf('--output-schema') + 1], 'utf8')) : undefined
      requests.push({ args, schema, prompt })
      writeFileSync(args[args.indexOf('-o') + 1], '{"variants":["临床证据"]}')
      child.emit('close', 0)
    })
    return child
  })
  return requests
}

it('A18 提取、结构纠正、提取核对、补证、主题核对及纠正均携同源可校验示例', async () => {
  const f = auditFixture('方法A。结果20%。'), captured: any[] = []
  f.call.mockImplementation(async (...args) => {
    captured.push(args)
    const data = JSON.parse(args[2])
    if (data.correction_stage) return JSON.stringify({ items: [{ id: 'point:0', ...point(f.parts[0]!), evidence: [{ locator: 'L1-L1', quote: '方法A。' }] }] })
    if (data.review_stage === 'extraction' || data.review_stage === 'topic') return JSON.stringify({ items: (data.points ?? data.sentences).map((p: any) => ({ id: p.id, support: '部分支撑', missing: '结果' })) })
    if (data.review_stage === 'extraction-correction') return JSON.stringify({ items: data.items.map((p: any) => ({ id: p.id, evidence: [{ locator: 'L1-L1', quote: f.source.text }], support: '完整支撑', missing: '' })) })
    if (data.review_stage === 'topic-correction') return JSON.stringify({ sentences: data.validationFeedback.map((p: any) => ({ id: p.id, text: '', point_ids: [], support: '不支撑', missing: '不足' })) })
    return JSON.stringify(envelope([{ text: f.source.text, evidence: [{ locator: 'L1-L1', quote: '方法A。' }] }]))
  })
  const result = await f.run(); f.options.topics = { extractionReview: 'all', topicReview: true }
  await reviewExtraction(result, f.source, f.options, 64000)
  await reviewTopicContent('T1', '# 主题\n范围：研究结果。\n', result.segments[0]!.points, f.options)
  expect(captured).toHaveLength(6)
  for (const args of captured) {
    const schema = args[5]?.structuredSchema?.schema
    expect(schema).toBeDefined()
    const example = JSON.parse(args[1].split('合法JSON示例：\n').at(-1))
    expect(z.fromJSONSchema(schema).safeParse(example).success).toBe(true)
    if (!JSON.parse(args[2]).review_stage && !JSON.parse(args[2]).correction_stage) expect(wireOutput.safeParse(example).success).toBe(true)
  }
})

it('A19 ModelClient到Codex CLI实际参数携带完整Schema并与原校验器同源', async () => {
  const requests = fakeCli(), runtime = createCodexCliRuntime({ executable: '禁止真实执行的审查替身', model: 'audit', disabledFeatures:['shell_tool','multi_agent','plugins','remote_plugin'] })
  const client = new ModelClient(runtime, library(), { ...defaultPolicy(), batchDelayMs: 0 })
  const schema = wireOutput.toJSONSchema()
  await client.call('ingest', '提取资料', '{}', undefined, [], { operation: 'extract', structuredSchema: { name: 'audit', schema } })
  expect(requests).toHaveLength(1); expect(requests[0]!.args).toContain('--output-schema'); expect(requests[0]!.schema).toEqual(strictSchema(schema))
  // 标签不足由程序留痕；完整 Schema 的合法数量与产品口径统一为 0～8。
  expect(requests[0]!.prompt).toContain('tags:[s+][0..8]')
  expect(requests[0]!.prompt).toContain('quote:s+/\\S/')
  expect(JSON.stringify(requests[0]!.schema)).not.toMatch(/minLength|maxLength|pattern|examples/)
  const example = JSON.parse(requests[0]!.prompt.split('合法JSON示例：\n')[1]!.split('\n\n输入数据：')[0]!)
  expect(wireOutput.safeParse(example).success).toBe(true)
})

it('A20 查询理解兜底在Codex CLI必须携output-schema', async () => {
  const requests = fakeCli(), runtime = createCodexCliRuntime({ executable: '禁止真实执行的审查替身', model: 'audit', disabledFeatures:['shell_tool','multi_agent','plugins','remote_plugin'] })
  expect((await understandQuery('护士效果', [], library(), runtime)).status).toBe('generated')
  expect(requests).toHaveLength(1); expect(requests[0]!.args).toContain('--output-schema')
})

it('A21 不支持结构化输出的DeepSeek仍收到完整同源Schema文本和合法示例', async () => {
  let received: any
  const runtime: ModelRuntime = { resolveModelInfo: async (provider, id) => ({ provider, id, name: id }), async *stream(options) {
    received = options; yield { type: 'text-delta', index: 0, text: '{}' }; yield { type: 'finish', reason: { kind: 'stop' } }
  } }
  const lib = library(); lib.models.unified = { provider: 'deepseek', model: 'audit' }
  await new ModelClient(runtime, lib, { ...defaultPolicy(), batchDelayMs: 0 }).call('ingest', '规则', '{}', undefined, [], { operation: 'extract', structuredSchema: { name: 'audit', schema: wireOutput.toJSONSchema() } })
  expect(received.responseFormat).toBeUndefined()
  expect(received.system).toContain('paragraph_id'); expect(received.system).toContain('referent')
  // 供应商提示协议同样允许不足三个标签，不取消非空标签与引文校验。
  expect(received.system).toContain('tags:[s+][0..8]')
  expect(received.system).toContain('quote:s+/\\S/')
  expect(received.system).toContain('访谈。')
  expect(wireOutput.safeParse(JSON.parse(received.system.split('合法JSON示例：\n').at(-1))).success).toBe(true)
})
