import OpenAI from 'openai'
import { env } from '../../src/config/env'

const OPENAI_MODELS = new Set(['gpt-4o', 'gpt-4o-mini', 'gpt-3.5-turbo'])

let openaiClient: OpenAI | null = null
let openrouterClient: OpenAI | null = null

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: env.OPENAI_API_KEY })
  }
  return openaiClient
}

function getOpenRouter(): OpenAI {
  if (!openrouterClient) {
    openrouterClient = new OpenAI({
      apiKey: env.OPENROUTER_API_KEY,
      baseURL: 'https://openrouter.ai/api/v1',
    })
  }
  return openrouterClient
}

interface LLMRequest {
  model: string
  messages: Array<{ role: string; content: string }>
  temperature?: number
  maxTokens?: number
  responseSchema?: object
  responseFormat?: { type: string }
}

export async function callLLM(req: LLMRequest): Promise<string> {
  const client = OPENAI_MODELS.has(req.model) ? getOpenAI() : getOpenRouter()

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
        strict: true,
        schema: req.responseSchema,
      },
    }
  } else if (req.responseFormat) {
    params.response_format = req.responseFormat
  }

  const response = await client.chat.completions.create(params)
  const content = response.choices[0]?.message?.content

  if (!content) throw new Error('Empty LLM response')
  return content
}
