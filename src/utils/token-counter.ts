import { encodingForModel } from 'js-tiktoken'

let encoder: ReturnType<typeof encodingForModel> | null = null

function getEncoder() {
  if (!encoder) {
    encoder = encodingForModel('gpt-4o')
  }
  return encoder
}

export function countTokens(text: string): number {
  try {
    return getEncoder().encode(text).length
  } catch {
    // Fallback: rough estimate of 4 chars per token
    return Math.ceil(text.length / 4)
  }
}
