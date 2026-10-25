import { encodingForModel } from 'js-tiktoken'

let encoder: ReturnType<typeof encodingForModel> | null = null

function getEncoder() {
  if (!encoder) {
    encoder = encodingForModel('gpt-4o')
  }
  return encoder
}

/**
 * Builds the encoder now rather than on the first turn: building it costs
 * ~600 ms on the prod box (Oct 25 2026, measured 602/576 ms), which landed in
 * the first turn's prompt build after every restart. Network keep-warm cannot
 * cover it; it is CPU work inside this process.
 */
export function warmTokenEncoder(): boolean {
  try {
    getEncoder()
    return true
  } catch {
    return false
  }
}

export function isTokenEncoderReady(): boolean {
  return encoder !== null
}

export function countTokens(text: string): number {
  try {
    return getEncoder().encode(text).length
  } catch {
    // Fallback: rough estimate of 4 chars per token
    return Math.ceil(text.length / 4)
  }
}
