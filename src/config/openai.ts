import OpenAI from 'openai'
import { env } from './env'

let openaiClient: OpenAI | null = null
let openrouterClient: OpenAI | null = null

export function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: env.OPENAI_API_KEY })
  }
  return openaiClient
}

export function getOpenRouter(): OpenAI {
  if (!openrouterClient) {
    openrouterClient = new OpenAI({
      apiKey: env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
    })
  }
  return openrouterClient
}
