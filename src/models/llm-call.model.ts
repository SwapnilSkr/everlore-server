import type { ObjectId } from 'mongodb'

export interface PromptSection { name: string; chars: number; tokens_est: number }
/** A fingerprint of one block of the prompt as it was sent: no prompt text. */
export interface PromptPart { name: string; chars: number; hash: string }
export interface LLMCallDoc {
  _id: ObjectId
  instance_id?: ObjectId
  player_id?: ObjectId
  sequence?: number
  phase: 'before_reply' | 'reply' | 'after_reply' | 'background'
  purpose: string
  role: 'primary' | 'hedge' | 'fallback'
  won?: boolean
  model: string
  provider?: string
  generation_id?: string
  streamed: boolean
  started_at: Date
  first_token_ms?: number
  duration_ms: number
  status: 'ok' | 'error' | 'aborted' | 'timeout'
  http_status?: number
  attempts: number
  finish_reason?: string
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cached_tokens?: number
  reasoning_tokens?: number
  cost_usd?: number
  temperature?: number
  max_tokens?: number
  reasoning_effort?: string
  response_format: 'text' | 'json_schema' | 'json_object'
  prompt_sections: PromptSection[]
  /** Narration only: one short hash per prompt block, in reading order. */
  prompt_parts?: PromptPart[]
  error?: { kind: string; message: string }
  has_body: boolean
  created_at: Date
}
export interface TraceMessage { role: string; content: string }
export interface LLMCallBodyDoc {
  _id: ObjectId
  instance_id?: ObjectId
  sequence?: number
  request: Array<TraceMessage & { truncated_chars?: number }>
  response: string
  created_at: Date
}
/** Raw text stays in memory until flush and is never part of a call document. */
export interface LLMTraceRecord {
  call: LLMCallDoc
  request: TraceMessage[]
  response: string
}
