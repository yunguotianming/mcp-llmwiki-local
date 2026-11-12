import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { expect, it, vi } from 'vitest'
vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
import { spawn } from 'node:child_process'
import { codexDisabledFeatures } from '../src/llm/codex-cli.js'

// 模拟 `codex features list` 的输出与退出码；每个用例用不同的可执行文件名，避免共用探测缓存。
function featuresList(output: string, code: number | null) {
  vi.mocked(spawn).mockImplementation((_executable: any, args: any): any => {
    expect(args).toEqual(['features', 'list'])
    const child = Object.assign(new EventEmitter(), { stdout: new PassThrough(), kill: vi.fn() })
    setImmediate(() => { child.stdout.write(output); child.emit('close', code) })
    return child
  })
}

it('只关闭本机 CLI 声明的特性：旧版没有 plugins、remote_plugin 时不传这两项', async () => {
  featuresList('multi_agent    stable  true\nshell_tool     stable  true\nweb_search     stable  true\n', 0)
  expect(await codexDisabledFeatures('old-codex')).toEqual(['shell_tool', 'multi_agent'])
})

it('新版声明全部特性时四项都关闭，并按可执行文件缓存只探测一次', async () => {
  featuresList('multi_agent stable true\nplugins stable true\nremote_plugin stable true\nshell_tool stable true\n', 0)
  expect(await codexDisabledFeatures('new-codex')).toEqual(['shell_tool', 'multi_agent', 'plugins', 'remote_plugin'])
  vi.mocked(spawn).mockClear()
  expect(await codexDisabledFeatures('new-codex')).toEqual(['shell_tool', 'multi_agent', 'plugins', 'remote_plugin'])
  expect(spawn).not.toHaveBeenCalled()
})

it('探测失败或没有输出时退回一直使用的两项', async () => {
  featuresList('', 2)
  expect(await codexDisabledFeatures('broken-codex')).toEqual(['shell_tool', 'multi_agent'])
  vi.mocked(spawn).mockImplementation((): any => { throw new Error('找不到可执行文件') })
  expect(await codexDisabledFeatures('missing-codex')).toEqual(['shell_tool', 'multi_agent'])
})
