import { createHash } from 'node:crypto'
import { buildChatRequest } from '../../src/ai/client'
import { beginLLMTrace, recordLLMUsage, settleLLMTrace, traceFetch, traceProvider, usageFromProvider, withTraceAttempts } from '../../src/ai/usage'
import { getOpenRouter } from '../../src/config/openai'
import { env } from '../../src/config/env'
import { NSFW_MODE } from '../../src/utils/chat-modes'
import { sexualActIn } from '../../src/utils/input-guard-languages'
import { contentIntentMessages, scoreScene, SIGNAL_THRESHOLD } from './nsfw-classifier'

export interface IntentSlot {
  settled: boolean
  sexual?: boolean
  ms: number
  host: string
  /** True once the second host was asked as well (the hedge fired). */
  hedged: boolean
  error?: 'error' | 'malformed'
}
export interface IntentRouterTrace extends IntentSlot {
  started: boolean
  fallback?: 'late' | 'error' | 'malformed' | 'off' | 'gated'
}
export interface LateIntentResult {
  sexual: boolean
  /** Total time since the router started, not the time after `decide()`. */
  ms: number
}
interface Eligibility { capable: boolean; enabled: boolean; mode?: string }
interface RouterConfig { switch: 'on' | 'off'; model: string; host: string; fallbackHosts: string[] }
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

/** Reuse the chat dialect/provider helpers, overriding only the measured pin.
 * The measured primary stays first; only the other measured hosts may replace it. */
export function intentRouterRequest(text: string, config: RouterConfig): Request {
  const { params } = buildChatRequest({
    model: config.model, purpose: 'content_intent_same_turn',
    messages: contentIntentMessages(text.trim()), temperature: 0, maxTokens: 16,
    responseFormat: { type: 'json_object' },
  })
  const hosts = [...new Set([config.host, ...(config.fallbackHosts ?? [])])]
  params.provider = { ...params.provider, order: hosts, only: hosts, allow_fallbacks: false, require_parameters: true }
  if (hosts.length > 1) params.provider.allow_fallbacks = true
  params.reasoning = { enabled: false }
  return params
}

/** The same request pinned to ONE host. The hedge sends this twice instead of
 * letting OpenRouter's own fallback choose, so each host's own answer arrives
 * independently and the first valid one can settle the slot. */
export function intentRouterRequestFor(text: string, config: RouterConfig, host: string): Request {
  const { params } = buildChatRequest({
    model: config.model, purpose: 'content_intent_same_turn',
    messages: contentIntentMessages(text.trim()), temperature: 0, maxTokens: 16,
    responseFormat: { type: 'json_object' },
  })
  params.provider = { ...params.provider, order: [host], only: [host], allow_fallbacks: false, require_parameters: true }
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

interface HedgeSettle {
  sexual?: boolean
  error?: 'error' | 'malformed'
  host: string
  hedged: boolean
  ms: number
  cancelled?: boolean
}

const DEFAULT_HEDGE_MS = 350

/** The second host is a hedge, not a fallback list: send the same request and
 *  keep the first valid answer. A missing env value must never turn the hedge
 *  into an instant second request, so anything unusable reads as the default. */
function hedgeMsFor(override?: number): number {
  const value = override ?? env.NSFW_SAME_TURN_ROUTER_HEDGE_MS
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DEFAULT_HEDGE_MS
}

/** The two hosts the hedge may use: the primary and the first fallback. A third
 *  host is not a third attempt — both of these failing settles `error`. */
function hedgeHosts(config: RouterConfig): string[] {
  return [...new Set([config.host, ...(config.fallbackHosts ?? [])])].slice(0, 2)
}

/**
 * One judged request, with a two-host hedge. The primary runs alone; if it has
 * not answered after `hedgeMs` (or it failed) the same request goes to the other
 * host, and the first valid answer settles the slot and aborts the rest. Both
 * failing settles `error`. Used by the turn router and by the pre-computation
 * behind the cache, so the two can never drift.
 */
function runIntentHedge(input: {
  text: string
  config: RouterConfig
  hedgeMs: number
  transport: IntentTransport
  now: () => number
  signal: AbortSignal
  onHedge?: () => void
  onSettle?: (settle: HedgeSettle) => void
}): Promise<HedgeSettle> {
  const hosts = hedgeHosts(input.config)
  const began = input.now()
  const queued = hosts.slice()
  const controllers = new Set<AbortController>()
  const failures: Array<'error' | 'malformed'> = []
  let hedged = false
  let inFlight = 0
  let finished = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let resolve!: (settle: HedgeSettle) => void
  const result = new Promise<HedgeSettle>(r => { resolve = r })

  const settle = (value: Pick<HedgeSettle, 'sexual' | 'error' | 'host' | 'cancelled'>) => {
    if (finished) return
    finished = true
    if (timer) { clearTimeout(timer); timer = undefined }
    for (const controller of controllers) controller.abort()
    controllers.clear()
    const outcome: HedgeSettle = { ...value, hedged, ms: input.now() - began }
    input.onSettle?.(outcome)
    resolve(outcome)
  }

  const ask = (host: string) => {
    const controller = new AbortController()
    controllers.add(controller)
    if (input.signal.aborted) controller.abort()
    else input.signal.addEventListener('abort', () => controller.abort(), { once: true })
    inFlight++
    void (async () => {
      try {
        const raw = await input.transport(intentRouterRequestFor(input.text, input.config, host), controller.signal)
        const sexual = parseIntentResponse(raw)
        settle({ sexual, host })
      } catch (error) {
        inFlight--
        controllers.delete(controller)
        // A cancelled turn is not a failure, and nothing more is sent.
        if (finished) return
        if (input.signal.aborted) { settle({ cancelled: true, host }); return }
        failures.push(error instanceof MalformedIntent ? 'malformed' : 'error')
        const next = queued.shift()
        if (next !== undefined) {
          // An early failure starts the hedge at once rather than burning the rest
          // of the window on a host that already said no.
          hedged = true
          input.onHedge?.()
          if (timer) { clearTimeout(timer); timer = undefined }
          ask(next)
          return
        }
        if (inFlight === 0) settle({ error: failures.includes('malformed') ? 'malformed' : 'error', host })
      }
    })()
  }

  const primary = queued.shift()
  if (primary !== undefined) {
    ask(primary)
    if (queued.length > 0) {
      timer = setTimeout(() => {
        timer = undefined
        if (finished || input.signal.aborted) return
        const next = queued.shift()
        if (next === undefined) return
        hedged = true
        input.onHedge?.()
        ask(next)
      }, Math.max(0, input.hedgeMs))
    }
  }
  return result
}

/** Starts immediately; the routing decision is synchronous. A late answer keeps
 * running under the transport's own timeout so it can still be read afterwards;
 * only `cancel()` stops it early. */
export function startIntentRouter(input: Eligibility & { text: string; precomputed?: boolean }, deps: {
  transport?: IntentTransport
  now?: () => number
  config?: RouterConfig
  hedgeMs?: number
} = {}) {
  const config = deps.config ?? { switch: env.NSFW_SAME_TURN_ROUTER,
    model: env.NSFW_SAME_TURN_ROUTER_MODEL, host: env.NSFW_SAME_TURN_ROUTER_HOST,
    fallbackHosts: env.NSFW_SAME_TURN_ROUTER_FALLBACK_HOSTS }
  const now = deps.now ?? Date.now
  const started = config.switch === 'on' && eligible(input)
  const slot: IntentSlot = { settled: false, ms: 0, host: config.host, hedged: false }
  const controller = new AbortController()
  let closed = false
  let snapshot: IntentRouterTrace | undefined
  const began = now()
  let finish!: () => void
  const completion = new Promise<void>(resolve => { finish = resolve })
  if (started) {
    if (typeof input.precomputed === 'boolean') {
      // The answer was computed before this turn started (a button tap or a
      // drafted line), so there is nothing to ask and nothing to wait for.
      Object.assign(slot, { settled: true, sexual: input.precomputed, host: 'cache', ms: 0 })
      finish()
    } else {
      // A synchronous transport throw must fall back just like a rejected request.
      void runIntentHedge({
        text: input.text, config, hedgeMs: hedgeMsFor(deps.hedgeMs),
        transport: deps.transport ?? transport, now, signal: controller.signal,
        onHedge: () => { if (!closed) slot.hedged = true },
        onSettle: (settled) => {
          if (!closed && !settled.cancelled) {
            Object.assign(slot, settled.error
              ? { settled: true, host: settled.host, ms: settled.ms, hedged: settled.hedged, error: settled.error }
              : { settled: true, sexual: settled.sexual, host: settled.host, ms: settled.ms, hedged: settled.hedged })
          }
          finish()
        },
      })
    }
  }
  const waitUpTo = async (maxMs: number): Promise<void> => {
    if (!started || slot.settled || closed) return
    let timer: ReturnType<typeof setTimeout> | undefined
    try { await Promise.race([completion, new Promise<void>(resolve => { timer = setTimeout(resolve, maxMs) })]) }
    finally { if (timer) clearTimeout(timer) }
  }
  return {
    async wait(maxMs: number): Promise<void> {
      await waitUpTo(maxMs)
    },
    /** Waits only for what is left of `budgetMs` counted from the start, so a
     * caller can hold routing for a total budget without knowing when it began. */
    async waitSinceStart(budgetMs: number): Promise<void> {
      await waitUpTo(Math.max(0, budgetMs - (now() - began)))
    },
    /** The answer `decide()` left running. Undefined when nothing started, the
     * turn was cancelled, the wait ran out, or the answer was not usable. */
    async lateResult(maxMs: number): Promise<LateIntentResult | undefined> {
      if (!started || closed) return undefined
      await waitUpTo(maxMs)
      if (closed || !slot.settled || slot.error || typeof slot.sexual !== 'boolean') return undefined
      return { sexual: slot.sexual, ms: slot.ms }
    },
    decide(current: Eligibility & { text?: string }): IntentRouterTrace {
      if (snapshot) return snapshot
      if (started && !slot.settled) slot.ms = now() - began
      let fallback: IntentRouterTrace['fallback']
      if (!started) fallback = config.switch === 'off' ? 'off' : 'gated'
      else if (!eligible(current) || (current.text !== undefined && current.text !== input.text)) fallback = 'gated'
      else if (!slot.settled) fallback = 'late'
      else if (slot.error) fallback = slot.error
      snapshot = { ...slot, started, ...(fallback ? { fallback } : {}) }
      // A late answer is kept, not aborted: the request keeps its transport
      // timeout so `lateResult` can read it after the prose has streamed. The
      // frozen snapshot above is what this turn routed on, whatever arrives now.
      return snapshot
    },
    cancel(): void { closed = true; if (started && !slot.settled) controller.abort() },
  }
}

/** The persisted intent for this turn. A late router answer counts exactly like
 * an on-time one; a negative one changes nothing (the lexicon's own score and
 * the borderline judge still stand). */
export function resolveNsfwIntent(input: {
  onTimeSexual: boolean
  lateSexual?: boolean
  judgedIntent: boolean
  currentTurnScore: number
}): { nsfwIntent: boolean; source?: 'direct_explicit' | 'intent_judge' } {
  const routerSexual = input.onTimeSexual || input.lateSexual === true
  const nsfwIntent = routerSexual || input.judgedIntent || input.currentTurnScore >= 3
  const source = routerSexual || input.judgedIntent
    ? 'intent_judge' as const
    : input.currentTurnScore >= 3
      ? 'direct_explicit' as const
      : undefined
  return { nsfwIntent, source }
}

/** A negative answer zeros only this line's vocabulary contribution. The
 * unchanged scoreScene('', recentEvents) retains the exact prior momentum. */
export function decideIntentRoute(input: Eligibility & {
  text: string
  recentEvents: Parameters<typeof scoreScene>[1]
  router: ReturnType<typeof startIntentRouter>
  /** The save's effective reply language; native text needs its own act check. */
  language?: string
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
      const language = input.language?.trim().toLowerCase().split(/[-_]/)[0]
      if (language === 'pt' || language === 'es') {
        // The fallback lexicon is English vocabulary and scores native text at
        // zero, so a live pt/es act carries THIS line and momentum carries the
        // rest. No borderline band here: there is no English word score to defer.
        currentTurnScore = sexualActIn(language, input.text) ? SIGNAL_THRESHOLD : 0
        const momentum = scoreScene('', input.recentEvents).score
        sceneClassification = currentTurnScore + momentum >= SIGNAL_THRESHOLD ? 'nsfw' : 'sfw'
        borderlineForIntent = false
      } else {
        currentTurnScore = scoreScene(input.text, []).score
        sceneClassification = scoreScene(input.text, input.recentEvents).decision
        borderlineForIntent = currentTurnScore >= 1 && currentTurnScore <= 2
      }
    }
  }
  return { trace, routerSettled, sceneClassification, currentTurnScore, borderlineForIntent }
}

/** The cache key for one exact line in one save. The text is hashed, never
 *  stored or logged: two lines that differ only by outer whitespace are one. */
export function intentCacheKey(userId: string, instanceId: string, text: string): string {
  const hash = createHash('sha256').update(text.trim()).digest('hex')
  return `intent:pre:${userId}:${instanceId}:${hash}`
}

type IntentRedis = {
  get: (key: string) => Promise<string | null>
  set: (key: string, value: string, mode: 'EX', ttl: number) => Promise<unknown>
}

/** A cached answer for this save and exact text, or undefined if there is none.
 *  Any Redis error reads as a miss, so the turn falls back to the router. */
export async function readCachedIntent(redis: IntentRedis, key: string): Promise<boolean | undefined> {
  try {
    const value = await redis.get(key)
    return value === '1' ? true : value === '0' ? false : undefined
  } catch {
    return undefined
  }
}

/** Drops an answer for one line. Errors are swallowed: a missing cache entry is
 *  only the router doing its usual work. */
export async function cacheIntent(redis: IntentRedis, key: string, sexual: boolean, ttlSeconds: number): Promise<void> {
  try {
    await redis.set(key, sexual ? '1' : '0', 'EX', ttlSeconds)
  } catch {
    // A cache write is never worth failing a turn over.
  }
}

/**
 * Judge one line the way the turn router would, awaited, so its answer can be
 * cached for a turn that has not happened yet (a button tap, a typed draft).
 * `undefined` on any failure: the later turn simply asks again.
 */
export async function judgeSexualIntent(text: string, deps: {
  transport?: IntentTransport
  config?: RouterConfig
  hedgeMs?: number
} = {}): Promise<boolean | undefined> {
  const config = deps.config ?? { switch: env.NSFW_SAME_TURN_ROUTER,
    model: env.NSFW_SAME_TURN_ROUTER_MODEL, host: env.NSFW_SAME_TURN_ROUTER_HOST,
    fallbackHosts: env.NSFW_SAME_TURN_ROUTER_FALLBACK_HOSTS }
  // A switched-off router answers nothing on the turn, so nothing is asked ahead of it.
  if (config.switch !== 'on') return undefined
  const controller = new AbortController()
  const settled = await runIntentHedge({
    text, config, hedgeMs: hedgeMsFor(deps.hedgeMs),
    transport: deps.transport ?? transport, now: Date.now, signal: controller.signal,
  })
  return settled.error ? undefined : settled.sexual
}
