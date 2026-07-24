import { getOpenAI, getOpenRouter } from '../config/openai'
import { env } from '../config/env'

/**
 * Model ids served by the OpenAI API directly. Anything NOT in this set is
 * routed through OpenRouter (e.g. `deepseek/…`, `gryphe/…`). Keep narration and
 * auxiliary OpenAI models (gpt-4o-mini, gpt-4o, …) here.
 */
const OPENAI_MODELS = new Set(['gpt-5', 'gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo'])

function clientFor(model: string) {
  return OPENAI_MODELS.has(model) ? getOpenAI() : getOpenRouter()
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
 * Returns `undefined` for OpenAI-direct models — they must NOT receive a
 * `provider` field (it's an OpenRouter-specific top-level body extension and is
 * meaningless / potentially rejected by the OpenAI API).
 */
function providerPrefsFor(model: string): Record<string, unknown> | undefined {
  if (OPENAI_MODELS.has(model)) return undefined
  const p90 = env.OPENROUTER_PREFERRED_P90_LATENCY_SECONDS
  return {
    provider: {
      sort: 'throughput',
      allow_fallbacks: true,
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
  responseFormat?: { type: string }
  /** Abort if the provider has not produced its first text delta in time. */
  firstTokenTimeoutMs?: number
  /** Abort a streaming request if no token arrives for this long. */
  idleTimeoutMs?: number
  /** Absolute request timeout passed to the OpenAI SDK. */
  timeoutMs?: number
  /** Stable OpenRouter conversation key. It keeps a story on the provider that
   * has its prompt/KV cache warm; ignored for direct OpenAI models. */
  sessionId?: string
}

function routingParamsFor(req: LLMRequest): Record<string, unknown> {
  if (OPENAI_MODELS.has(req.model)) return {}
  return {
    ...(providerPrefsFor(req.model) ?? {}),
    ...(req.sessionId ? { session_id: req.sessionId.slice(0, 256) } : {}),
  }
}

export async function callLLM(req: LLMRequest): Promise<string> {
  const client = clientFor(req.model)

  const params: any = {
    model: req.model,
    messages: req.messages,
    temperature: req.temperature ?? 0.8,
    max_tokens: req.maxTokens ?? 600,
  }

  if (req.responseSchema && OPENAI_MODELS.has(req.model)) {
    params.response_format = {
      type: 'json_schema',
      json_schema: {
        name: 'generation_response',
        strict: false,
        schema: req.responseSchema,
      },
    }
  } else if (req.responseFormat) {
    params.response_format = req.responseFormat
  }

  Object.assign(params, routingParamsFor(req))

  const response = await client.chat.completions.create(params, {
    timeout: req.timeoutMs ?? 90000,
  })
  const content = response.choices[0]?.message?.content

  if (!content) throw new Error('Empty LLM response')
  return content
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
  const client = clientFor(req.model)
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

  const params: any = {
    model: req.model,
    messages: req.messages as any,
    temperature: req.temperature ?? 0.8,
    max_tokens: req.maxTokens ?? 600,
    stream: true,
    ...routingParamsFor(req),
  }

  let full = ''
  try {
    const stream = await client.chat.completions.create(params, {
      signal: controller.signal,
      timeout: req.timeoutMs ?? 180000,
    }) as unknown as AsyncIterable<{ choices: Array<{ delta?: { content?: string } }> }>
    armIdleTimer()
    for await (const part of stream) {
      const delta = part.choices[0]?.delta?.content ?? ''
      if (delta) {
        if (firstTokenTimer) {
          clearTimeout(firstTokenTimer)
          firstTokenTimer = null
        }
        full += delta
        onDelta(delta)
        armIdleTimer()
      }
    }
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
    if (firstTokenTimer) clearTimeout(firstTokenTimer)
  }

  if (!full) throw new Error('Empty LLM response')
  return full
}
