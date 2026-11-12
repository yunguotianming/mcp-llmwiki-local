// 模型只处理调用内的短编号；持久化身份始终由程序保管，未知编号不得回退为长键。
export function localReferences(ids: string[], prefix = 'P') {
  const unique = [...new Set(ids)]
  const reserved = new Set(unique.filter(id => new RegExp('^' + prefix + '\\d+$').test(id)))
  let next = 1
  const aliases = new Map(unique.map(id => {
    if (reserved.has(id)) return [id, id]
    while (reserved.has(prefix + next)) next++
    return [id, prefix + next++]
  }))
  const originals = new Map([...aliases].map(([id, alias]) => [alias, id]))
  return {
    alias(id: string): string {
      const value = aliases.get(id)
      if (!value) throw new Error('引用不属于本次输入。')
      return value
    },
    original(alias: string): string {
      const value = originals.get(alias)
      if (!value) throw new Error('未知引用短编号，不属于实际输入：' + alias)
      return value
    },
    has(alias: string) { return originals.has(alias) },
  }
}
