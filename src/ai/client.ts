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

/**
 * OpenRouter-only provider routing preferences.
 *
 * OpenRouter's default routing can land a request on the cheapest backend host,
 * which under load has a poor mid-stream token rate ("one word every 3s" stalls)
 * even when TTFT looks fine — old budget hosts (e.g. mythomax 13B) are the worst
 * offenders. `sort: 'throughput'` tells OpenRouter to prefer high-throughput
 * providers; `allow_fallbacks` keeps reliability if the fastest host is down.
 * The p90 preference deprioritizes hosts with a recently poor tail-latency
 * record, without turning a temporary telemetry gap into a hard outage.
 *
 */
function providerPrefsFor(requireParameters: boolean): Record<string, unknown> {
  const p90 = env.OPENROUTER_PREFERRED_P90_LATENCY_SECONDS
  return {
    provider: {
      sort: 'throughput',
      allow_fallbacks: true,
      ...(requireParameters ? { require_parameters: true } : {}),
      ...(Number.isFinite(p90) && p90 > 0
        ? { preferred_max_latency: { p90 } }
        : {}),
    },
  }
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
}

export interface LLMStreamResult {
  content: string
  /** The model that actually produced the returned content. */
  model: string
  /** Primary-model 429s that were bypassed before any prose was visible. */
  fallbackAttempts: Array<{ from: string; to: string }>
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

function routingParamsFor(req: LLMRequest): Record<string, unknown> {
  return {
    ...providerPrefsFor(Boolean(req.responseSchema || req.responseFormat?.type === 'json_schema')),
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
    ...routingParamsFor(req),
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

/**
 * Streaming chat completion. Invokes [onDelta] for each text chunk as it arrives
 * and resolves with the full concatenated text. Plain-text only — used for
 * narration prose; structured metadata is derived in a separate pass.
 */
export async function callLLMStream(
  req: LLMRequest,
  onDelta: (chunk: string) => void,
): Promise<string> {
  const built = buildChatRequest(req, true)
  const { params } = built
  logNormalization(req.model, params.model)
  const client = clientFor(built.client)
  const controller = new AbortController()
  const firstTokenTimeoutMs = req.firstTokenTimeoutMs ?? 30000
  const idleTimeoutMs = req.idleTimeoutMs ?? 45000
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  let firstTokenTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    controller.abort(new Error(`LLM stream did not produce a first token within ${firstTokenTimeoutMs}ms`))
  }, firstTokenTimeoutMs)

  const armIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      controller.abort(new Error(`LLM stream stalled for ${idleTimeoutMs}ms`))
    }, idleTimeoutMs)
  }

  if (isLLMUsageActive()) params.stream_options = { include_usage: true }

  let result: Awaited<ReturnType<typeof consumeLLMStream>>
  try {
    const stream = await client.chat.completions.create(params, {
      signal: controller.signal,
      timeout: req.timeoutMs ?? 180000,
    }) as unknown as AsyncIterable<LLMResponsePart>
    armIdleTimer()
    result = await consumeLLMStream(stream, (delta) => {
      if (firstTokenTimer) {
        clearTimeout(firstTokenTimer)
        firstTokenTimer = null
      }
      onDelta(delta)
      armIdleTimer()
    })
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    if (firstTokenTimer) clearTimeout(firstTokenTimer)
  }

  if (result.providerError) {
    log.warn('chat.stream_provider_error', { model: req.model, reason: formatLLMResponseReason(result) })
  }
  recordLLMUsage({
    purpose: req.purpose ?? 'narration',
    model: req.model,
    streamed: true,
    ...usageFromProvider(result.usage),
  })
  return result.content
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

  for (let index = 0; index < models.length; index += 1) {
    const model = models[index]
    let streamed = false
    try {
      const content = await callLLMStream(
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
      )
      return { content, model, fallbackAttempts }
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
