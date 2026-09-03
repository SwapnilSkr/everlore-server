import { AsyncLocalStorage } from 'node:async_hooks'

/** One provider call's token accounting. Absent numbers mean the provider
 *  did not return `usage` — still recorded so a missing field is visible. */
export interface LLMCallUsage {
  purpose?: string
  model: string
  streamed: boolean
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
}

class LLMUsageCollector {
  readonly calls: LLMCallUsage[] = []
  record(call: LLMCallUsage): void {
    this.calls.push(call)
  }
}

const store = new AsyncLocalStorage<LLMUsageCollector>()

export function recordLLMUsage(call: LLMCallUsage): void {
  store.getStore()?.record({
    ...call,
    prompt_tokens: Number.isFinite(call.prompt_tokens) ? call.prompt_tokens : 0,
    completion_tokens: Number.isFinite(call.completion_tokens) ? call.completion_tokens : 0,
    total_tokens: Number.isFinite(call.total_tokens) ? call.total_tokens : 0,
  })
}

export function snapshotLLMUsage(): LLMCallUsage[] {
  return [...(store.getStore()?.calls ?? [])]
}

export function isLLMUsageActive(): boolean {
  return store.getStore() != null
}

export function runWithLLMUsage<T>(fn: () => Promise<T>): Promise<T> {
  return store.run(new LLMUsageCollector(), fn)
}

export function usageFromProvider(raw: unknown): Pick<LLMCallUsage, 'prompt_tokens' | 'completion_tokens' | 'total_tokens'> {
  const u = (raw && typeof raw === 'object' ? raw : {}) as {
    prompt_tokens?: unknown
    completion_tokens?: unknown
    total_tokens?: unknown
  }
  const prompt = Number(u.prompt_tokens) || 0
  const completion = Number(u.completion_tokens) || 0
  const total = Number(u.total_tokens) || prompt + completion
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total }
}
