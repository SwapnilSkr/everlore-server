import OpenAI from "openai";
import { env } from "../../src/config/env";

const OPENAI_MODELS = new Set([
  "gpt-5",
  "gpt-4o",
  "gpt-4o-mini",
  "gpt-3.5-turbo",
]);

let openaiClient: OpenAI | null = null;
let openrouterClient: OpenAI | null = null;

function getOpenAI(): OpenAI {
  if (!openaiClient) {
    openaiClient = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }
  return openaiClient;
}

function getOpenRouter(): OpenAI {
  if (!openrouterClient) {
    openrouterClient = new OpenAI({
      apiKey: env.OPENROUTER_API_KEY,
      baseURL: "https://openrouter.ai/api/v1",
    });
  }
  return openrouterClient;
}

interface LLMRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
  temperature?: number;
  maxTokens?: number;
  responseSchema?: object;
  responseFormat?: { type: string };
}

export async function callLLM(req: LLMRequest): Promise<string> {
  const client = OPENAI_MODELS.has(req.model) ? getOpenAI() : getOpenRouter();

  const params: any = {
    model: req.model,
    messages: req.messages,
    temperature: req.temperature ?? 0.8,
    max_tokens: req.maxTokens ?? 600,
  };

  if (req.responseSchema && OPENAI_MODELS.has(req.model)) {
    params.response_format = {
      type: "json_schema",
      json_schema: {
        name: "generation_response",
        strict: false,
        schema: req.responseSchema,
      },
    };
  } else if (req.responseFormat) {
    params.response_format = req.responseFormat;
  }

  const response = await client.chat.completions.create(params);
  const content = response.choices[0]?.message?.content;

  if (!content) throw new Error("Empty LLM response");
  return content;
}

/**
 * Streaming chat completion. Invokes [onDelta] for each text chunk as it
 * arrives and resolves with the full concatenated text. Plain-text only — used
 * for narration prose; structured metadata is derived in a separate pass.
 */
export async function callLLMStream(
  req: LLMRequest,
  onDelta: (chunk: string) => void,
): Promise<string> {
  const client = OPENAI_MODELS.has(req.model) ? getOpenAI() : getOpenRouter();

  const stream = await client.chat.completions.create({
    model: req.model,
    messages: req.messages as any,
    temperature: req.temperature ?? 0.8,
    max_tokens: req.maxTokens ?? 600,
    stream: true,
  });

  let full = "";
  for await (const part of stream) {
    const delta = part.choices[0]?.delta?.content ?? "";
    if (delta) {
      full += delta;
      onDelta(delta);
    }
  }

  if (!full) throw new Error("Empty LLM response");
  return full;
}
