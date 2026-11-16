import { expect, it } from 'vitest'
import { redactSecrets, redactValue } from '../src/llm/credentials.js'

it('错误正文与序列化对象中的带引号和反斜杠密钥均脱敏', () => {
  const key = 'fixture-"quoted\\key'
  expect(redactSecrets('连接失败：' + key, [key])).toBe('连接失败：[已脱敏]')
  const safe = redactSecrets(JSON.stringify({ error: '连接失败：' + key }), [key])
  expect(JSON.parse(safe)).toEqual({ error: '连接失败：[已脱敏]' })
})

it('重叠密钥优先遮蔽完整值，普通错误信息保持', () => {
  const safe = redactSecrets('fixture-long-secret / fixture / HTTP 401', ['fixture', 'fixture-long-secret', ''])
  expect(safe).toBe('[已脱敏] / [已脱敏] / HTTP 401')
})

it('多层 JSON 字符串中的密钥脱敏，数值和布尔类型保持', () => {
  const key = 'fixture-"quoted\\key'
  let nested = key
  for (let i = 0; i < 4; i++) nested = JSON.stringify({ detail: nested })
  expect(redactSecrets('失败：' + nested, [key])).not.toContain('fixture-')
  const safe = redactValue({ detail: nested, attempts: 1, enabled: true }, [key, '1'])
  expect(safe.attempts).toBe(1)
  expect(safe.enabled).toBe(true)
  expect(JSON.stringify(safe)).not.toContain('fixture-')
  const dynamic = JSON.stringify({ [key]: { nested: [{ [key]: '正文' }] } })
  expect(redactSecrets(dynamic, [key])).not.toContain('fixture-')
  expect(JSON.parse(redactSecrets(dynamic, [key]))).toEqual({ '[已脱敏]': { nested: [{ '[已脱敏]': '正文' }] } })
  expect(redactValue({ [key]: key }, [key])).toEqual({ [key]: '[已脱敏]' })
})
