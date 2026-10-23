import type { ObjectId } from 'mongodb'
import type { ProseHygieneIssue } from '../utils/prose-hygiene'
import type { LLMCallUsage } from '../ai/usage'

/**
 * Every step a turn's prep waits on, in the order the player waits for it.
 * `context_latency_ms` says a turn spent 3.6 s before the narrator; these say
 * where. All are wall-clock ms from the step's start to its settle, so
 * concurrent steps (`summaries`, mostly) can overlap each other and the sum can
 * exceed the elapsed time by that overlap.
 */
export const PREP_STAGE_KEYS = [
  'live_check',
  'fence',
  'recent_events',
  'mentions',
  'stub_wake',
  'embed_wait',
  'vector',
  'rag_mongo',
  'summaries',
  'codex',
  'packet_tail',
  'post_packet',
] as const

export type PrepStage = (typeof PREP_STAGE_KEYS)[number]
export type PrepStages = Partial<Record<PrepStage, number>>

/**
 * Flat integer ms, and only known stages — a stray `undefined`, a negative or a
 * float would make the row harder to aggregate than it is worth.
 */
export function buildPrepStages(input: Partial<Record<string, number | undefined>>): PrepStages {
  const stages: PrepStages = {}
  for (const key of PREP_STAGE_KEYS) {
    const ms = input[key]
    if (typeof ms === 'number' && Number.isFinite(ms) && ms >= 0) stages[key] = Math.round(ms)
  }
  return stages
}

/**
 * generation_logs — one document per narration generation. Non-blocking,
 * best-effort dev/observability record: shows which model handled each turn and
 * whether the NSFW path was taken. Not on the request critical path.
 */
export interface GenerationLogDoc {
  _id: ObjectId
  instance_id: ObjectId
  player_id: ObjectId
  sequence: number
  /** World allows mature content. */
  is_nsfw_capable: boolean
  /** Player opted into NSFW in their account preferences. */
  user_nsfw_enabled: boolean
  /** Keyword classifier verdict for this turn's input. */
  scene_classification: 'sfw' | 'nsfw'
  /** True when the uncensored NSFW model was actually selected. */
  nsfw_path: boolean
  /** Narration model that produced the prose. */
  model_used: string
  /** Primary narration model requested before any provider fallback. */
  requested_model?: string
  /** Pre-stream 429 reroutes used before the successful narration model. */
  fallback_attempts?: Array<{ from: string; to: string }>
  /** OpenRouter host that streamed the winning narration, when reported. */
  provider?: string
  /** A second narration request was sent because the first gave no word in time. */
  hedged?: boolean
  /** Which of the two requests produced the prose; absent when not hedged. */
  hedge_winner?: 'primary' | 'hedge'
  /** Model used for the structured-metadata extraction pass. */
  metadata_model: string
  tokens_in: number
  tokens_out: number
  /** Non-mutating prose hygiene findings from the streamed response. */
  prose_hygiene_issues?: ProseHygieneIssue[]
  /** Wall-clock latency of the full narration generation, milliseconds. */
  latency_ms: number
  /** Time-to-first-token: ms from request start until the first streamed delta.
   *  The latency the player actually feels. 0 if no tokens streamed. */
  ttft_ms: number
  /** Per-call provider usage captured during this turn (narration + post-stream). */
  llm_calls?: LLMCallUsage[]
  /** Time spent waiting for a generation worker after the job was enqueued. */
  queue_wait_ms?: number
  /** Worker-side context/retrieval/prompt construction before the provider call. */
  context_latency_ms?: number
  /** Of the above: ms this turn waited for the query embedding, shared flight and
   *  cache hits included. Absent on rows written before this was measured. */
  embed_ms?: number
  /** Of the above: ms the whole RAG phase took, embedding included. */
  rag_ms?: number
  /** Split of `context_latency_ms` (+ `post_packet`) by prep step, so a slow turn
   *  says WHICH read or wait owned it instead of only how long it was. */
  prep_stages?: PrepStages
  /** First streamed token to the last one. */
  stream_ms?: number
  /** Last token to this log insert: event persistence and the post-stream
   *  extractions the composer waits on. */
  post_stream_ms?: number
  /** Full request-to-first-visible-token measurement, including dispatch and queue. */
  end_to_end_ttft_ms?: number
  created_at: Date
}
