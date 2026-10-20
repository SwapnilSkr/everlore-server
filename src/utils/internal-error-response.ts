import { EmptyLLMResponseError } from './llm-response'

export function internalErrorResponse(error: unknown): { status: 500; body: { error: string } } | null {
  // Provider diagnostics must never participate in public message-based mappings.
  if (error instanceof EmptyLLMResponseError) {
    return { status: 500, body: { error: 'Internal server error' } }
  }
  return null
}
