import path from 'node:path'
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises'
import { expect, it } from 'vitest'
import { temporaryWorkspace } from './temp.js'
import { LocalConfigStore, parseLocalConfig } from '../src/local/config.js'
import { runCli } from '../src/cli.js'

it('首次配置、library 增列删命令保留资料和库文件', async () => {
  const f = await temporaryWorkspace()
  try {
    const config = new LocalConfigStore(path.join(f.root, 'home')), source = path.join(f.root, '资料'), output: string[] = []
    await mkdir(source); await writeFile(path.join(source, '原文.md'), '需要保留的原始资料')
    await runCli(['library', 'add', source, '--name', '知识库'], config, value => output.push(value))
    const library = JSON.parse(output[0]!)
    expect(library.models.unified).toEqual({ provider: 'codex-cli', model: 'gpt-6.1-terra' })
    expect(library.wikiPath).toBe(path.join(source, '.llmwiki-qwen3-06b'))
    await runCli(['library', 'list'], config, value => output.push(value))
    expect(JSON.parse(output[1]!)).toHaveLength(1)
    await mkdir(library.wikiPath); await writeFile(path.join(library.wikiPath, '保留.txt'), '保留')
    await runCli(['library', 'remove', library.id], config, value => output.push(value))
    expect(config.registry().libraries).toHaveLength(0)
    expect((await stat(path.join(library.wikiPath, '保留.txt'))).isFile()).toBe(true)
    expect(await readFile(path.join(source, '原文.md'), 'utf8')).toContain('原始资料')
  } finally { await f.cleanup() }
})

it('拒绝明文密钥、非法配置及并发覆盖', async () => {
  const f = await temporaryWorkspace()
  try {
    const first = new LocalConfigStore(f.root), second = new LocalConfigStore(f.root)
    await first.load(); await second.load()
    expect(() => parseLocalConfig({ ...first.snapshot(), apiKey: '不允许写入' })).toThrow()
    expect(() => parseLocalConfig({ ...first.snapshot(), runtime: { deepseekBaseUrl: 'https://secret:password@example.com/v1' } })).toThrow()
    const old = second.registry(), next = first.registry(); next.readMaxChars = 2000
    await first.writeRegistry(next, first.registry())
    await expect(second.writeRegistry(old, old)).rejects.toThrow('其他进程')
  } finally { await f.cleanup() }
})

it('重复登记与多库歧义拒绝，环境变量可指定配置目录', async () => {
  const f = await temporaryWorkspace(), previous = process.env.LLMWIKI_LOCAL_HOME
  try {
    process.env.LLMWIKI_LOCAL_HOME = path.join(f.root, 'home')
    const config = new LocalConfigStore(); await config.load()
    expect(config.home).toBe(process.env.LLMWIKI_LOCAL_HOME)
    const source = path.join(f.root, '资料'); await mkdir(source)
    await config.add(source)
    await expect(config.add(source)).rejects.toThrow('已登记')
    await mkdir(path.join(source, '.llmwiki-one')); await mkdir(path.join(source, '.llmwiki-two'))
    await expect(config.add(source)).rejects.toThrow('多个 Wiki')
  } finally { if (previous === undefined) delete process.env.LLMWIKI_LOCAL_HOME; else process.env.LLMWIKI_LOCAL_HOME = previous; await f.cleanup() }
})
