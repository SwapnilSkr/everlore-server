import { buildChatRequest } from '../../src/ai/client'
import { beginLLMTrace, recordLLMUsage, settleLLMTrace, traceFetch, traceProvider, usageFromProvider, withTraceAttempts } from '../../src/ai/usage'
import { getOpenRouter } from '../../src/config/openai'
import { env } from '../../src/config/env'
import { NSFW_MODE } from '../../src/utils/chat-modes'
import { contentIntentMessages, scoreScene } from './nsfw-classifier'

export interface IntentSlot {
  settled: boolean
  sexual?: boolean
  ms: number
  host: string
  error?: 'error' | 'malformed'
}
export interface IntentRouterTrace extends IntentSlot {
  started: boolean
  fallback?: 'late' | 'error' | 'malformed' | 'off' | 'gated'
}
interface Eligibility { capable: boolean; enabled: boolean; mode?: string }
interface RouterConfig { switch: 'on' | 'off'; model: string; host: string }
// The shared builder carries OpenRouter extensions beyond the SDK's types.
type Request = ReturnType<typeof buildChatRequest>['params']
export type IntentTransport = (params: Request, signal: AbortSignal) => Promise<unknown>

class MalformedIntent extends Error {
  constructor() { super('Malformed intent JSON response') }
}

/** Duplicate keys, fences, extra keys and truncated but valid JSON all fail. */
export function parseIntentResponse(raw: unknown): boolean {
  const response = raw as { choices?: Array<{ finish_reason?: unknown; message?: { content?: unknown } }> } | null
  const choice = response?.choices?.[0]
  const content = choice?.message?.content
  if (!Array.isArray(response?.choices) || response.choices.length !== 1 || choice?.finish_reason !== 'stop' || typeof content !== 'string'
    || !/^\s*\{\s*"sexual_intent"\s*:\s*(true|false)\s*\}\s*$/.test(content)) throw new MalformedIntent()
  return (JSON.parse(content) as { sexual_intent: boolean }).sexual_intent
}

/** Reuse the chat dialect/provider helpers, overriding only the measured pin. */
export function intentRouterRequest(text: string, config: RouterConfig): Request {
  const { params } = buildChatRequest({
    model: config.model, purpose: 'content_intent_same_turn',
    messages: contentIntentMessages(text.trim()), temperature: 0, maxTokens: 16,
    responseFormat: { type: 'json_object' },
  })
  params.provider = { ...params.provider, order: [config.host], only: [config.host], allow_fallbacks: false, require_parameters: true }
  params.reasoning = { enabled: false }
  return params
}

const transport: IntentTransport = async (params, signal) => {
  const trace = beginLLMTrace({ model: params.model, purpose: 'content_intent_same_turn',
    streamed: false, messages: params.messages, params })
  let usage: unknown
  try {
    const client = getOpenRouter().withOptions({ fetch: traceFetch })
    const response: unknown = await withTraceAttempts(trace, () => client.chat.completions.create(params, {
      signal, timeout: 6000, maxRetries: 0,
    }))
    const raw = response as { usage?: unknown; choices?: Array<{ message?: { content?: unknown } }> } | null
    usage = raw?.usage
    traceProvider(trace, response)
    const content = raw?.choices?.[0]?.message?.content
    if (trace && typeof content === 'string') trace.response = content
    parseIntentResponse(response)
    settleLLMTrace(trace)
    return response
  } catch (error) {
    settleLLMTrace(trace, error, signal.aborted)
    throw error
  } finally {
    recordLLMUsage({ purpose: 'content_intent_same_turn', model: params.model, streamed: false, ...usageFromProvider(usage) })
  }
}

const eligible = (input: Eligibility) => input.capable && input.enabled && input.mode !== NSFW_MODE

/** Starts immediately; the only exposed decision operation is synchronous.
 * Once closed, even a transport that ignores abort cannot change this turn. */
export function startIntentRouter(input: Eligibility & { text: string }, deps: {
  transport?: IntentTransport
  now?: () => number
  config?: RouterConfig
} = {}) {
  const config = deps.config ?? { switch: env.NSFW_SAME_TURN_ROUTER,
    model: env.NSFW_SAME_TURN_ROUTER_MODEL, host: env.NSFW_SAME_TURN_ROUTER_HOST }
  const now = deps.now ?? Date.now
  const started = config.switch === 'on' && eligible(input)
  const slot: IntentSlot = { settled: false, ms: 0, host: config.host }
  const controller = new AbortController()
  let closed = false
  let snapshot: IntentRouterTrace | undefined
  const began = now()
  if (started) {
    // A synchronous transport throw must fall back just like a rejected request.
    void (async () => {
      try {
        const raw = await (deps.transport ?? transport)(intentRouterRequest(input.text, config), controller.signal)
        const sexual = parseIntentResponse(raw)
        if (!closed) Object.assign(slot, { settled: true, sexual, ms: now() - began })
      } catch (error) {
        if (!closed) Object.assign(slot, { settled: true, ms: now() - began,
          error: error instanceof MalformedIntent ? 'malformed' : 'error' })
      }
    })()
  }
  return {
    decide(current: Eligibility & { text?: string }): IntentRouterTrace {
      if (snapshot) return snapshot
      closed = true
      if (started && !slot.settled) slot.ms = now() - began
      let fallback: IntentRouterTrace['fallback']
      if (!started) fallback = config.switch === 'off' ? 'off' : 'gated'
      else if (!eligible(current) || (current.text !== undefined && current.text !== input.text)) fallback = 'gated'
      else if (!slot.settled) fallback = 'late'
      else if (slot.error) fallback = slot.error
      snapshot = { ...slot, started, ...(fallback ? { fallback } : {}) }
      if (started && !slot.settled) controller.abort()
      return snapshot
    },
    cancel(): void { closed = true; if (started && !slot.settled) controller.abort() },
  }
}

/** A negative answer zeros only this line's vocabulary contribution. The
 * unchanged scoreScene('', recentEvents) retains the exact prior momentum. */
export function decideIntentRoute(input: Eligibility & {
  text: string
  recentEvents: Parameters<typeof scoreScene>[1]
  router: ReturnType<typeof startIntentRouter>
}) {
  const trace = input.router.decide(input)
  const routerSettled = trace.settled && !trace.fallback && typeof trace.sexual === 'boolean'
  let currentTurnScore = 0
  let sceneClassification: 'sfw' | 'nsfw' = 'sfw'
  let borderlineForIntent = false
  if (input.capable && input.enabled) {
    if (input.mode === NSFW_MODE) sceneClassification = 'nsfw'
    else if (routerSettled) {
      sceneClassification = trace.sexual ? 'nsfw' : scoreScene('', input.recentEvents).decision
    } else {
      currentTurnScore = scoreScene(input.text, []).score
      sceneClassification = scoreScene(input.text, input.recentEvents).decision
      borderlineForIntent = currentTurnScore >= 1 && currentTurnScore <= 2
    }
  }
  return { trace, routerSettled, sceneClassification, currentTurnScore, borderlineForIntent }
}
