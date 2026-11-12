// 通用分批测试入口：先收集实际用例（含参数化展开），每次最多执行五项。
import { createVitest } from 'vitest/node'
import { writeFile, mkdtemp } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'

const folder = await mkdtemp(path.join(os.tmpdir(), 'llmwiki-local-tests-'))
const summary = { passed: 0, failed: 0, skipped: 0, errors: [], failures: [], batches: 0 }
const vitest = await createVitest('test', { watch: false, maxWorkers: 1, reporters: [{}], cache: false,
  include: ['test/**/*.test.ts'], exclude: ['node_modules/**', 'dist/**'], onConsoleLog: () => false })
try {
  const specs = await vitest.globTestSpecifications(process.argv.slice(2))
  console.log(`收集 ${specs.length} 个测试文件；结果目录：${folder}`)
  for (const spec of specs) {
    const collected = await vitest.collectTests([spec])
    const module = collected.testModules.find(item => item.moduleId === spec.moduleId)
    if (!module) throw new Error('测试收集没有返回目标模块：' + spec.moduleId)
    const collectionErrors = [...collected.unhandledErrors, ...module.errors()]
    if (collectionErrors.length) { summary.errors.push({ file: spec.moduleId, errors: collectionErrors }); continue }
    const cases = [...module.children.allTests()]
    for (let offset = 0; offset < cases.length; offset += 5) {
      const batch = cases.slice(offset, offset + 5)
      const selected = new Set(batch.map(test => test.fullName)), result = await vitest.runTestSpecifications([module.toTestSpecification(batch)])
      summary.batches++
      const executed = result.testModules.filter(item => item.moduleId === spec.moduleId)
      for (const error of [...result.unhandledErrors, ...executed.flatMap(item => item.errors())]) summary.errors.push({ file: spec.moduleId, error })
      for (const item of executed) for (const test of item.children.allTests()) {
        if (!selected.has(test.fullName)) continue
        const value = test.result()
        if (value.state === 'passed') summary.passed++
        else if (value.state === 'failed') { summary.failed++; summary.failures.push({ file: spec.moduleId, name: test.fullName, errors: value.errors }) }
        else summary.skipped++
      }
    }
    console.log(`${path.basename(spec.moduleId)}：累计通过 ${summary.passed}，失败 ${summary.failed}，错误 ${summary.errors.length}`)
    await writeFile(path.join(folder, 'summary.json'), JSON.stringify(summary, null, 2))
  }
} finally { await vitest.close() }
await writeFile(path.join(folder, 'summary.json'), JSON.stringify(summary, null, 2))
console.log(JSON.stringify({ ...summary, failures: summary.failures.map(({ file, name }) => ({ file, name })) }))
process.exitCode = summary.failed || summary.errors.length ? 1 : 0
