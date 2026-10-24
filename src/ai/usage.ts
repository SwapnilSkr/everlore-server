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

// The rich collector is separate so the historical usage snapshot stays exact.
import { ObjectId } from 'mongodb'
import type { LLMTraceRecord, TraceMessage } from '../models/llm-call.model'

export interface LLMTraceScope {
  instance_id?: string | ObjectId
  player_id?: string | ObjectId
  sequence?: number
  background?: boolean
}
interface TraceCollector { scope: LLMTraceScope; records: LLMTraceRecord[] }
const traces = new AsyncLocalStorage<TraceCollector>()
const attempts = new AsyncLocalStorage<LLMTraceRecord>()

export function runWithLLMTrace<T>(scope: LLMTraceScope, fn: () => T): T {
  return traces.run({ scope, records: [] }, fn)
}
export function snapshotLLMTrace(): LLMTraceRecord[] { return [...(traces.getStore()?.records ?? [])] }
export function isBackgroundTrace(): boolean { return traces.getStore()?.scope.background === true }
export function setLLMTraceSequence(sequence: number): void {
  const collector = traces.getStore()
  if (collector) {
    collector.scope.sequence = sequence
    // Prep can start before the packet reveals the next turn number. Preserve
    // calls already attributed to another event in a projection batch.
    for (const record of collector.records) record.call.sequence ??= sequence
  }
}

/** SDK copies retain all defaults; only their fetch is observed. No request edits. */
export const traceFetch: typeof fetch = Object.assign(async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const trace = attempts.getStore()
  if (trace) trace.call.attempts++
  const response = await fetch(input, init)
  if (trace) trace.call.http_status = response.status
  return response
}, { preconnect: fetch.preconnect })

export function withTraceAttempts<T>(trace: LLMTraceRecord | undefined, fn: () => T): T {
  return trace ? attempts.run(trace, fn) : fn()
}
export function beginLLMTrace(input: {
  model: string; purpose?: string; streamed: boolean; messages: TraceMessage[]
  params: Record<string, unknown>; role?: 'primary' | 'hedge' | 'fallback'
  sections?: Array<{ name: string; chars: number }>
}): LLMTraceRecord | undefined {
  const collector = traces.getStore()
  if (!collector) return undefined
  const scope = collector.scope
  const oid = (value: string | ObjectId | undefined) => value ? new ObjectId(value) : undefined
  const sections = input.sections ?? input.messages.map(m => ({ name: m.role, chars: m.content.length }))
  const params = input.params
  const trace: LLMTraceRecord = {
    call: {
      _id: new ObjectId(),
      ...(scope.instance_id ? { instance_id: oid(scope.instance_id) } : {}),
      ...(scope.player_id ? { player_id: oid(scope.player_id) } : {}),
      ...(scope.sequence !== undefined ? { sequence: scope.sequence } : {}),
      phase: scope.background ? 'background' : 'before_reply',
      purpose: input.purpose ?? 'unlabeled', role: input.role ?? 'primary',
      model: input.model, streamed: input.streamed, started_at: new Date(),
      duration_ms: 0, status: 'ok', attempts: 0,
      prompt_tokens: 0, completion_tokens: 0, total_tokens: 0,
      ...(typeof params.temperature === 'number' ? { temperature: params.temperature } : {}),
      ...(typeof (params.max_completion_tokens ?? params.max_tokens) === 'number'
        ? { max_tokens: Number(params.max_completion_tokens ?? params.max_tokens) } : {}),
      ...((params.reasoning as { effort?: string } | undefined)?.effort
        ? { reasoning_effort: (params.reasoning as { effort: string }).effort } : {}),
      response_format: ((params.response_format as { type?: 'text' | 'json_schema' | 'json_object' })?.type ?? 'text'),
      prompt_sections: sections.filter(s => s.chars > 0).map(s => ({ ...s, tokens_est: s.chars / 4 })),
      has_body: true, created_at: new Date(),
    }, request: input.messages.map(m => ({ ...m })), response: '',
  }
  collector.records.push(trace)
  return trace
}

export function traceProvider(trace: LLMTraceRecord | undefined, raw: unknown): void {
  if (!trace || !raw || typeof raw !== 'object') return
  const r = raw as { id?: unknown; provider?: unknown; choices?: Array<{ finish_reason?: string | null }>; usage?: unknown }
  if (typeof r.id === 'string') trace.call.generation_id = r.id
  if (typeof r.provider === 'string') trace.call.provider = r.provider
  const finish = r.choices?.[0]?.finish_reason
  if (finish) trace.call.finish_reason = finish
  if (finish === 'error') {
    trace.call.status = 'error'
    trace.call.error = { kind: 'provider_error', message: 'The host returned finish_reason=error' }
  }
  if (r.usage && typeof r.usage === 'object') {
    const u = r.usage as { prompt_tokens_details?: { cached_tokens?: number }; completion_tokens_details?: { reasoning_tokens?: number }; cost?: number }
    Object.assign(trace.call, usageFromProvider(r.usage))
    if (typeof u.prompt_tokens_details?.cached_tokens === 'number') trace.call.cached_tokens = u.prompt_tokens_details.cached_tokens
    if (typeof u.completion_tokens_details?.reasoning_tokens === 'number') trace.call.reasoning_tokens = u.completion_tokens_details.reasoning_tokens
    if (typeof u.cost === 'number') trace.call.cost_usd = u.cost
  }
}

export function settleLLMTrace(trace: LLMTraceRecord | undefined, error?: unknown, aborted = false): void {
  if (!trace) return
  trace.call.duration_ms = Math.max(0, Date.now() - trace.call.started_at.getTime())
  if (error === undefined && trace.response && trace.call.response_format !== 'text') {
    try { JSON.parse(trace.response) } catch { error = new Error('Invalid JSON response') }
  }
  if (error === undefined) return
  const e = error as { status?: number; name?: string; message?: string }
  if (typeof e?.status === 'number') trace.call.http_status = e.status
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Request failed'
  const kind = /no.*first token|first token within/i.test(message) ? 'no_first_token'
    : /stalled/i.test(message) ? 'stalled'
    : /timeout|timed out|exceeded/i.test(message) || e?.name === 'APIConnectionTimeoutError' ? 'timeout'
    : e?.status === 429 ? 'rate_limited'
    : /Empty LLM response/i.test(message) ? 'empty_response'
    : aborted || /abort|hedge lost|race finished/i.test(message) ? 'aborted'
    : /json/i.test(message) ? 'bad_json'
    : e?.status || /provider/i.test(message) ? 'provider_error' : 'other'
  trace.call.status = kind === 'aborted' ? 'aborted' : ['timeout', 'no_first_token', 'stalled'].includes(kind) ? 'timeout' : 'error'
  // Some providers echo request text. Remove known message text, credential-like
  // strings, and body-shaped diagnostics before keeping a bounded error.
  let safe = message
  for (const m of trace.request) {
    if (m.content) safe = safe.split(m.content).join('[request text removed]')
  }
  // A provider can echo only a fragment of an input rather than the whole
  // message. Such diagnostics are unsafe for the text-free call collection.
  const preview = safe.slice(0, 600)
  for (let i = 0; i + 24 <= preview.length; i++) {
    if (trace.request.some(m => m.content.includes(preview.slice(i, i + 24)))) {
      safe = `Request failed (${kind}; request text removed)`
      break
    }
  }
  safe = safe.replace(/(?:sk-[\w-]+|Bearer\s+\S+)/gi, '[redacted]')
  if (/"(?:messages|content|input)"\s*:/.test(safe)) safe = `Request failed (${kind})`
  trace.call.error = { kind, message: safe.slice(0, 300) }
}
