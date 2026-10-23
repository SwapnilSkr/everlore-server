import { getOpenRouter } from '../config/openai'
import { env } from '../config/env'
import { recordLLMUsage, usageFromProvider, isLLMUsageActive } from './usage'
import { log } from '../utils/logger'
import { consumeLLMStream, EmptyLLMResponseError, formatLLMResponseReason, llmResponseContent, type LLMResponsePart } from '../utils/llm-response'

const loggedNormalizations = new Set<string>()

function normalizeChatModel(model: string): string {
  return /^(?:gpt-|o\d)/i.test(model) ? `openai/${model}` : model
}

function logNormalization(original: string, normalized: string): void {
  if (original === normalized || loggedNormalizations.has(original)) return
  loggedNormalizations.add(original)
  log.info('chat.model_normalized', { from: original, to: normalized })
}

/**
 * GPT-5-era OpenAI models changed the completion contract: `max_tokens` is
 * rejected in favour of `max_completion_tokens`, and `temperature` accepts only
 * its default — any explicit value is a 400. Callers keep passing our normal
 * options; this maps them per model instead of forcing every call site to know.
 */
function isNextGenOpenAIModel(model: string): boolean {
  const family = model.replace(/^openai\//, '')
  return /^gpt-(?:[5-9]|[1-9]\d)(?:\.|-|$)/.test(family) && family !== 'gpt-5'
}

/**
 * Headroom added to a caller's token budget on reasoning models. Their
 * `max_completion_tokens` covers INTERNAL reasoning as well as the visible
 * answer, so passing our normal budget straight through truncates the JSON and
 * the whole structured pass falls back to empty — losing the turn's choices,
 * not just its stats.
 */
const REASONING_TOKEN_HEADROOM = 1200

/** Apply a model's completion-parameter dialect to an outgoing request body. */
function applyCompletionDialect(params: Record<string, any>, model: string): void {
  if (!isNextGenOpenAIModel(model)) return
  if ('max_tokens' in params) {
    params.max_completion_tokens = params.max_tokens + REASONING_TOKEN_HEADROOM
    delete params.max_tokens
  }
  // Only the default temperature is accepted; sending one at all is an error.
  delete params.temperature
}

/** Hosts that serve DeepSeek narration with hidden "thinking" on and ignore
 * `reasoning: { enabled: false }`: measured Oct 23 2026 at 1.7k-3k reasoning
 * tokens and a 29-43 s first word (GMICloud), against ~1-2 s elsewhere. */
export const NARRATION_IGNORED_PROVIDERS = ['GMICloud'] as const

/** Narration is short, so favor the first word; JSON passes favor throughput.
 * Keep the p90 preference soft so missing telemetry never excludes a host. */
function providerPrefsFor(requireParameters: boolean, narration: boolean, prose: boolean): Record<string, unknown> {
  const p90 = env.OPENROUTER_PREFERRED_P90_LATENCY_SECONDS
  return {
    provider: {
      sort: narration ? 'latency' : 'throughput',
      // Replays and regenerations write prose too, so they skip the host as well.
      ...(prose ? { ignore: [...NARRATION_IGNORED_PROVIDERS] } : {}),
      allow_fallbacks: true,
      ...(requireParameters ? { require_parameters: true } : {}),
      ...(Number.isFinite(p90) && p90 > 0
        ? { preferred_max_latency: { p90 } }
        : {}),
    },
  }
}

export interface LLMFirstTokenHedge {
  delayMs: number
  lostPurpose: string
  onHedge?: () => void
  onFirstToken?: (winner: 'primary' | 'hedge') => void
}

interface LLMRequest {
  model: string
  messages: Array<{ role: string; content: string }>
  temperature?: number
  maxTokens?: number
  responseSchema?: object
  responseFormat?: { type: string; [key: string]: unknown }
  /** Abort if the provider has not produced its first text delta in time. */
  firstTokenTimeoutMs?: number
  /** Abort a streaming request if no token arrives for this long. */
  idleTimeoutMs?: number
  /** Absolute request timeout passed to the OpenAI SDK. */
  timeoutMs?: number
  signal?: AbortSignal
  reasoningEffort?: 'low' | 'medium' | 'high'
  /** Stable OpenRouter conversation key. It keeps a story on the provider that
   * has its prompt/KV cache warm. */
  sessionId?: string
  /** Label for per-call token accounting. Optional; omitted on unlabeled paths. */
  purpose?: string
  /** Opt-in internal JSON streaming; zero keeps the non-streamed transport. */
  firstTokenHedge?: LLMFirstTokenHedge
}

export interface LLMStreamResult {
  content: string
  /** The model that actually produced the returned content. */
  model: string
  /** Primary-model 429s that were bypassed before any prose was visible. */
  fallbackAttempts: Array<{ from: string; to: string }>
  provider?: string
  /** True if any model attempt sent a hedge, including a failed 429 attempt. */
  hedged: boolean
  /** Winning request on the successful model; absent when no hedge was sent. */
  hedgeWinner?: 'primary' | 'hedge'
}

/** Result shape shared by streaming and non-streaming pre-response reroutes. */
export interface LLMFallbackResult {
  content: string
  model: string
  fallbackAttempts: Array<{ from: string; to: string }>
}

/**
 * A 429 is safe to reroute only before a stream has emitted prose. Once the
 * player has seen a token, switching models would create two incompatible
 * continuations for one action. The OpenAI SDK exposes `status`; retain the
 * message check for provider wrappers that only preserve the error text.
 */
export function isRateLimitError(error: unknown): boolean {
  if (error instanceof EmptyLLMResponseError) return false
  if (typeof error === 'object' && error !== null) {
    const status = (error as { status?: unknown }).status
    if (status === 429) return true
  }
  return /(?:^|\s)429(?:\s|$)|rate[\s-]?limit/i.test(
    error instanceof Error ? error.message : String(error),
  )
}

function routingParamsFor(req: LLMRequest, stream: boolean): Record<string, unknown> {
  const prose = !req.responseSchema && (!req.responseFormat || req.responseFormat.type === 'text')
  return {
    ...providerPrefsFor(
      Boolean(req.responseSchema || req.responseFormat?.type === 'json_schema'),
      stream && prose,
      prose,
    ),
    ...(req.sessionId ? { session_id: req.sessionId.slice(0, 256) } : {}),
  }
}

/** Pure request construction shared by streaming and non-streaming chat. */
export function buildChatRequest(req: LLMRequest, stream = false): {
  client: 'openrouter'
  // OpenRouter extensions are absent from the OpenAI SDK's request type.
  params: any
} {
  const model = normalizeChatModel(req.model)
  // Keep the provider extensions and SDK dialect in one mutable request body.
  const params: any = {
    model,
    messages: req.messages,
    temperature: req.temperature ?? 0.8,
    max_tokens: req.maxTokens ?? 600,
    ...(stream ? { stream: true } : {}),
    ...routingParamsFor(req, stream),
  }

  if (req.responseSchema) {
    const supplied = req.responseFormat?.type === 'json_schema'
      ? req.responseFormat.json_schema as Record<string, unknown> | undefined
      : undefined
    params.response_format = {
      type: 'json_schema',
      json_schema: {
        name: supplied?.name ?? 'generation_response',
        strict: supplied?.strict ?? false,
        schema: req.responseSchema,
      },
    }
  } else if (req.responseFormat) {
    params.response_format = req.responseFormat
  }

  applyCompletionDialect(params, model)
  if (req.reasoningEffort && isNextGenOpenAIModel(model)) {
    params.reasoning = { effort: req.reasoningEffort }
  }
  return { client: 'openrouter', params }
}

function clientFor(transport: ReturnType<typeof buildChatRequest>['client']) {
  switch (transport) {
    case 'openrouter': return getOpenRouter()
    default: throw new Error(`Unsupported chat transport: ${transport}`)
  }
}

export async function callLLM(req: LLMRequest): Promise<string> {
  if (req.firstTokenHedge && req.firstTokenHedge.delayMs > 0) {
    const controller = new AbortController()
    const timeoutMs = req.timeoutMs ?? 90000
    const timer = setTimeout(() => controller.abort(new Error(`LLM request timed out after ${timeoutMs}ms`)), timeoutMs)
    try {
      const result = await narrationAttempt({
        ...req,
        timeoutMs,
        firstTokenTimeoutMs: timeoutMs,
        idleTimeoutMs: timeoutMs,
        signal: req.signal ? AbortSignal.any([req.signal, controller.signal]) : controller.signal,
      }, () => {}, true, req.firstTokenHedge.onHedge, req.firstTokenHedge)
      return result.content
    } finally {
      clearTimeout(timer)
    }
  }
  const built = buildChatRequest(req)
  const { params } = built
  logNormalization(req.model, params.model)
  const client = clientFor(built.client)

  const response = await client.chat.completions.create(params, {
    timeout: req.timeoutMs ?? 90000,
    ...(req.timeoutMs ? { maxRetries: 0 } : {}),
    ...(req.signal ? { signal: req.signal } : {}),
  })
  const rawUsage = (response as { usage?: unknown }).usage
  recordLLMUsage({
    purpose: req.purpose,
    model: req.model,
    streamed: false,
    ...usageFromProvider(rawUsage),
  })
  return llmResponseContent(response)
}

export const NARRATION_HEDGE_MS = 3500

type StreamPart = LLMResponsePart & { provider?: unknown }
export interface NarrationStreamingClient {
  create(
    params: Record<string, unknown>,
    options: { signal: AbortSignal; timeout: number; maxRetries: number },
  ): PromiseLike<AsyncIterable<StreamPart>>
}

let streamingClientForAudit: NarrationStreamingClient | null = null

/** Audit seam: null restores the real transport. No non-streaming calls use it. */
export function setNarrationStreamingClientForAudit(client: NarrationStreamingClient | null): void {
  streamingClientForAudit = client
}

async function requestLLMStream(
  req: LLMRequest,
  onDelta: (chunk: string) => void,
  controller: AbortController,
  onUsage: (usage: unknown) => void,
): Promise<{ content: string; provider?: string }> {
  const built = buildChatRequest(req, true)
  const { params } = built
  logNormalization(req.model, params.model)
  const client: NarrationStreamingClient = streamingClientForAudit ?? {
    create: (body, options) => clientFor(built.client).chat.completions.create(
      body as typeof params, options,
    ) as unknown as PromiseLike<AsyncIterable<StreamPart>>,
  }
  const idleTimeoutMs = req.idleTimeoutMs ?? 45000
  let idleTimer: ReturnType<typeof setTimeout> | undefined
  let provider: string | undefined
  let usage: unknown
  const armIdleTimer = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      controller.abort(new Error(`LLM stream stalled for ${idleTimeoutMs}ms`))
    }, idleTimeoutMs)
  }
  if (isLLMUsageActive()) params.stream_options = { include_usage: true }

  // An abort must settle even if a transport is stuck opening a stream. The
  // chunk gate also drops buffered parts from a transport that ignores abort.
  let onAbort = () => {}
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(controller.signal.reason)
    controller.signal.addEventListener('abort', onAbort, { once: true })
    if (controller.signal.aborted) onAbort()
  })
  const consume = async () => {
    if (controller.signal.aborted) throw controller.signal.reason
    const stream = await client.create(params, {
      signal: controller.signal,
      timeout: req.timeoutMs ?? 180000,
      // A hedge is the retry; SDK retries would send uncounted extra requests.
      maxRetries: 0,
    })
    if (controller.signal.aborted) throw controller.signal.reason
    armIdleTimer()
    async function* observedParts() {
      for await (const part of stream) {
        if (controller.signal.aborted) break
        if (typeof part.provider === 'string') provider = part.provider
        if (part.usage) usage = part.usage
        yield part
      }
    }
    const result = await consumeLLMStream(observedParts(), (delta) => {
      if (controller.signal.aborted) return
      onDelta(delta)
      if (!controller.signal.aborted) armIdleTimer()
    })
    if (result.providerError) {
      log.warn('chat.stream_provider_error', { model: req.model, reason: formatLLMResponseReason(result) })
    }
    return { content: result.content, provider }
  }
  try {
    return await Promise.race([aborted, consume()])
  } finally {
    clearTimeout(idleTimer)
    controller.signal.removeEventListener('abort', onAbort)
    onUsage(usage)
  }
}

type Contender = 'primary' | 'hedge'

function narrationAttempt(
  req: LLMRequest,
  onDelta: (chunk: string) => void,
  allowHedge: boolean,
  onHedge?: () => void,
  hedge?: LLMFirstTokenHedge,
): Promise<{ content: string; provider?: string; hedged: boolean; hedgeWinner?: Contender }> {
  return new Promise((resolve, reject) => {
    const contenders: Partial<Record<Contender, { controller: AbortController; error?: unknown; failed: boolean; usage?: unknown }>> = {}
    const runs: Array<Promise<unknown>> = []
    let winner: Contender | undefined
    let hedged = false
    let settled = false
    let hedgeTimer: ReturnType<typeof setTimeout> | undefined
    const firstTokenTimeoutMs = req.firstTokenTimeoutMs ?? 30000
    const firstTokenTimer = setTimeout(() => {
      finish(new Error(`LLM stream did not produce a first token within ${firstTokenTimeoutMs}ms`))
    }, firstTokenTimeoutMs)
    const clearTimers = () => {
      clearTimeout(firstTokenTimer)
      clearTimeout(hedgeTimer)
    }
    const onAbort = () => finish(req.signal?.reason ?? new Error('LLM stream aborted'))
    const finish = (error?: unknown, result?: { content: string; provider?: string }) => {
      if (settled) return
      settled = true
      clearTimers()
      req.signal?.removeEventListener('abort', onAbort)
      for (const contender of Object.values(contenders)) contender.controller.abort(error ?? new Error('Narration race finished'))
      // Abortable runners settle promptly, including usage, before the caller
      // snapshots the turn's costs. Never wait for the loser's underlying IO.
      void Promise.allSettled(runs).then(() => {
        for (const [label, contender] of Object.entries(contenders)) {
          // Without a token winner, account the structured backup as the extra
          // call; keep narration's existing failure accounting unchanged.
          const lost = winner ? winner !== label : Boolean(hedge) && label === 'hedge'
          recordLLMUsage({
            purpose: lost ? hedge?.lostPurpose ?? 'narration_hedge_lost' : req.purpose ?? 'narration',
            model: req.model, streamed: true, ...usageFromProvider(contender.usage),
          })
        }
        if (result) resolve({ ...result, hedged, hedgeWinner: hedged ? winner : undefined })
        else reject(error)
      })
    }
    const start = (label: Contender) => {
      const state = { controller: new AbortController(), failed: false, error: undefined as unknown, usage: undefined as unknown }
      contenders[label] = state
      const run = requestLLMStream(
        label === 'hedge' ? { ...req, sessionId: undefined } : req,
        (delta) => {
          if (settled) return
          // No await between observing the first text and claiming the race.
          if (!winner) {
            winner = label
            clearTimers()
            const loser = contenders[label === 'primary' ? 'hedge' : 'primary']
            loser?.controller.abort(new Error('Narration hedge lost'))
            hedge?.onFirstToken?.(label)
          }
          if (winner === label) onDelta(delta)
        },
        state.controller,
        (usage) => { state.usage = usage },
      )
      runs.push(run)
      void run.then((result) => finish(undefined, result), (error: unknown) => {
        state.failed = true
        state.error = error
        if (settled || (winner && winner !== label)) return
        // Structured calls have no model fallback: spend their one retry now
        // rather than dropping choices on an error before the hedge timer.
        if (hedge && !winner && !hedged) { startHedge(); return }
        if (winner || !hedged) { finish(error); return }
        const other = contenders[label === 'primary' ? 'hedge' : 'primary']
        if (!other?.failed) return
        // Either 429 permits a pre-prose model fallback, regardless of which
        // contender failed first. Once text wins, this branch is unreachable.
        finish(isRateLimitError(error) ? error : isRateLimitError(other.error) ? other.error : error)
      })
    }
    req.signal?.addEventListener('abort', onAbort, { once: true })
    if (req.signal?.aborted) { onAbort(); return }
    start('primary')
    const startHedge = () => {
      if (winner || settled || hedged) return
      clearTimeout(hedgeTimer)
      hedged = true
      onHedge?.()
      start('hedge')
    }
    if (allowHedge) {
      if (hedge) hedgeTimer = setTimeout(startHedge, hedge.delayMs)
      else hedgeTimer = setTimeout(() => {
        startHedge()
      }, NARRATION_HEDGE_MS)
    }
  })
}

/** Plain prose streaming without model fallback. */
export async function callLLMStream(
  req: LLMRequest,
  onDelta: (chunk: string) => void,
): Promise<string> {
  return (await narrationAttempt(req, onDelta, false)).content
}

/**
 * Attempt alternative narration models immediately after a pre-stream 429.
 * This deliberately wraps only the streamed narration path: post-processing
 * remains on its existing, purpose-built models, and visible prose is never
 * restarted or replaced.
 */
export async function callLLMStreamWithFallback(
  req: LLMRequest,
  fallbackModels: readonly string[],
  onDelta: (chunk: string) => void,
  onFallback?: (attempt: { from: string; to: string; error: unknown }) => void,
): Promise<LLMStreamResult> {
  const models = [req.model, ...fallbackModels]
    .map((model) => model.trim())
    .filter((model, index, all) => model.length > 0 && all.indexOf(model) === index)
  const fallbackAttempts: Array<{ from: string; to: string }> = []
  let lastError: unknown
  let hedged = false

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index]
    let streamed = false
    try {
      const result = await narrationAttempt(
        {
          ...req,
          model,
          // Keep the same sampling profile across a pre-stream reroute so the
          // scene's voice does not abruptly change just because a provider is
          // saturated.
        },
        (chunk) => {
          streamed = true
          onDelta(chunk)
        },
        true,
        () => { hedged = true },
      )
      return {
        ...result, model, fallbackAttempts, hedged,
        hedgeWinner: hedged ? result.hedgeWinner ?? 'primary' : undefined,
      }
    } catch (error) {
      lastError = error
      const nextModel = models[index + 1]
      if (streamed || !isRateLimitError(error) || !nextModel) throw error
      const attempt = { from: model, to: nextModel }
      fallbackAttempts.push(attempt)
      onFallback?.({ ...attempt, error })
    }
  }

  throw lastError instanceof Error ? lastError : new Error('All narration models failed')
}

/**
 * Non-streaming counterpart for replay and other prose paths. It retries only
 * a pre-response 429, so callers never receive a partial answer that could be
 * replaced under them. Normal success still takes exactly one provider call.
 */
export async function callLLMWithFallback(
  req: LLMRequest,
  fallbackModels: readonly string[],
  onFallback?: (attempt: { from: string; to: string; error: unknown }) => void,
): Promise<LLMFallbackResult> {
  const models = [req.model, ...fallbackModels]
    .map((model) => model.trim())
    .filter((model, index, all) => model.length > 0 && all.indexOf(model) === index)
  const fallbackAttempts: Array<{ from: string; to: string }> = []
  let lastError: unknown

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index]
    try {
      const content = await callLLM({ ...req, model })
      return { content, model, fallbackAttempts }
    } catch (error) {
      lastError = error
      const nextModel = models[index + 1]
      if (!isRateLimitError(error) || !nextModel) throw error
      const attempt = { from: model, to: nextModel }
      fallbackAttempts.push(attempt)
      onFallback?.({ ...attempt, error })
    }
  }

  throw lastError instanceof Error ? lastError : new Error('All narration models failed')
}
