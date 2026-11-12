import type { ModelAttempt, ModelClient } from '../llm/client.js'
import type { ModelRef } from '../domain/config.js'

export type { ModelRef } from '../domain/config.js'

export function mergeModels(...groups: (readonly ModelRef[] | undefined)[]): ModelRef[] {
  const routes = new Map<string, ModelRef>()
  for (const group of groups) for (const route of group ?? []) {
    if (!route.provider || !route.model) continue
    const value = { provider: route.provider, model: route.model }
    routes.set(JSON.stringify([value.provider, value.model]), value)
  }
  return [...routes.values()].sort((left, right) => left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model))
}

export function modelUsage<Client extends Pick<ModelClient, 'call' | 'info'>>(client: Client): { client: Client; models: ModelRef[] } {
  const models: ModelRef[] = []
  const call: ModelClient['call'] = async (task, system, input, signal, images, options) => {
    const attempts: ModelAttempt[] = []
    let completed = false
    try {
      const output = await client.call(task, system, input, signal, images, {
        ...options,
        onAttempt: attempt => {
          attempts.push(attempt)
          options?.onAttempt?.(attempt)
        },
      })
      completed = true
      return output
    } finally {
      const successful = attempts.filter(attempt => attempt.finish === 'stop' && !attempt.error).map(attempt => attempt.route)
      if (completed && !attempts.length) {
        try {
          const info = await client.info(task, signal, images?.length ? 'image' : undefined, options?.operation)
          if (info.provider && info.id) successful.push({ provider: info.provider, model: info.id })
        } catch {}
      }
      models.splice(0, models.length, ...mergeModels(models, successful))
    }
  }
  const observed = new Proxy(client, {
    get(target, property) {
      if (property === 'call') return call
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  return { client: observed, models }
}
