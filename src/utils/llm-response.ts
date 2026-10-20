export interface LLMResponsePart {
  choices?: Array<{
    delta?: { content?: string | null }
    message?: { content?: string | null }
    finish_reason?: string | null
  }>
  error?: unknown
  usage?: unknown
}

function providerReason(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') return undefined
  const { message, code } = error as { message?: unknown; code?: unknown }
  const details = [
    typeof message === 'string' && message ? message : undefined,
    typeof code === 'string' || typeof code === 'number' ? `code=${code}` : undefined,
  ].filter(Boolean)
  return details.length ? details.join('; ') : 'unspecified provider error'
}

export function llmResponseReason(part: LLMResponsePart): { finishReason?: string; providerError?: string } {
  return {
    finishReason: part.choices?.[0]?.finish_reason ?? undefined,
    providerError: providerReason(part.error),
  }
}

export function formatLLMResponseReason(reason: ReturnType<typeof llmResponseReason>): string {
  return [
    reason.finishReason ? `finish_reason=${reason.finishReason}` : undefined,
    reason.providerError ? `provider: ${reason.providerError}` : undefined,
  ].filter(Boolean).join('; ') || 'no finish reason or provider error supplied'
}

// Provider text can mention 429s. An empty response must retain its existing
// no-fallback behaviour even when its new diagnostic happens to mention one.
export class EmptyLLMResponseError extends Error {
  constructor(reason: ReturnType<typeof llmResponseReason>) {
    super(`Empty LLM response (${formatLLMResponseReason(reason)})`)
  }
}

export function llmResponseContent(response: LLMResponsePart): string {
  const content = response.choices?.[0]?.message?.content
  if (!content) throw new EmptyLLMResponseError(llmResponseReason(response))
  return content
}

/** Consume provider parts without transport, timers, logging or model calls. */
export async function consumeLLMStream(
  parts: AsyncIterable<LLMResponsePart>,
  onDelta: (delta: string) => void,
) {
  let content = ''
  let usage: unknown
  let finishReason: string | undefined
  let providerError: string | undefined
  for await (const part of parts) {
    if (part.usage) usage = part.usage
    const reason = llmResponseReason(part)
    finishReason = reason.finishReason ?? finishReason
    providerError = reason.providerError ?? providerError
    const delta = part.choices?.[0]?.delta?.content ?? ''
    if (delta) {
      content += delta
      onDelta(delta)
    }
  }
  const reason = { finishReason, providerError }
  if (!content) throw new EmptyLLMResponseError(reason)
  return { content, usage, ...reason }
}
